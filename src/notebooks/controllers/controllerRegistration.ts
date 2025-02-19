// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { Event, EventEmitter, NotebookDocument } from 'vscode';
import { isPythonNotebook } from '../../kernels/helpers';
import { IContributedKernelFinder } from '../../kernels/internalTypes';
import { IJupyterServerUriEntry, IJupyterServerUriStorage } from '../../kernels/jupyter/types';
import { IKernelFinder, IKernelProvider, isRemoteConnection, KernelConnectionMetadata } from '../../kernels/types';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { IPythonExtensionChecker } from '../../platform/api/types';
import {
    IVSCodeNotebook,
    ICommandManager,
    IWorkspaceService,
    IDocumentManager,
    IApplicationShell
} from '../../platform/common/application/types';
import { isCancellationError } from '../../platform/common/cancellation';
import { JupyterNotebookView, InteractiveWindowView } from '../../platform/common/constants';
import {
    IDisposableRegistry,
    IConfigurationService,
    IExtensionContext,
    IBrowserService,
    IFeaturesManager,
    IDisposable,
    IsWebExtension
} from '../../platform/common/types';
import { getNotebookMetadata } from '../../platform/common/utils';
import { noop } from '../../platform/common/utils/misc';
import { IInterpreterService } from '../../platform/interpreter/contracts';
import { IServiceContainer } from '../../platform/ioc/types';
import { traceError, traceInfoIfCI, traceVerbose, traceWarning } from '../../platform/logging';
import { sendTelemetryEvent, Telemetry } from '../../telemetry';
import { NotebookCellLanguageService } from '../languages/cellLanguageService';
import { sendKernelListTelemetry } from '../telemetry/kernelTelemetry';
import { ConnectionDisplayDataProvider } from './connectionDisplayData';
import { createActiveInterpreterController } from './helpers';
import { KernelFilterService } from './kernelFilter/kernelFilterService';
import {
    IControllerRegistration,
    InteractiveControllerIdSuffix,
    IVSCodeNotebookController,
    IVSCodeNotebookControllerUpdateEvent
} from './types';
import { VSCodeNotebookController } from './vscodeNotebookController';

/**
 * Keeps track of registered controllers and available KernelConnectionMetadatas.
 * Filtering is applied to the KernelConnectionMetadatas to limit the list of available controllers.
 */
