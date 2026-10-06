import {defineOperation, s, assertContentAccess, type OperationHost, type Infer} from './core';
import type {ComponentViewer, ContentSnapshot} from '../component-viewer';

const id = s.string({min: 1, max: 256, description: 'Stable content entity ID'});
const target = s.object({id});
export const contentAnchorSchema = s.object({source: s.string({min: 1}), target: s.string({min: 1}), offset: s.number({min: 0}), x: s.number(), y: s.number(), viewport: s.optional(s.tuple([s.number(), s.number()]))});
const color = s.string({pattern: '^#[0-9a-fA-F]{6}$'});
const mark = s.object({id: s.string({min: 1}), label: s.string(), color, kind: s.enum(['point', 'line']), anchors: s.array(contentAnchorSchema, {min: 1, max: 2})});
const presentation = s.enum(['spatial', 'focus', 'fullscreen']);
export const contentSnapshotSchema = s.object({id, native: s.boolean(), ready: s.boolean(), presentation, menu: s.boolean(), unavailable: s.optional(s.string()),
  state: s.optional(s.object({presentation: s.optional(presentation), reading: s.optional(contentAnchorSchema), selection: s.optional(s.boolean()), zoom: s.optional(s.number({min: 0})), expanded: s.optional(s.array(s.string())), layer: s.optional(s.string()), marks: s.optional(s.array(mark))})),
  capabilities: s.object({reading: s.boolean(), selection: s.boolean(), zoom: s.boolean(), fit: s.boolean(), json: s.boolean(), annotations: s.boolean()}),
  targets: s.array(s.object({id: s.string(), label: s.string(), anchor: contentAnchorSchema})), layers: s.array(s.object({id: s.string(), label: s.string()})),
  targetRange: s.optional(s.object({prefix: s.string({description: 'Prefix for zero-based sequential source targets, e.g. line:'}), count: s.number({min: 0, integer: true})})),
  branches: s.array(s.object({path: s.string(), expanded: s.boolean(), loaded: s.number({min: 0, integer: true}), total: s.number({min: 0, integer: true})})),
  annotation: s.optional(s.object({active: s.boolean(), kind: s.enum(['point', 'line']), selected: s.nullable(s.string()), label: s.string(), color: s.string(), canUndo: s.boolean(), canRedo: s.boolean()})),
});
const reading = s.object({id, anchor: contentAnchorSchema});
const scroll = s.object({id, x: s.number({description: 'Native content CSS pixels, independent of world zoom'}), y: s.number(), relative: s.optional(s.boolean())});
const selection = s.object({id, enabled: s.boolean()});
const jsonExpand = s.object({id, path: s.string({description: 'JSON Pointer; empty string addresses root'}), expanded: s.boolean()});
const jsonPage = s.object({id, path: s.string({description: 'JSON Pointer of an already materialized branch'})});
const zoom = s.object({id, factor: s.number({min: Number.MIN_VALUE})});
const layer = s.object({id, layer: s.string()});
const menu = s.object({id, open: s.boolean()});
const present = s.object({id, presentation});
const annotationOpen = s.object({id, open: s.boolean()});
const annotationTool = s.object({id, kind: s.enum(['point', 'line']), label: s.optional(s.string({max: 120})), color: s.optional(color)});
const annotationCreate = s.object({id, kind: s.enum(['point', 'line']), label: s.string({max: 120}), color, anchors: s.array(contentAnchorSchema, {min: 1, max: 2})});
const annotationTarget = s.object({id, markId: s.string({min: 1})});
const annotationEdit = s.object({id, markId: s.string({min: 1}), label: s.optional(s.string({max: 120})), color: s.optional(color)});
const write = {permission: 'content.write', result: contentSnapshotSchema.json};
const annotation = {permission: 'annotation.write', result: contentSnapshotSchema.json};
export const contentOperations = {
  get: defineOperation<Infer<typeof target>, ContentSnapshot>('content:get', 'Read native capabilities, source-scoped reading anchors, JSON branches, layers and annotation state. Opaque plugin state is never exposed.', target, {permission: 'content.read', readOnly: true, result: contentSnapshotSchema.json}),
  reading: defineOperation<Infer<typeof reading>, ContentSnapshot>('content:set-reading', 'Restore a validated source-scoped native reading anchor.', reading, write),
  scroll: defineOperation<Infer<typeof scroll>, ContentSnapshot>('content:scroll', 'Set or offset native scroll position in unscaled content CSS pixels.', scroll, write),
  selection: defineOperation<Infer<typeof selection>, ContentSnapshot>('content:set-selection', 'Enable native text selection or return to reading gestures.', selection, write),
  jsonExpand: defineOperation<Infer<typeof jsonExpand>, ContentSnapshot>('content:json-expand', 'Set disclosure of a JSON Pointer branch without editing source JSON.', jsonExpand, write),
  jsonPage: defineOperation<Infer<typeof jsonPage>, ContentSnapshot>('content:json-page', 'Materialize the next real page of an existing JSON branch.', jsonPage, write),
  zoom: defineOperation<Infer<typeof zoom>, ContentSnapshot>('content:zoom', 'Zoom a native image or diagram around its current reading anchor.', zoom, write),
  fit: defineOperation<Infer<typeof target>, ContentSnapshot>('content:fit', 'Fit the real native image or diagram to its content viewport.', target, write),
  layer: defineOperation<Infer<typeof layer>, ContentSnapshot>('content:set-layer', 'Select a diagram group/layer or semantic depth view using its catalogued ID.', layer, write),
  menu: defineOperation<Infer<typeof menu>, ContentSnapshot>('content:menu', 'Open or close the semantic content action menu.', menu, {permission: 'ui.write', result: contentSnapshotSchema.json}),
  present: defineOperation<Infer<typeof present>, ContentSnapshot>('content:present', 'Present the same content DOM in world/panel, focused or fullscreen mode.', present, {permission: 'ui.write', result: contentSnapshotSchema.json}),
  focus: defineOperation<Infer<typeof target>, ContentSnapshot>('content:focus', 'Frame world content or focus a fixed panel without changing its reading state.', target, {permission: 'ui.write', result: contentSnapshotSchema.json}),
  annotationOpen: defineOperation<Infer<typeof annotationOpen>, ContentSnapshot>('content:annotation-open', 'Open or close source-native annotation tools, independent of screen ink.', annotationOpen, annotation),
  annotationTool: defineOperation<Infer<typeof annotationTool>, ContentSnapshot>('content:annotation-tool', 'Set native annotation point/line tool, name and color.', annotationTool, annotation),
  annotationCreate: defineOperation<Infer<typeof annotationCreate>, ContentSnapshot>('content:annotation-create', 'Create a real source-anchored point or line mark. One point anchor or two same-source line anchors are required.', annotationCreate, annotation),
  annotationSelect: defineOperation<Infer<typeof annotationTarget>, ContentSnapshot>('content:annotation-select', 'Select a native mark and restore its reading anchor when available.', annotationTarget, annotation),
  annotationEdit: defineOperation<Infer<typeof annotationEdit>, ContentSnapshot>('content:annotation-edit', 'Edit native annotation name or color, preserving source anchors.', annotationEdit, annotation),
  annotationRemove: defineOperation<Infer<typeof annotationTarget>, ContentSnapshot>('content:annotation-remove', 'Remove one existing native annotation.', annotationTarget, annotation),
  annotationClear: defineOperation<Infer<typeof target>, ContentSnapshot>('content:annotation-clear', 'Clear native annotations with undo support.', target, annotation),
  annotationUndo: defineOperation<Infer<typeof target>, ContentSnapshot>('content:annotation-undo', 'Undo the latest native annotation mutation.', target, annotation),
  annotationRedo: defineOperation<Infer<typeof target>, ContentSnapshot>('content:annotation-redo', 'Redo an undone native annotation mutation.', target, annotation),
  annotationCancel: defineOperation<Infer<typeof target>, ContentSnapshot>('content:annotation-cancel', 'Cancel a pending native mark without changing saved annotations.', target, annotation),
};

