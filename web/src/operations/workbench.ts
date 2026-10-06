import {defineOperation, s, type Infer, type OperationHost} from './core';
import type {SceneUpdate, ShareResponse} from '../api';
import type {AnnotationToolbarState} from '../annotations/editor';
import {viewSnapshotSchema} from './view';
import {annotationToolbarSchema} from './annotations';
import {sceneUpdateSchema} from './snapshot';

export const workbenchStateSchema = s.object({observe: s.object({open: s.boolean(), category: s.nullable(s.string())}), annotation: annotationToolbarSchema, view: viewSnapshotSchema});
export type WorkbenchState = Infer<typeof workbenchStateSchema>;
export interface ResourceInfo {id: string; label: string; byteSize: number | null; available: boolean}
export interface ResourceLink {id: string; url: string; filename: string}
export interface PublicShare {viewer_url: string; image_url: string; origin: string; ttl_days?: number}
export interface ShareSheetState {open: boolean; mode: 'main' | 'hosts' | 'manual'; origin: string | null}
export interface ClipboardOutcome {status: 'copied' | 'manual'; value: string}
const shareSheetSchema = s.object({open: s.boolean(), mode: s.enum(['main', 'hosts', 'manual']), origin: s.nullable(s.string())});
const empty = s.object({});
const observeParams = s.object({open: s.optional(s.boolean()), category: s.optional(s.nullable(s.enum(['shading', 'light', 'projection', 'scene'] as const)))});
const scopeParams = s.object({scope: s.enum(['scene', 'collection'] as const)});
const activateParams = s.object({active: s.boolean()});
const shareParams = s.object({origin: s.optional(s.string({min: 1, max: 2048}))});
const resourceParams = s.object({resourceId: s.string({min: 1, max: 128})});
const shareSheetParams = s.object({open: s.boolean(), mode: s.optional(s.enum(['main', 'hosts', 'manual']))});
const copyParams = s.object({kind: s.enum(['view', 'image', 'full']), fresh: s.optional(s.boolean())});
const annotationOpenParams = s.object({target: s.optional(s.enum(['content', 'screen']))});
export const workbenchOperations = {
  get: defineOperation<Infer<typeof empty>, WorkbenchState>('ui:get', 'Read observation controls, annotation toolbar state and the current view without touching content or drafts.', empty, {permission: 'scene.read', readOnly: true, result: workbenchStateSchema.json}),
  observe: defineOperation<Infer<typeof observeParams>, WorkbenchState>('ui:observe', 'Set observation toolbar visibility and category. Omitted fields are preserved; category null closes the detail.', observeParams, {permission: 'ui.write', result: workbenchStateSchema.json}),
  info: defineOperation<Infer<typeof empty>, null>('ui:info', 'Open the host scene information tab.', empty, {permission: 'ui.write', result: {type: 'null'}}),
  annotationOpen: defineOperation<Infer<typeof annotationOpenParams>, AnnotationToolbarState>('annotation:open', 'Open annotation tools for the selected native content by default, or explicitly choose screen ink. Content and view-scoped screen marks remain separate.', annotationOpenParams, {permission: 'annotation.write', result: annotationToolbarSchema.json}),
  annotationClose: defineOperation<Infer<typeof empty>, AnnotationToolbarState>('annotation:close', 'Finish annotation tools and restore normal navigation.', empty, {permission: 'annotation.write', result: annotationToolbarSchema.json}),
  screenScope: defineOperation<Infer<typeof scopeParams>, null>('annotation:screen-scope', 'Choose whether embedded screen markup belongs to its scene or the collection composition.', scopeParams, {permission: 'host', result: {type: 'null'}}),
  activate: defineOperation<Infer<typeof activateParams>, {active: boolean}>('scene:activate', 'Activate or suspend an embedded scene without disposing its content, history or view.', activateParams, {permission: 'host', result: {type: 'object', properties: {active: {type: 'boolean'}}, required: ['active']}}),
  snapshot: defineOperation<Infer<typeof empty>, SceneUpdate>('scene:snapshot', 'Read the current shareable scene state. This query does not finish active gestures or drafts.', empty, {permission: 'host', readOnly: true, result: sceneUpdateSchema.json}),
  prepareSnapshot: defineOperation<Infer<typeof empty>, SceneUpdate>('scene:prepare-snapshot', 'Finish shareable drafts and capture a scene snapshot for collection sharing.', empty, {permission: 'host', result: sceneUpdateSchema.json}),
  share: defineOperation<Infer<typeof shareParams>, PublicShare | ShareResponse>('share:create', 'Finish drafts and create immutable viewer and PNG links. Creates external state; do not retry automatically after timeout. Owner information is returned only to the trusted host.', shareParams, {permission: 'share.create', result: {type: 'object', required: ['viewer_url', 'image_url', 'origin'], properties: {viewer_url: {type: 'string', format: 'uri'}, image_url: {type: 'string', format: 'uri'}, origin: {type: 'string'}, ttl_days: {type: 'integer'}, hosts: {type: 'array', description: 'Trusted host only'}, owner_url: {type: 'string', description: 'Trusted owner host only'}, full_text: {type: 'string', description: 'Trusted owner host only'}}, additionalProperties: false}}),
  resources: defineOperation<Infer<typeof empty>, ResourceInfo[]>('resource:list', 'List attachment identifiers and public metadata, without source addresses or bytes.', empty, {permission: 'scene.read', readOnly: true, result: s.array(s.object({id:s.string(),label:s.string(),byteSize:s.nullable(s.number({integer:true,min:0})),available:s.boolean()})).json}),
  resource: defineOperation<Infer<typeof resourceParams>, ResourceLink>('resource:resolve', 'Resolve an authorized attachment for the caller to open or download. Requires explicit resource.open grant; performs no browser navigation.', resourceParams, {permission: 'resource.open', readOnly: true, result: {type: 'object', required: ['id', 'url', 'filename'], properties: {id: {type: 'string'}, url: {type: 'string', format: 'uri'}, filename: {type: 'string'}}, additionalProperties: false}}),
  shareSheet: defineOperation<Infer<typeof shareSheetParams>, ShareSheetState>('ui:share-sheet', 'Open or close the share sheet and select its main, host-picker or manual-copy view. Opening creates a snapshot when needed.', shareSheetParams, {permission: 'share.create', result: shareSheetSchema.json}),
  copy: defineOperation<Infer<typeof copyParams>, ClipboardOutcome>('share:copy', 'Copy the current or a fresh share link using browser user activation; when clipboard permission is denied, expose the same value in manual-copy UI. Without user activation use share:create instead.', copyParams, {permission: 'host', result: s.object({status: s.enum(['copied', 'manual']), value: s.string()}).json}),
};
export interface WorkbenchServices {
  state(): WorkbenchState;
  whenSettled(): Promise<void>;
  observe(params: {open?: boolean; category?: string | null}): void;
  info(): void;
  annotationOpen(target?: 'content' | 'screen'): Promise<void>;
  annotationClose(): void;
  annotationScope(scope: 'scene' | 'collection'): void;
  activate(active: boolean): Promise<void>;
  snapshot(): SceneUpdate;
  prepareSnapshot(): SceneUpdate;
  share(origin?: string): Promise<ShareResponse>;
  resources(): ResourceInfo[];
  resource(id: string): ResourceLink;
  shareSheet(params: {open: boolean; mode?: 'main' | 'hosts' | 'manual'}): Promise<ShareSheetState>;
  copy(params: {kind: 'view' | 'image' | 'full'; fresh?: boolean}): Promise<ClipboardOutcome>;
}
export function registerWorkbenchOperations(host: OperationHost, services: WorkbenchServices): void {
  host.register(workbenchOperations.get, async () => {await services.whenSettled(); return services.state();});
  host.register(workbenchOperations.observe, params => {services.observe(params); return services.state();});
  host.register(workbenchOperations.info, () => {services.info(); host.notify('ui', services.state()); return null;});
  host.register(workbenchOperations.annotationOpen, async ({target}) => {await services.annotationOpen(target); return services.state().annotation;});
  host.register(workbenchOperations.annotationClose, () => {services.annotationClose(); return services.state().annotation;});
  host.register(workbenchOperations.screenScope, ({scope}) => {services.annotationScope(scope); return null;});
  host.register(workbenchOperations.activate, async ({active}) => {await services.activate(active); return {active};});
  host.register(workbenchOperations.snapshot, () => services.snapshot());
  host.register(workbenchOperations.prepareSnapshot, () => services.prepareSnapshot());
  host.register(workbenchOperations.share, async ({origin}, context): Promise<PublicShare | ShareResponse> => {
    const links = await services.share(origin);
    if (context.actor.kind !== 'component') return links;
    return {viewer_url: links.viewer_url, image_url: links.image_url, origin: links.origin, ...(links.ttl_days === undefined ? {} : {ttl_days: links.ttl_days})};
  });
  host.register(workbenchOperations.resources, () => services.resources());
  host.register(workbenchOperations.resource, ({resourceId}) => services.resource(resourceId));
  host.register(workbenchOperations.shareSheet, async params => {const state = await services.shareSheet(params); host.notify('ui', services.state()); return state;});
  host.register(workbenchOperations.copy, params => services.copy(params));
}
