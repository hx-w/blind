import type { SceneViewport } from '../viewport/types';
import { defineOperation, OperationError, s, type Infer, type Operation, type OperationHost, type Schema } from './core';

const coordinates2 = s.tuple([s.number(), s.number()]);
const coordinates3 = s.tuple([s.number(), s.number(), s.number()]);
const positive = s.number({min: Number.MIN_VALUE});
const light = s.object({azimuth: s.number({min: -180, max: 180}), elevation: s.number({min: 0, max: 90}), intensity: s.number({min: 0, max: 2})});
const background = s.enum(['dark', 'light']);
const projection = s.enum(['perspective', 'orthographic']);
const shading = s.enum(['smooth', 'flat', 'wire']);
const renderMode = s.enum(['matte', 'raking', 'normals']);
const camera = s.object({position: coordinates3, target: coordinates3, up: coordinates3, fov: s.number({min: 10, max: 100}), zoom: s.number({min: .01, max: 100}), orthographic_height: s.number({min: .0001, max: 1_000_000})});
const boardCamera = s.object({center: coordinates2, scale: positive});
const frame = s.object({width: s.number({min: 0}), height: s.number({min: 0})});
const viewState = s.union([
  s.object({kind: s.literal('board'), camera: boardCamera, settings: s.object({background}), frame}),
  s.object({kind: s.literal('spatial'), camera, settings: s.object({background, projection, axes: s.boolean(), shading, render_mode: renderMode, light}), frame}),
]);
export const viewSnapshotSchema = viewState;
export type ViewSnapshot = Infer<typeof viewState>;
export interface ViewMutation {status: 'committed' | 'interrupted'; view: ViewSnapshot}
const resultSchema = s.object({status: s.enum(['committed', 'interrupted']), view: viewState}).json;
function mutation<P>(name: string, description: string, params: Schema<P>): Operation<P, ViewMutation> {
  return defineOperation<P, ViewMutation>(name, description, params, {permission: 'scene.write', result: resultSchema});
}

export const viewOperations = {
  get: defineOperation<{}, ViewSnapshot>('view:get', 'Query active viewport camera, framing in CSS pixels, and supported display settings; does not finish drafts.', s.object({}), {permission: 'scene.read', readOnly: true, result: viewState.json}),
  set: mutation('view:set', 'Set the active camera exactly. Board center is in scene units and scale is CSS pixels per scene unit; spatial vectors are world-space.', s.union([
    s.object({kind: s.literal('board'), center: coordinates2, scale: positive}),
    s.object({kind: s.literal('spatial'), camera}),
  ])),
  pan: mutation('view:pan', 'Move the scene image by delta [right,down] in CSS pixels without changing content zoom.', s.object({delta: coordinates2})),
  zoom: mutation('view:zoom', 'Multiply viewport magnification by a positive factor, keeping the optional client-coordinate anchor fixed. Never changes native content layout.', s.object({factor: positive, anchor: s.optional(coordinates2)})),
  rotate: mutation('view:rotate', 'Rotate the spatial camera around its current pivot, by radians about a nonzero world-space axis. Board does not support rotation.', s.object({axis: coordinates3, angle: s.number()})),
  canonical: mutation('view:canonical', 'Frame a spatial scene looking from the named world axis toward its visible bounds. Unsupported on board.', s.object({direction: s.enum(['px', 'nx', 'py', 'ny', 'pz', 'nz'])})),
  fit: mutation('view:fit', 'Fit all visible, positive-opacity world entities, excluding fixed panels. Empty scenes keep the current camera. Resolves with the committed final camera or a structured interruption.', s.object({animate: s.optional(s.boolean())})),
  settings: mutation('view:settings', 'Set supported display fields atomically. Board supports background only and rejects spatial-only fields.', s.object({background: s.optional(background), projection: s.optional(projection), axes: s.optional(s.boolean()), shading: s.optional(shading), render_mode: s.optional(renderMode), light: s.optional(light)})),
} as const;