export function registerContentOperations(host: OperationHost, components: ComponentViewer): () => void {
  components.bindOperations(host);
  const disposers = [
    host.register(contentOperations.get, ({id}, context) => { assertContentAccess(context, id); return components.getContent(id); }),
    host.register(contentOperations.reading, async ({id, anchor}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.setReading(anchor); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.scroll, async ({id, x, y, relative}, context) => { assertContentAccess(context, id); await components.contentRuntime(id).scrollContent(x, y, relative); return components.getContent(id); }),
    host.register(contentOperations.selection, ({id, enabled}, context) => { assertContentAccess(context, id); components.contentRuntime(id).setSelection(enabled); return components.getContent(id); }),
    host.register(contentOperations.jsonExpand, async ({id, path, expanded}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.jsonExpand(path, expanded); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.jsonPage, async ({id, path}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.jsonPage(path); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.zoom, async ({id, factor}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.zoom(factor); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.fit, async ({id}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.fit(); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.layer, async ({id, layer}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.setLayer(layer); await runtime.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.menu, ({id, open}, context) => { assertContentAccess(context, id); components.contentRuntime(id).showMenu(open); return components.getContent(id); }),
    host.register(contentOperations.present, async ({id, presentation}, context) => { assertContentAccess(context, id); components.presentEntity(id, presentation); await components.whenSettled(); return components.getContent(id); }),
    host.register(contentOperations.focus, async ({id}, context) => { assertContentAccess(context, id); await components.contentRuntime(id).focus(); return components.getContent(id); }),
    host.register(contentOperations.annotationOpen, ({id, open}, context) => { assertContentAccess(context, id); const runtime = components.contentRuntime(id); runtime.annotationEditor(); if (open) runtime.annotate(); else runtime.closeAnnotation(); return components.getContent(id); }),
    host.register(contentOperations.annotationTool, ({id, kind, label, color}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().setTool(kind, label, color); return components.getContent(id); }),
    host.register(contentOperations.annotationCreate, ({id, ...mark}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().create(mark); return components.getContent(id); }),
    host.register(contentOperations.annotationSelect, ({id, markId}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().select(markId); return components.getContent(id); }),
    host.register(contentOperations.annotationEdit, ({id, markId, ...changes}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().edit(markId, changes); return components.getContent(id); }),
    host.register(contentOperations.annotationRemove, ({id, markId}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().remove(markId); return components.getContent(id); }),
    host.register(contentOperations.annotationClear, ({id}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().clear(); return components.getContent(id); }),
    host.register(contentOperations.annotationUndo, ({id}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().undo(); return components.getContent(id); }),
    host.register(contentOperations.annotationRedo, ({id}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().redo(); return components.getContent(id); }),
    host.register(contentOperations.annotationCancel, ({id}, context) => { assertContentAccess(context, id); components.contentRuntime(id).annotationEditor().cancel(); return components.getContent(id); }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