@injectable()
export class ControllerRegistration implements IControllerRegistration, IExtensionSyncActivationService {
    // Promise to resolve when we have loaded our controllers
    private controllersPromise: Promise<void>;
    private registeredControllers = new Map<string, IVSCodeNotebookController>();
    private changeEmitter = new EventEmitter<IVSCodeNotebookControllerUpdateEvent>();
    private registeredMetadatas = new Map<string, KernelConnectionMetadata>();
    public get onDidChange(): Event<IVSCodeNotebookControllerUpdateEvent> {
        return this.changeEmitter.event;
    }
    public get registered(): IVSCodeNotebookController[] {
        return [...this.registeredControllers.values()];
    }
    public get all(): KernelConnectionMetadata[] {
        return this.metadatas;
    }
    private get metadatas(): KernelConnectionMetadata[] {
        return [...this.registeredMetadatas.values()];
    }
    public get onControllerSelected(): Event<{
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
    }> {
        return this.selectedEmitter.event;
    }
    public get onControllerSelectionChanged(): Event<{
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
        selected: boolean;
    }> {
        return this.selectionChangedEmitter.event;
    }
    private selectedEmitter = new EventEmitter<{ notebook: NotebookDocument; controller: IVSCodeNotebookController }>();
    private selectionChangedEmitter = new EventEmitter<{
        notebook: NotebookDocument;
        controller: IVSCodeNotebookController;
        selected: boolean;
    }>();
    private selectedControllers = new Map<string, IVSCodeNotebookController>();
    constructor(
        @inject(IVSCodeNotebook) private readonly notebook: IVSCodeNotebook,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IFeaturesManager) private readonly featuresManager: IFeaturesManager,
        @inject(KernelFilterService) private readonly kernelFilter: KernelFilterService,
        @inject(IWorkspaceService) private readonly workspace: IWorkspaceService,
        @inject(IPythonExtensionChecker) private readonly extensionChecker: IPythonExtensionChecker,
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(IJupyterServerUriStorage) private readonly serverUriStorage: IJupyterServerUriStorage,
        @inject(IKernelFinder) private readonly kernelFinder: IKernelFinder,
        @inject(IInterpreterService) private readonly interpreters: IInterpreterService,
        @inject(IsWebExtension) private readonly isWebExtension: boolean
    ) {}
    activate(): void {
        // Make sure to reload whenever we do something that changes state
        this.kernelFinder.onDidChangeKernels(() => this.loadControllers(), this, this.disposables);
        this.kernelFinder.registered.forEach((finder) => this.monitorDeletionOfConnections(finder));
        this.kernelFinder.onDidChangeRegistrations(
            (e) => e.added.forEach((finder) => this.monitorDeletionOfConnections(finder)),
            this,
            this.disposables
        );
        this.kernelFilter.onDidChange(this.onDidChangeFilter, this, this.disposables);
        this.serverUriStorage.onDidChangeConnectionType(this.onDidChangeFilter, this, this.disposables);
        this.serverUriStorage.onDidChangeUri(this.onDidChangeUri, this, this.disposables);
        this.serverUriStorage.onDidRemoveUris(this.onDidRemoveUris, this, this.disposables);

        this.onDidChange(
            ({ added }) => {
                added.forEach((controller) => {
                    controller.onNotebookControllerSelectionChanged(
                        (e) => {
                            if (
                                !e.selected &&
                                this.isFiltered(controller.connection) &&
                                this.canControllerBeDisposed(controller)
                            ) {
                                // This item was selected but is no longer allowed in the kernel list. Remove it
                                traceWarning(
                                    `Removing controller ${controller.id} for ${controller.connection.kind} from kernel list`
                                );
                                controller.dispose();
                            }
                        },
                        this,
                        this.disposables
                    );
                });
            },
            this,
            this.disposables
        );
        // Sign up for document either opening or closing
        this.notebook.onDidOpenNotebookDocument(this.onDidOpenNotebookDocument, this, this.disposables);
        // If the extension activates after installing Jupyter extension, then ensure we load controllers right now.
        this.notebook.notebookDocuments.forEach((notebook) => this.onDidOpenNotebookDocument(notebook).catch(noop));

        this.loadControllers();
        let previousKernelPickerType = this.featuresManager.features.kernelPickerType;
        this.featuresManager.onDidChangeFeatures(
            () => {
                if (previousKernelPickerType === this.featuresManager.features.kernelPickerType) {
                    return;
                }
                previousKernelPickerType = this.featuresManager.features.kernelPickerType;
                // With the old kernel picker some controllers can get disposed.
                // Hence to be on the safe side, when switching between the old and new kernel picker, reload the controllers.
                this.loadControllers();
            },
            this,
            this.disposables
        );
    }
    private loadControllers() {
        this.controllersPromise = this.loadControllersImpl();
        sendKernelListTelemetry(this.registered.map((v) => v.connection));

        traceInfoIfCI(`Providing notebook controllers with length ${this.registered.length}.`);
    }
    public get loaded() {
        return this.controllersPromise;
    }
    private async onDidOpenNotebookDocument(document: NotebookDocument) {
        // Restrict to only our notebook documents
        if (
            (document.notebookType !== JupyterNotebookView && document.notebookType !== InteractiveWindowView) ||
            !this.workspace.isTrusted
        ) {
            return;
        }

        if (isPythonNotebook(getNotebookMetadata(document)) && this.extensionChecker.isPythonExtensionInstalled) {
            const useNewKernelPicker = this.featuresManager.features.kernelPickerType === 'Insiders';
            // No need to always display active python env in VS Codes controller list.
            if (!useNewKernelPicker) {
                // If we know we're dealing with a Python notebook, load the active interpreter as a kernel asap.
                createActiveInterpreterController(JupyterNotebookView, document.uri, this.interpreters, this).catch(
                    noop
                );
            }
        }
    }

    private async loadControllersImpl() {
        if (this.extensionChecker.isPythonExtensionInstalled && !this.isWebExtension) {
            // This is temporary, when we create an MRU list in VS Code or the like, this should go away.
            // Debt https://github.com/microsoft/vscode-jupyter/issues/11988

            // First thing is to always create the controller for the active interpreter only if we don't have any remote connections.
            // This reduces flickering (changing controllers from one to another).
            const useNewKernelPicker = this.featuresManager.features.kernelPickerType === 'Insiders';
            if (this.serverUriStorage.isLocalLaunch && !useNewKernelPicker) {
                await createActiveInterpreterController(JupyterNotebookView, undefined, this.interpreters, this);
            }
        }
        const connections = this.kernelFinder.kernels;
        traceVerbose(`Found ${connections.length} cached controllers`);
        this.createNotebookControllers(connections);

        traceInfoIfCI(
            `Kernels found in kernel finder include ${connections
                .map((c) => `${c.kind}:${c.id}`)
                .join('\n')} \n and currently registered controllers include ${this.registered
                .map((c) => `${c.connection.kind}:${c.connection.id}`)
                .join('\n')}`
        );
        // Look for any controllers that we have disposed (no longer found when fetching)
        const disposedControllers = Array.from(this.registered).filter((controller) => {
            const connectionIsStillValid = connections.some((connection) => {
                return connection.id === controller.connection.id;
            });

            // Never remove remote kernels that don't exist.
            // Always leave them there for user to select, and if the connection is not available/not valid,
            // then notify the user and remove them.
            if (!connectionIsStillValid && controller.connection.kind === 'connectToLiveRemoteKernel') {
                return true;
            }

            // Don't dispose this controller if it's attached to a document.
            if (!this.canControllerBeDisposed(controller)) {
                return false;
            }
            if (!connectionIsStillValid) {
                traceVerbose(
                    `Controller ${controller.connection.kind}:'${controller.id}' for view = '${controller.viewType}' is no longer a valid`
                );
            }
            return !connectionIsStillValid;
        });
        // If we have any out of date connections, dispose of them
        disposedControllers.forEach((controller) => {
            traceWarning(
                `Disposing old controller ${controller.connection.kind}:'${controller.id}' for view = '${controller.viewType}'`
            );
            controller.dispose(); // This should remove it from the registered list
        });
    }
    private createNotebookControllers(kernelConnections: KernelConnectionMetadata[]) {
        if (kernelConnections.length === 0) {
            return;
        }
        traceVerbose(`Creating ${kernelConnections?.length} controllers`);

        try {
            this.batchAdd(kernelConnections, [JupyterNotebookView, InteractiveWindowView]);
        } catch (ex) {
            if (!isCancellationError(ex, true)) {
                // This can happen in the tests, and these get bubbled upto VSC and are logged as unhandled exceptions.
                // Hence swallow cancellation errors.
                throw ex;
            }
        }
    }
    private async monitorDeletionOfConnections(finder: IContributedKernelFinder) {
        const eventHandler = finder.onDidChangeKernels(
            ({ removed: connections }) => {
                const deletedConnections = new Set((connections || []).map((item) => item.id));
                this.registered
                    .filter((item) => deletedConnections.has(item.connection.id))
                    .forEach((controller) => {
                        traceWarning(
                            `Deleting controller ${controller.id} as it is associated with a connection that has been deleted ${controller.connection.kind}:${controller.id}`
                        );
                        controller.dispose();
                    });
            },
            this,
            this.disposables
        );
        this.kernelFinder.onDidChangeRegistrations((e) => {
            if (e.removed.includes(finder)) {
                eventHandler.dispose();
            }
        });
    }

    private onDidChangeUri() {
        // This logic only applies to old kernel picker which supports local vs remote, not both and not multiple remotes.
        if (this.featuresManager.features.kernelPickerType === 'Stable') {
            // Our list of metadata could be out of date. Remove old ones that don't match the uri
            if (this.serverUriStorage.currentServerId) {
                this.registered.forEach((c) => {
                    if (
                        isRemoteConnection(c.connection) &&
                        this.serverUriStorage.currentServerId !== c.connection.serverId
                    ) {
                        traceWarning(
                            `Deleting controller ${c.id} as it is associated with a connection that has been removed`
                        );
                        c.dispose();
                    }
                });
            }
        }
        // Update the list of controllers
        this.onDidChangeFilter();
    }

    private async onDidRemoveUris(uriEntries: IJupyterServerUriEntry[]) {
        // Remove any connections that are no longer available.
        uriEntries.forEach((item) => {
            this.registered.forEach((c) => {
                if (isRemoteConnection(c.connection) && c.connection.serverId === item.serverId) {
                    traceWarning(
                        `Deleting controller ${c.id} as it is associated with a connection that has been removed`
                    );
                    c.dispose();
                }
            });
        });

        // Update list of controllers
        this.onDidChangeFilter();
    }

    private onDidChangeFilter() {
        // Give our list of metadata should be up to date, just remove the filtered ones
        const metadatas = this.all.filter((item) => !this.isFiltered(item));

        // Try to re-create the missing controllers.
        metadatas.forEach((c) => this.addOrUpdate(c, [JupyterNotebookView, InteractiveWindowView]));

        // Go through all controllers that have been created and hide them.
        // Unless they are attached to an existing document.
        this.registered.forEach((item) => {
            // TODO: Don't hide controllers that are already associated with a notebook.
            // If we have a notebook opened and its using a kernel.
            // Else we end up killing the execution as well.
            if (this.isFiltered(item.connection) && this.canControllerBeDisposed(item)) {
                traceWarning(
                    `Deleting controller ${item.id} as it is associated with a connection that has been hidden`
                );
                item.dispose();
            }
        });
    }
    batchAdd(metadatas: KernelConnectionMetadata[], types: ('jupyter-notebook' | 'interactive')[]) {
        const addedList: IVSCodeNotebookController[] = [];
        metadatas.forEach((metadata) => {
            const { added } = this.addImpl(metadata, types, false);
            addedList.push(...added);
        });

        if (addedList.length) {
            this.changeEmitter.fire({ added: addedList, removed: [] });
        }
    }
    private _activeInterpreterControllerIds = new Set<string>();
    trackActiveInterpreterControllers(controllers: IVSCodeNotebookController[]) {
        controllers.forEach((controller) => this._activeInterpreterControllerIds.add(controller.id));
    }
    private canControllerBeDisposed(controller: IVSCodeNotebookController) {
        return (
            !this._activeInterpreterControllerIds.has(controller.id) &&
            !this.isControllerAttachedToADocument(controller)
        );
    }
    public getSelected(document: NotebookDocument): IVSCodeNotebookController | undefined {
        return this.selectedControllers.get(document.uri.toString());
    }
    addOrUpdate(
        metadata: KernelConnectionMetadata,
        types: ('jupyter-notebook' | 'interactive')[]
    ): IVSCodeNotebookController[] {
        const { added, existing } = this.addImpl(metadata, types, true);
        return added.concat(existing);
    }
    addImpl(
        metadata: KernelConnectionMetadata,
        types: ('jupyter-notebook' | 'interactive')[],
        triggerChangeEvent: boolean
    ): { added: IVSCodeNotebookController[]; existing: IVSCodeNotebookController[] } {
        const added: IVSCodeNotebookController[] = [];
        const existing: IVSCodeNotebookController[] = [];
        traceInfoIfCI(`Create Controller for ${metadata.kind} and id '${metadata.id}' for view ${types.join(', ')}`);
        try {
            // Create notebook selector
            types
                .map((t) => {
                    const id = this.getControllerId(metadata, t);
                    // Update our list kernel connections.
                    this.registeredMetadatas.set(metadata.id, metadata);

                    // Return the id and the metadata for use below
                    return [id, t];
                })
                .filter(([id]) => {
                    // See if we already created this controller or not
                    const controller = this.registeredControllers.get(id);
                    if (controller) {
                        // If we already have this controller, its possible the Python version information has changed.
                        // E.g. we had a cached kernlespec, and since then the user updated their version of python,
                        // Now we need to update the display name of the kernelspec.
                        controller.updateConnection(metadata);

                        // Add to results so that callers can find
                        existing.push(controller);

                        traceInfoIfCI(
                            `Found existing controller '${controller.id}', not creating a new one just updating it`
                        );
                        return false;
                    } else if (this.isFiltered(metadata)) {
                        // Filter out those in our kernel filter
                        traceInfoIfCI(`Existing controller '${id}' will be excluded as it is filtered`);
                        return false;
                    }
                    traceInfoIfCI(`Existing controller not found for '${id}', hence creating a new one`);
                    return true;
                })
                .forEach(([id, viewType]) => {
                    const controller = VSCodeNotebookController.create(
                        metadata,
                        id,
                        viewType,
                        this.notebook,
                        this.serviceContainer.get<ICommandManager>(ICommandManager),
                        this.serviceContainer.get<IKernelProvider>(IKernelProvider),
                        this.serviceContainer.get<IExtensionContext>(IExtensionContext),
                        this.disposables,
                        this.serviceContainer.get<NotebookCellLanguageService>(NotebookCellLanguageService),
                        this.workspace,
                        this.serviceContainer.get<IConfigurationService>(IConfigurationService),
                        this.serviceContainer.get<IDocumentManager>(IDocumentManager),
                        this.serviceContainer.get<IApplicationShell>(IApplicationShell),
                        this.serviceContainer.get<IBrowserService>(IBrowserService),
                        this.extensionChecker,
                        this.serviceContainer,
                        this.serviceContainer.get<ConnectionDisplayDataProvider>(ConnectionDisplayDataProvider),
                        this.featuresManager
                    );
                    // Hook up to if this NotebookController is selected or de-selected
                    const controllerDisposables: IDisposable[] = [];
                    controller.onDidDispose(
                        () => {
                            traceInfoIfCI(
                                `Deleting controller '${controller.id}' associated with view ${viewType} from registration as it was disposed`
                            );
                            this.registeredControllers.delete(controller.id);
                            controllerDisposables.forEach((d) => d.dispose());
                            // Note to self, registered metadatas survive disposal.
                            // This is so we don't have to recompute them when we switch back
                            // and forth between local and remote
                        },
                        this,
                        this.disposables
                    );
                    // We are disposing as documents are closed, but do this as well
                    this.disposables.push(controller);
                    this.registeredControllers.set(controller.id, controller);
                    added.push(controller);
                    controller.onNotebookControllerSelected(
                        (e) => {
                            traceInfoIfCI(`Controller ${e.controller?.id} selected`);
                            this.selectedControllers.set(e.notebook.uri.toString(), e.controller);
                            // Now notify out that we have updated a notebooks controller
                            this.selectedEmitter.fire(e);
                        },
                        this,
                        controllerDisposables
                    );
                    controller.onNotebookControllerSelectionChanged(
                        (e) => this.selectionChangedEmitter.fire({ ...e, controller }),
                        this,
                        controllerDisposables
                    );
                });
            if (triggerChangeEvent && added.length) {
                this.changeEmitter.fire({ added: added, removed: [] });
            }
        } catch (ex) {
            if (isCancellationError(ex, true)) {
                // This can happen in the tests, and these get bubbled upto VSC and are logged as unhandled exceptions.
                // Hence swallow cancellation errors.
                return { added, existing };
            }
            // We know that this fails when we have xeus kernels installed (untill that's resolved thats one instance when we can have duplicates).
            sendTelemetryEvent(
                Telemetry.FailedToCreateNotebookController,
                undefined,
                { kind: metadata.kind },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ex as any
            );
            traceError(`Failed to create notebook controller for ${metadata.id}`, ex);
        }
        return { added, existing };
    }
    get(
        metadata: KernelConnectionMetadata,
        notebookType: 'jupyter-notebook' | 'interactive'
    ): IVSCodeNotebookController | undefined {
        const id = this.getControllerId(metadata, notebookType);
        return this.registeredControllers.get(id);
    }

    public isFiltered(metadata: KernelConnectionMetadata): boolean {
        if (this.featuresManager.features.kernelPickerType === 'Insiders') {
            return false;
        }
        const userFiltered = this.kernelFilter.isKernelHidden(metadata);
        const urlFiltered = isRemoteConnection(metadata) && this.serverUriStorage.currentServerId !== metadata.serverId;

        return userFiltered || urlFiltered;
    }

    private getControllerId(
        metadata: KernelConnectionMetadata,
        viewType: typeof JupyterNotebookView | typeof InteractiveWindowView
    ) {
        return viewType === JupyterNotebookView ? metadata.id : `${metadata.id}${InteractiveControllerIdSuffix}`;
    }

    private isControllerAttachedToADocument(controller: IVSCodeNotebookController) {
        return this.notebook.notebookDocuments.some((doc) => controller.isAssociatedWithDocument(doc));
    }
}
