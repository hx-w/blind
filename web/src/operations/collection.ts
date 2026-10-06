import type {CollectionLayout, SceneUpdate, ScreenStroke, ShareResponse} from '../api';
import {defineOperation, OperationHost, s, type OperationDescriptor, type Schema, type JsonSchema} from './core';
import type {AnnotationToolbarState} from '../annotations/editor';
import {viewSnapshotSchema, type ViewSnapshot} from './view';
import {annotationToolbarSchema, screenStrokeSchema} from './annotations';
import {sceneUpdateSchema} from './snapshot';

export interface CollectionState {
  activeSceneId: string;
  layout: CollectionLayout;
  mode: 'single' | 'split';
  maximized: boolean;
  scenes: Array<{id: string; title: string; ready: boolean; parked: boolean}>;
  strokes: ScreenStroke[];
  selection: string | null;
  canUndo: boolean;
  canRedo: boolean;
}
export interface CollectionCopyResult {status: 'copied' | 'manual'}
export interface CollectionUIState {observe: {open: boolean; category: string | null}; annotation: AnnotationToolbarState; view: ViewSnapshot | null}
export interface CollectionOperations {
  state(): CollectionState;
  uiState(): CollectionUIState;
  select(id: string): void;
  layout(sceneId: string | undefined, maximized: boolean): void;
  catalog(sceneId: string): Promise<OperationDescriptor[]>;
  execute(sceneId: string, operation: string, params: unknown): Promise<unknown>;
  snapshot(sceneId: string, prepare: boolean): Promise<SceneUpdate>;
  share(origin?: string): Promise<ShareResponse>;
  copy(kind: 'view' | 'image'): Promise<CollectionCopyResult>;
  observe(open?: boolean, category?: string | null): void;
  annotationOpen(): Promise<void>;
  annotationClose(): Promise<void>;
  annotationGet(): AnnotationToolbarState;
  annotationTool(mode: 'select' | 'point' | 'line' | 'screen'): Promise<void>;
  annotationColor(color: string): Promise<void>;
  annotationSelect(kind: 'surface' | 'screen', id: string): Promise<void>;
  annotationEdit(id: string, label?: string, color?: string): Promise<void>;
  annotationRemove(kind: 'surface' | 'screen', id: string): Promise<void>;
  annotationHistory(action: 'undo' | 'redo'): Promise<void>;
  annotationFinish(): Promise<void>;
  annotationCancel(): Promise<void>;
  annotationClosed(id: string, closed: boolean): Promise<void>;
  screenCreate(stroke: Omit<ScreenStroke, 'id'>): ScreenStroke;
  screenClear(): void;
}
const empty = s.object({});
const id = s.string({min: 1, max: 200});
const color = s.string({pattern: '^#[0-9a-fA-F]{6}$'});
const scene = s.object({sceneId: id});
export const collectionLayoutSchema: Schema<CollectionLayout> = s.object({
  width: s.number({min: 0, description: 'Combined image/composition width in CSS pixels'}),
  height: s.number({min: 0, description: 'Combined image/composition height in CSS pixels'}),
  columns: s.number({min: 1, integer: true}),
});
export const collectionStateSchema: Schema<CollectionState> = s.object({
  activeSceneId: id, layout: collectionLayoutSchema, mode: s.enum(['single', 'split']), maximized: s.boolean(),
  scenes: s.array(s.object({id, title: s.string(), ready: s.boolean(), parked: s.boolean()})),
  strokes: s.array(screenStrokeSchema, {max: 64}), selection: s.nullable(id), canUndo: s.boolean(), canRedo: s.boolean(),
});
export const collectionUISchema: Schema<CollectionUIState> = s.object({
  observe: s.object({open: s.boolean(), category: s.nullable(s.enum(['shading', 'light', 'projection', 'scene']))}),
  annotation: annotationToolbarSchema, view: s.nullable(viewSnapshotSchema),
});
export const collectionCopySchema: Schema<CollectionCopyResult> = s.object({status: s.enum(['copied', 'manual'])});
export const collectionShareSchema: Schema<ShareResponse> = s.object({
  viewer_url: s.string(), image_url: s.string(), origin: s.string(),
  owner_url: s.optional(s.string()), full_text: s.optional(s.string()), ttl_days: s.optional(s.number({integer: true, min: 1})),
  hosts: s.array(s.object({origin: s.string(), address: s.string(), scope: s.enum(['configured', 'current', 'private', 'global', 'local']),
    interface: s.string(), primary: s.boolean()})),
});
export const collectionCatalogSchema: JsonSchema = {
  type: 'array', items: {type: 'object', additionalProperties: false,
    required: ['name', 'description', 'inputSchema', 'outputSchema', 'permission', 'readOnly', 'available', 'allowed'],
    properties: {name: {type: 'string'}, description: {type: 'string'}, permission: {type: 'string'},
      inputSchema: {type: 'object', additionalProperties: true}, outputSchema: {type: 'object', additionalProperties: true},
      readOnly: {type: 'boolean'}, available: {type: 'boolean'}, allowed: {type: 'boolean'}}},
};
const read = {permission: 'collection.read', readOnly: true, result: collectionStateSchema.json};
const write = {permission: 'collection.write', result: collectionStateSchema.json};
const annotation = {permission: 'annotation.write', result: annotationToolbarSchema.json};
export const collectionState = defineOperation<{}, CollectionState>('collection:get', 'Read collection layout, active scene, parked state and global screen annotations without finishing drafts.', empty, read);
export const collectionUIGet = defineOperation<{}, CollectionUIState>('ui:get', 'Read collection observation controls, scoped annotation toolbar and active scene viewport state.', empty, {...read, result: collectionUISchema.json});
export const collectionSelect = defineOperation<{sceneId: string}, CollectionState>('collection:select', 'Select a scene by its stable collection scene ID.', scene, write);
export const collectionLayout = defineOperation<{sceneId?: string; maximized: boolean}, CollectionState>('collection:set-layout', 'Set maximized layout; false restores responsive split/tab layout.', s.object({sceneId: s.optional(id), maximized: s.boolean()}), write);
export const collectionCatalog = defineOperation<{sceneId: string}, OperationDescriptor[]>('collection:scene-catalog', 'Read the operation catalog for an exact child scene ID.', scene, {...read, result: collectionCatalogSchema});
export const collectionExecute = defineOperation('collection:scene-execute', 'Execute a child catalog operation against an exact scene ID, never the subsequently active scene.', s.object({sceneId: id, operation: s.string({min: 1, max: 120}), params: s.json()}), {...write, result: {description: 'Value described by the requested child operation outputSchema in collection:scene-catalog.', anyOf: [{type: 'object'}, {type: 'array'}, {type: 'string'}, {type: 'number'}, {type: 'boolean'}, {type: 'null'}]}});
export const collectionSnapshot = defineOperation<{sceneId: string}, SceneUpdate>('collection:scene-snapshot', 'Read a pure child snapshot without finishing annotation drafts.', scene, {...read, result: sceneUpdateSchema.json});
export const collectionPrepareSnapshot = defineOperation<{sceneId: string}, SceneUpdate>('collection:scene-prepare-snapshot', 'Finish child drafts and capture a shareable snapshot.', scene, {...write, result: sceneUpdateSchema.json});
export const collectionShare = defineOperation<{origin?: string}, ShareResponse>('share:create', 'Create combined collection view and PNG links using all live scene snapshots and global ink.', s.object({origin: s.optional(s.string({min: 1, max: 2048}))}), {permission: 'share.create', result: collectionShareSchema.json});
export const collectionCopy = defineOperation<{kind: 'view' | 'image'}, CollectionCopyResult>('share:copy', 'Create and copy a combined view/image link; requires browser user activation.', s.object({kind: s.enum(['view', 'image'] as const)}), {permission: 'share.create', result: collectionCopySchema.json});
export const collectionObserve = defineOperation<{open?: boolean; category?: 'shading' | 'light' | 'projection' | 'scene' | null}, CollectionUIState>('ui:observe', 'Set collection observe toolbar state.', s.object({open: s.optional(s.boolean()), category: s.optional(s.nullable(s.enum(['shading', 'light', 'projection', 'scene'] as const)))}), {permission: 'ui.write', result: collectionUISchema.json});
export const collectionAnnotationGet = defineOperation<{}, AnnotationToolbarState>('annotation:get', 'Read the active collection annotation toolbar state without finishing drafts.', empty, {...read, result: annotationToolbarSchema.json});
export const collectionAnnotationOpen = defineOperation<{}, AnnotationToolbarState>('annotation:open', 'Open annotation tools for the current scene and composition.', empty, annotation);
export const collectionAnnotationClose = defineOperation<{}, AnnotationToolbarState>('annotation:close', 'Close annotation tools and finish current drafts.', empty, annotation);
export const collectionAnnotationTool = defineOperation<{mode: 'select' | 'point' | 'line' | 'screen'}, AnnotationToolbarState>('annotation:set-tool', 'Select annotation tool; split screen ink belongs to the collection.', s.object({mode: s.enum(['select', 'point', 'line', 'screen'] as const)}), annotation);
export const collectionAnnotationColor = defineOperation<{color: string}, AnnotationToolbarState>('annotation:set-color', 'Set active annotation color, including the selected stroke.', s.object({color}), annotation);
export const collectionAnnotationSelect = defineOperation<{kind: 'surface' | 'screen'; id: string}, AnnotationToolbarState>('annotation:select', 'Select an annotation by stable ID.', s.object({kind: s.enum(['surface', 'screen'] as const), id}), annotation);
export const collectionAnnotationEdit = defineOperation<{id: string; label?: string; color?: string}, AnnotationToolbarState>('annotation:edit-screen', 'Edit a screen annotation by stable ID.', s.object({id, label: s.optional(s.string({max: 120})), color: s.optional(color)}), annotation);
export const collectionAnnotationRemove = defineOperation<{kind: 'surface' | 'screen'; id: string}, AnnotationToolbarState>('annotation:remove', 'Remove the selected scene or collection annotation by stable ID.', s.object({kind: s.enum(['surface', 'screen'] as const), id}), annotation);
export const collectionAnnotationUndo = defineOperation<{}, AnnotationToolbarState>('annotation:undo', 'Undo active scoped annotation history.', empty, annotation);
export const collectionAnnotationRedo = defineOperation<{}, AnnotationToolbarState>('annotation:redo', 'Redo active scoped annotation history.', empty, annotation);
export const collectionAnnotationFinish = defineOperation<{}, AnnotationToolbarState>('annotation:finish', 'Finish the current scoped annotation draft.', empty, annotation);
export const collectionAnnotationCancel = defineOperation<{}, AnnotationToolbarState>('annotation:cancel', 'Cancel the current scoped annotation draft.', empty, annotation);
export const collectionAnnotationClosed = defineOperation<{id: string; closed: boolean}, AnnotationToolbarState>('annotation:set-closed', 'Set closure of a child surface line.', s.object({id, closed: s.boolean()}), annotation);
export const collectionScreenCreate = defineOperation<Omit<ScreenStroke, 'id'>, ScreenStroke>('collection:screen-create', 'Create global collection screen ink; points normalized to viewport [0,1], aspect width/height.', s.object({label: s.optional(s.string({max: 120})), color, aspect: s.number({min: 0.1, max: 10}), points: s.array(s.tuple([s.number({min: 0, max: 1}), s.number({min: 0, max: 1})]), {min: 2, max: 512})}), {...annotation, result: screenStrokeSchema.json});
export const collectionScreenClear = defineOperation<{}, CollectionState>('collection:screen-clear', 'Clear global collection ink and retain undo history.', empty, {...annotation, result: collectionStateSchema.json});

