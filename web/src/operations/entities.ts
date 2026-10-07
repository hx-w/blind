import {defineOperation, s, type OperationHost, type Infer} from './core';
import type {ComponentViewer, EntitySnapshot, SceneListState} from '../component-viewer';
import {viewSnapshotSchema} from './view';
import type {ViewMutation} from './view';

const id = s.string({min: 1, max: 256, description: 'Stable scene entity ID'});
const target = s.object({id});
const empty = s.object({});
const sceneListInput = s.object({open: s.optional(s.boolean()), tab: s.optional(s.enum(['elements', 'info']))});
const sceneListOutput = s.object({open: s.boolean(), tab: s.enum(['elements', 'info'])});
const vec3 = s.tuple([s.number(), s.number(), s.number()]);
const presentations = s.array(s.enum(['spatial', 'focus', 'fullscreen']));
const panelHeight = s.nullable(s.number({exclusiveMin: 0, description: 'Preferred outer fixed-pane height in CSS pixels; null restores automatic layout'}));
export const entitySnapshotSchema = s.object({
  id, component: s.string(), label: s.string(), group: s.nullable(s.string()), placement: s.enum(['world', 'panel']),
  visible: s.boolean(), opacity: s.number({min: 0, max: 1}), selected: s.boolean(), position: s.nullable(vec3),
  size: s.nullable(s.tuple([s.number(), s.number()])), panel_height: panelHeight,
  capabilities: s.object({presentations, movable: s.boolean(), resizable: s.boolean(),
    input: s.object({spatial: s.enum(['scene', 'content']), focus: s.enum(['scene', 'content']), fullscreen: s.enum(['scene', 'content'])}),
    geometry: s.optional(s.enum(['mesh', 'points'])), host_space: s.optional(s.enum(['planar', 'spatial'])), operations: s.optional(s.array(s.string()))}),
  color: s.optional(s.string()), quality: s.optional(s.enum(['raw', 'lod'])), loading: s.optional(s.boolean()), unavailable: s.optional(s.string()),
  loadState: s.optional(s.enum(['unloaded', 'loading', 'ready', 'error'])),
});
const label = s.object({id, label: s.string({min: 1, max: 120})});
const style = s.object({id, visible: s.optional(s.boolean()), opacity: s.optional(s.number({min: 0, max: 1})), color: s.optional(s.string({pattern: '^#[0-9a-fA-F]{6}$'}))});
const isolate = s.object({id, fit: s.optional(s.boolean())});
const quality = s.object({id, quality: s.enum(['raw', 'lod'])});
const placement = s.object({id, placement: s.enum(['world', 'panel'])});
const height = s.object({id, height: panelHeight});
const show = s.object({ids: s.array(id, {max: 256, unique: true}), opacity: s.optional(s.number({min: 0, max: 1})), fit: s.optional(s.boolean())});
const focus = s.object({ids: s.array(id, {min: 1, max: 256, unique: true}), animate: s.optional(s.boolean())});
const entityResult = {permission: 'scene.write', result: entitySnapshotSchema.json};
const listResult = {permission: 'scene.write', result: s.array(entitySnapshotSchema).json};
export const entityOperations = {
  list: defineOperation<Infer<typeof empty>, EntitySnapshot[]>('entity:list', 'List safe entity identities, style and capabilities; source addresses and opaque state are never exposed.', empty, {permission: 'scene.read', readOnly: true, result: s.array(entitySnapshotSchema).json}),
  get: defineOperation<Infer<typeof target>, EntitySnapshot>('entity:get', 'Read one entity without changing selection.', target, {permission: 'scene.read', readOnly: true, result: entitySnapshotSchema.json}),
  select: defineOperation<Infer<typeof target>, EntitySnapshot>('entity:select', 'Select a scene entity by its stable ID.', target, entityResult),
  label: defineOperation<Infer<typeof label>, EntitySnapshot>('entity:set-label', 'Set the host-owned entity display name; never edits the source.', label, entityResult),
  style: defineOperation<Infer<typeof style>, EntitySnapshot>('entity:set-style', 'Set visibility, opacity and optional geometric color after validating the complete request.', style, entityResult),
  isolate: defineOperation<Infer<typeof isolate>, EntitySnapshot[]>('entity:isolate', 'Show only one entity, optionally fitting its world bounds. Fixed panels never affect fit.', isolate, listResult),
  quality: defineOperation<Infer<typeof quality>, EntitySnapshot>('entity:set-quality', 'Load real raw or LOD geometry. Surface-marked meshes cannot switch to LOD.', quality, entityResult),
  placement: defineOperation<Infer<typeof placement>, EntitySnapshot>('entity:set-placement', 'Move the same content DOM between world and fixed panel hosts; geometry cannot be pinned.', placement, entityResult),
  panelHeight: defineOperation<Infer<typeof height>, EntitySnapshot>('entity:set-panel-height', 'Set the preferred outer fixed-pane height in CSS pixels, or null for automatic layout. Retains the request across viewport clamps and presentation changes without changing world size. Geometry cannot have a pane height. Resolves after layout and native reading settle.', height, entityResult),
  show: defineOperation<Infer<typeof show>, EntitySnapshot[]>('scene:show', 'Atomically set scene visibility to the supplied IDs, with optional opacity for shown entities and world-only fit. Unknown or duplicate IDs never partially apply.', show, listResult),
  focus: defineOperation<Infer<typeof focus>, ViewMutation>('entity:focus', 'Frame visible world bounds of selected IDs without changing visibility. A single visible fixed panel receives native focus instead of moving the camera. Resolves when camera framing commits or is interrupted.', focus, {permission: 'scene.write', result: s.object({status: s.enum(['committed', 'interrupted']), view: viewSnapshotSchema}).json}),
  sceneList: defineOperation<Infer<typeof sceneListInput>, SceneListState>('ui:scene-list', 'Set scene list visibility or the elements/info tab through semantic host UI state.', sceneListInput, {permission: 'ui.write', result: sceneListOutput.json}),
  sceneListGet: defineOperation<Infer<typeof empty>, SceneListState>('ui:scene-list-get', 'Read scene list visibility and active tab without finishing an active name edit.', empty, {permission: 'scene.read', readOnly: true, result: sceneListOutput.json}),
};
export function registerEntityOperations(host: OperationHost, components: ComponentViewer): () => void {
  components.bindOperations(host);
  const disposers = [
    host.register(entityOperations.list, () => components.listEntities()),
    host.register(entityOperations.get, ({id}) => components.getEntity(id)),
    host.register(entityOperations.select, ({id}) => components.selectEntity(id)),
    host.register(entityOperations.label, ({id, label}) => components.labelEntity(id, label)),
    host.register(entityOperations.style, ({id, ...style}) => components.styleEntity(id, style)),
    host.register(entityOperations.isolate, ({id, fit}) => components.isolateEntity(id, fit)),
    host.register(entityOperations.quality, ({id, quality}) => components.qualityEntity(id, quality)),
    host.register(entityOperations.placement, async ({id, placement}) => { components.placementEntity(id, placement); await components.whenSettled(); return components.getEntity(id); }),
    host.register(entityOperations.panelHeight, ({id, height}) => components.panelHeightEntity(id, height)),
    host.register(entityOperations.show, ({ids, opacity, fit}) => components.showEntities(ids, opacity, fit)),
    host.register(entityOperations.focus, ({ids, animate}) => components.focusEntities(ids, animate)),
    host.register(entityOperations.sceneList, params => components.setSceneList(params)),
    host.register(entityOperations.sceneListGet, () => components.sceneListState),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