export function readView(viewport: SceneViewport): ViewSnapshot {
  const state = viewport.currentState;
  if (viewport.kind === 'board') return {kind: 'board', camera: state.viewport.board!, settings: {background: state.background}, frame: state.frame};
  return {kind: 'spatial', camera: state.camera!, settings: {background: state.background, projection: state.projection, axes: state.axes, shading: state.shading, render_mode: viewport.renderMode, light: viewport.lightSettings}, frame: state.frame};
}

export function registerViewOperations(host: OperationHost, viewport: SceneViewport): () => void {
  const complete = (status: ViewMutation['status']): ViewMutation => {
    const view = readView(viewport); host.notify('view', view); return {status, view};
  };
  const registrations = [
    host.register(viewOperations.get, () => readView(viewport)),
    host.register(viewOperations.set, params => {
      if (params.kind !== viewport.kind) throw new OperationError('UNSUPPORTED', 'Camera kind must match the active viewport', {field: 'kind'});
      if (params.kind === 'board' && viewport.kind === 'board') viewport.setCamera({center: params.center, scale: params.scale});
      else if (params.kind === 'spatial' && viewport.kind === 'spatial') {
        const {position, target, up} = params.camera;
        const dx = position[0] - target[0], dy = position[1] - target[1], dz = position[2] - target[2];
        const cross = Math.hypot(dy * up[2] - dz * up[1], dz * up[0] - dx * up[2], dx * up[1] - dy * up[0]);
        if (!Number.isFinite(cross) || cross === 0) throw new OperationError('INVALID_ARGUMENT', 'Camera position must differ from target, and up must not be zero or parallel to the viewing direction', {field: 'camera'});
        viewport.setCamera(params.camera);
      }
      return complete('committed');
    }),
    host.register(viewOperations.pan, params => {
      viewport.pan(params.delta); return complete('committed');
    }),
    host.register(viewOperations.zoom, params => {
      viewport.zoom(params.factor, params.anchor); return complete('committed');
    }),
    host.register(viewOperations.rotate, params => {
      if (viewport.kind !== 'spatial') throw new OperationError('UNSUPPORTED', 'Board camera does not support rotation');
      viewport.rotate(params.axis, params.angle); return complete('committed');
    }, () => viewport.kind === 'spatial'),
    host.register(viewOperations.canonical, params => {
      if (viewport.kind !== 'spatial') throw new OperationError('UNSUPPORTED', 'Board camera does not have canonical spatial views');
      if (!viewport.hasVisibleContent) throw new OperationError('RESOURCE_UNAVAILABLE', 'No visible world entities to frame');
      viewport.setCanonicalView(params.direction); return complete('committed');
    }, () => viewport.kind === 'spatial'),
    host.register(viewOperations.fit, async params => {
      if (!viewport.hasVisibleContent) return complete('committed');
      viewport.fitAll(params.animate ?? true);
      const status = await viewport.waitForViewTransition();
      return complete(status);
    }),
    host.register(viewOperations.settings, params => {
      if (viewport.kind === 'board') {
        for (const key of Object.keys(params)) if (key !== 'background') throw new OperationError('UNSUPPORTED', `Board viewport does not support ${key}`, {field: key});
        if (params.background !== undefined) viewport.setBackground(params.background);
      } else viewport.batchStyles(() => {
        if (params.background !== undefined) viewport.setBackground(params.background);
        if (params.projection !== undefined) viewport.setProjection(params.projection);
        if (params.axes !== undefined) viewport.setAxes(params.axes);
        if (params.shading !== undefined) viewport.setShading(params.shading);
        if (params.render_mode !== undefined) viewport.setRenderMode(params.render_mode);
        if (params.light !== undefined) viewport.setLight(params.light);
      });
      return complete('committed');
    }),
  ];
  return () => { for (const unregister of registrations) unregister(); };
}