export function registerCollectionOperations(host: OperationHost, app: CollectionOperations): void {
  host.register(collectionState, () => app.state());
  host.register(collectionUIGet, () => app.uiState());
  host.register(collectionSelect, p => {app.select(p.sceneId); return app.state();});
  host.register(collectionLayout, p => {app.layout(p.sceneId, p.maximized); return app.state();});
  host.register(collectionCatalog, p => app.catalog(p.sceneId));
  host.register(collectionExecute, p => app.execute(p.sceneId, p.operation, p.params));
  host.register(collectionSnapshot, p => app.snapshot(p.sceneId, false));
  host.register(collectionPrepareSnapshot, p => app.snapshot(p.sceneId, true));
  host.register(collectionShare, p => app.share(p.origin));
  host.register(collectionCopy, p => app.copy(p.kind));
  host.register(collectionObserve, p => {app.observe(p.open, p.category); return app.uiState();});
  host.register(collectionAnnotationGet, () => app.annotationGet());
  host.register(collectionAnnotationOpen, async () => {await app.annotationOpen(); return app.annotationGet();});
  host.register(collectionAnnotationClose, async () => {await app.annotationClose(); return app.annotationGet();});
  host.register(collectionAnnotationTool, async p => {await app.annotationTool(p.mode); return app.annotationGet();});
  host.register(collectionAnnotationColor, async p => {await app.annotationColor(p.color); return app.annotationGet();});
  host.register(collectionAnnotationSelect, async p => {await app.annotationSelect(p.kind, p.id); return app.annotationGet();});
  host.register(collectionAnnotationEdit, async p => {await app.annotationEdit(p.id, p.label, p.color); return app.annotationGet();});
  host.register(collectionAnnotationRemove, async p => {await app.annotationRemove(p.kind, p.id); return app.annotationGet();});
  host.register(collectionAnnotationUndo, async () => {await app.annotationHistory('undo'); return app.annotationGet();});
  host.register(collectionAnnotationRedo, async () => {await app.annotationHistory('redo'); return app.annotationGet();});
  host.register(collectionAnnotationFinish, async () => {await app.annotationFinish(); return app.annotationGet();});
  host.register(collectionAnnotationCancel, async () => {await app.annotationCancel(); return app.annotationGet();});
  host.register(collectionAnnotationClosed, async p => {await app.annotationClosed(p.id, p.closed); return app.annotationGet();});
  host.register(collectionScreenCreate, p => app.screenCreate(p));
  host.register(collectionScreenClear, () => {app.screenClear(); return app.state();});
}
