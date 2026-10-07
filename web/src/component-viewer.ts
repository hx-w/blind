import * as THREE from 'three';
import { packGroups } from './component-layout';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { PublicScene, Vec3 } from './api';
import type { SceneViewport } from './viewport/types';
import { ComponentRegistry, componentGroups, entityUpdate, effectiveVisibility, sceneEntities, type ComponentCapabilities, type ComponentRuntime, type Presentation, type SceneEntity } from './scene-components';
import { textContent, markdownContent, jsonContent, pluginContent, htmlContent, imageContent, type ContentFactory } from './component-content';
import {diagramContent} from './diagram-content';
import {ContentAnnotations} from './content-annotations';
import {updateContentState, validateContentState} from './content-reading';
import type {ContentAnchor, ContentState, ContentTarget, JsonBranch, NativeContent} from './content-surface';
import type {SurfaceContent} from './component-content';
import {installIcons} from './icons';
import {compactLabel} from './compact-label';
import {OperationError, type OperationHost} from './operations/core';
import type {ContentFactoryContext} from './component-content';
import {readView} from './operations/view';
import type {ViewMutation} from './operations/view';
import './components.css';

interface Context extends ContentFactoryContext { viewer: SceneViewport; host: ComponentViewer; scene: PublicScene }
interface Entry { spec: SceneEntity; runtime: ComponentRuntime; capabilities: ComponentCapabilities }
export interface EntitySnapshot {
  id: string; component: string; label: string; group: string | null; placement: 'world' | 'panel';
  visible: boolean; opacity: number; selected: boolean; position: Vec3 | null; size: [number, number] | null;
  capabilities: ComponentCapabilities; color?: string; quality?: 'raw' | 'lod'; loading?: boolean;
  loadState?: 'unloaded' | 'loading' | 'ready' | 'error'; unavailable?: string;
}
export interface ContentSnapshot {
  id: string; native: boolean; ready: boolean; presentation: Presentation; menu: boolean; unavailable?: string;
  state?: ContentState; capabilities: {reading: boolean; selection: boolean; zoom: boolean; fit: boolean; json: boolean; annotations: boolean};
  targets: readonly ContentTarget[]; layers: readonly {id: string; label: string}[]; branches: readonly JsonBranch[];
  targetRange?: {prefix: string; count: number};
  annotation?: {active: boolean; kind: 'point' | 'line'; selected: string | null; label: string; color: string; canUndo: boolean; canRedo: boolean};
}
export interface SceneListState { open: boolean; tab: 'elements' | 'info' }
interface TreeRow { button: HTMLButtonElement; edit: HTMLButtonElement; editor: HTMLFormElement; input: HTMLTextAreaElement; label: string; opacity: HTMLInputElement; visibility: HTMLButtonElement; color?: HTMLButtonElement; palette?: HTMLElement; choices?: HTMLButtonElement[] }
const geometryPalette = ['#8fa9c9', '#8ca49c', '#b2a4ad', '#bf8078', '#8f8bb2', '#b7b3aa'];
const sceneInput = {spatial: 'scene', focus: 'scene', fullscreen: 'scene'} as const;
const contentInput = {spatial: 'scene', focus: 'content', fullscreen: 'content'} as const;
export function builtInComponents(): ComponentRegistry<Context> {
  const registry = new ComponentRegistry<Context>();
  for (const type of ['mesh', 'points']) registry.register({type,
    capabilities: {presentations: ['spatial', 'focus', 'fullscreen'], movable: false, resizable: false, input: sceneInput, geometry: type as 'mesh' | 'points'},
    create(spec, {viewer, host}) {
      if (viewer.kind !== 'spatial') throw new OperationError('UNSUPPORTED', 'Geometry requires a spatial viewport', {target: spec.id});
      const index = spec.source.index;
      return {
        get bounds() { return viewer.meshBounds(index); },
        setPosition: p => viewer.setMeshPosition(index, p),
        setVisible: v => viewer.setVisible(index, v),
        setOpacity: v => viewer.setMeshOpacity(index, v),
        setLabel: label => viewer.setLabelAt(index, label),
        setPresentation: () => {}, select: () => viewer.select(index),
        focus: () => host.focusEntities([spec.id]), dispose: () => {},
      };
    },
  });
  for (const [type, content] of Object.entries({text: textContent, markdown: markdownContent, json: jsonContent, html: htmlContent, image: imageContent, mermaid: diagramContent, dot: diagramContent})) {
    registry.register({type, capabilities: {presentations: type === 'html' ? ['spatial', 'focus'] : ['spatial', 'focus', 'fullscreen'], movable: false, resizable: false, input: {...contentInput, spatial: type === 'html' ? 'scene' : 'content'}},
      create: (spec, context) => new SurfaceRuntime(spec, context, content)});
  }
  return registry;
}

export class ComponentViewer {
  readonly layer = new THREE.Scene();
  private readonly compositor = document.createElement('div');
  readonly panelRoot = document.createElement('aside');
  private operations?: OperationHost;
  private panelResize?: ResizeObserver;
  private readonly panelEdge = document.createElement('div');
  private panelWidth?: number;
  private panelDrag?: {id: number; x: number; width: number};
  private readonly planes = new Map<number, {scene: THREE.Scene; renderer: CSS3DRenderer}>();
  private readonly bands: HTMLCanvasElement[] = [];
  private readonly entries: Entry[] = [];
  private readonly tree = document.createElement('aside');
  private readonly treeViews = new Map<'elements' | 'info', {button: HTMLButtonElement; content: HTMLElement}>();
  private treeTab: 'elements' | 'info' = 'elements';
  private treeResize?: ResizeObserver;
  private readonly rows = new Map<string, TreeRow>();
  private openColorPicker?: {trigger: HTMLButtonElement; palette: HTMLElement; item: HTMLElement};
  private activeRename?: {entry: Entry; trigger: HTMLButtonElement; editor: HTMLFormElement; input: HTMLTextAreaElement; item: HTMLElement};
  private nameLayoutQueued = false;
  private readonly nameMeasure = document.createElement('canvas').getContext('2d');
  private readonly toggle = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly expandedContent = document.createElement('div');
  private readonly dialogTitle = document.createElement('h2');
  private readonly groupLabels = document.createElement('div');
  private readonly captions: {element: HTMLElement; entries: Entry[]}[] = [];
  private readonly viewport = matchMedia('(min-width: 1100px) and (min-height: 600px)');
  private expanded?: Entry;
  private returnFocus?: HTMLElement;
  private selected?: Entry;
  private opened = this.viewport.matches;
  get entityMutationActive(): boolean { return this.syncing; }
  private syncing = false;
  private contentCommitDepth = 0;
  private readonly pendingContentEvents = new Set<string>();
  private readonly touches = new Map<number, {event: PointerEvent; runtime?: SurfaceRuntime}>();
  private cameraTouch = false;
  onSelect?: (entity: SceneEntity) => void;
  onChange?: () => void;
  onScreenAnnotation?: () => void;
  onContentViewChange?: () => void;
  onError?: (error: unknown) => void;
  onFrameRequest?: () => void;
  get selectedEntity(): SceneEntity | undefined { return this.selected?.spec; }
  get selectedGeometry(): 'mesh' | 'points' | undefined { return this.selected?.capabilities.geometry; }
  openInfo(): void { this.setSceneList({open: true, tab: 'info'}); }
  get sceneListState(): SceneListState { return {open: this.opened, tab: this.treeTab}; }
  setSceneList(changes: {open?: boolean; tab?: 'elements' | 'info'}): SceneListState {
    const previous = this.sceneListState;
    if (changes.tab !== undefined) this.showTreeView(changes.tab);
    if (changes.open !== undefined) this.setOpen(changes.open);
    const state = this.sceneListState;
    if (state.open !== previous.open || state.tab !== previous.tab) this.operations?.notify('scene-list', {sceneList: state});
    return state;
  }
  annotateContent(): boolean {
    const runtime = this.selected?.runtime;
    if (!(runtime instanceof SurfaceRuntime)) return false;
    return runtime.annotate();
  }
  closeContentAnnotation(): void {
    for (const entry of this.entries) if (entry.runtime instanceof SurfaceRuntime) entry.runtime.closeAnnotation();
  }
  returnToScene(): void { this.close(); }
  get entities(): readonly SceneEntity[] { return this.entries.map(e => e.spec); }
  bindOperations(host: OperationHost): void { this.operations = host; }
  private changed(): void { this.onChange?.(); this.operations?.notify('entity', {entities: this.listEntities(), selected: this.selected?.spec.id ?? null}); }
  private runMutation(mutation: Promise<unknown>): void { void mutation.catch(error => this.onError?.(error)); }
  private panelWidthRange(): {min: number; max: number} {
    const width = this.root.clientWidth;
    const max = Math.max(0, width - Math.min(320, width / 2));
    return {min: Math.min(240, max), max};
  }
  private updatePanelSpace = (): void => {
    const visible = this.entries.some(entry => entry.spec.placement === 'panel' && effectiveVisibility(entry.spec));
    this.panelRoot.hidden = !visible; this.panelEdge.hidden = !visible; this.root.classList.toggle('has-fixed-panels', visible);
    const {min, max} = this.panelWidthRange();
    const width = Math.min(max, Math.max(min, this.panelWidth ?? Math.min(360, this.root.clientWidth * .4)));
    this.panelRoot.style.width = `${width}px`;
    this.panelEdge.style.right = `${width - 6}px`;
    this.panelEdge.setAttribute('aria-valuemin', String(Math.round(min)));
    this.panelEdge.setAttribute('aria-valuemax', String(Math.round(max)));
    this.panelEdge.setAttribute('aria-valuenow', String(Math.round(width)));
    this.panelEdge.setAttribute('aria-valuetext', `${Math.round(width)} 像素`);
    this.viewer.setReservedSpace(visible ? width : 0);
    this.root.closest<HTMLElement>('.app-shell')?.style.setProperty('--fixed-panel-space', `${visible ? width : 0}px`);
  };
  private resizePanel(width: number): void {
    const {min, max} = this.panelWidthRange();
    this.panelWidth = Math.min(max, Math.max(min, width)); this.updatePanelSpace();
  }
  private panelPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || this.panelDrag) return;
    event.preventDefault(); event.stopPropagation();
    this.panelDrag = {id: event.pointerId, x: event.clientX, width: this.panelRoot.getBoundingClientRect().width};
    this.panelEdge.focus({preventScroll: true}); this.panelEdge.setPointerCapture(event.pointerId);
  };
  private panelPointerMove = (event: PointerEvent): void => {
    const drag = this.panelDrag;
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopPropagation();
    this.resizePanel(drag.width + drag.x - event.clientX);
  };
  private panelPointerEnd = (event: PointerEvent): void => {
    if (event.pointerId !== this.panelDrag?.id) return;
    this.panelDrag = undefined;
    if (this.panelEdge.hasPointerCapture(event.pointerId)) this.panelEdge.releasePointerCapture(event.pointerId);
  };
  private panelKeyDown = (event: KeyboardEvent): void => {
    const {min, max} = this.panelWidthRange(), width = this.panelRoot.getBoundingClientRect().width;
    const step = event.shiftKey ? 40 : 10;
    const next = event.key === 'ArrowLeft' ? width + step : event.key === 'ArrowRight' ? width - step
      : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation(); this.resizePanel(next);
  };
  private requireEntry(id: string): Entry {
    const entry = this.entries.find(entry => entry.spec.id === id);
    if (!entry) throw new OperationError('UNKNOWN_ENTITY', 'Unknown entity', {target: id});
    return entry;
  }
  listEntities(): EntitySnapshot[] { return this.entries.map(entry => this.entitySnapshot(entry)); }
  getEntity(id: string): EntitySnapshot { return this.entitySnapshot(this.requireEntry(id)); }
  private entitySnapshot(entry: Entry): EntitySnapshot {
    const {spec, capabilities} = entry;
    const info = this.viewer.kind === 'spatial' && spec.source.kind === 'mesh' ? this.viewer.modelInfos[spec.source.index] : undefined;
    return {id: spec.id, component: spec.component, label: spec.label, group: spec.group, placement: spec.placement,
      visible: spec.visible, opacity: spec.opacity, selected: this.selected === entry, position: spec.position ? [...spec.position] : null,
      size: spec.size ? [...spec.size] : null, capabilities: structuredClone(capabilities),
      ...(info ? {color: info.color, quality: info.quality, loading: info.loading, loadState: info.loadState,
        ...(info.load_error ? {unavailable: info.load_error} : {})} : {})};
  }
  selectEntity(id: string): EntitySnapshot { this.select(this.requireEntry(id).spec); return this.getEntity(id); }
  labelEntity(id: string, label: string): EntitySnapshot {
    let length = 0; for (let index = 0; index < label.length; length++) index += label.codePointAt(index)! > 0xffff ? 2 : 1;
    if (!label.trim() || length > 120) throw new OperationError('INVALID_ARGUMENT', 'Name must contain 1–120 characters', {field: 'label'});
    this.setLabel(this.requireEntry(id), label); return this.getEntity(id);
  }
  async styleEntity(id: string, style: {visible?: boolean; opacity?: number; color?: string}): Promise<EntitySnapshot> {
    const entry = this.requireEntry(id);
    if (style.opacity !== undefined && (!Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1)) throw new OperationError('INVALID_ARGUMENT', 'Opacity must be between zero and one', {field: 'opacity'});
    if (style.color !== undefined && (!entry.capabilities.geometry || this.viewer.kind !== 'spatial')) throw new OperationError('UNSUPPORTED', 'Only geometry has a color', {target: id});
    if (style.color !== undefined && !/^#[0-9a-f]{6}$/i.test(style.color)) throw new OperationError('INVALID_ARGUMENT', 'Expected hex color', {field: 'color'});
    const visible = style.visible ?? entry.spec.visible;
    const opacity = style.opacity ?? (visible && entry.spec.opacity === 0 ? 1 : entry.spec.opacity);
    this.syncing = true;
    const commit = () => {
      if (style.color !== undefined && this.viewer.kind === 'spatial') this.viewer.setMeshColor(entry.spec.source.index, style.color);
      entry.spec.visible = visible; entry.spec.opacity = opacity;
      entry.runtime.setOpacity(opacity); entry.runtime.setVisible(effectiveVisibility(entry.spec)); this.refreshBounds();
    };
    try { if (this.viewer.kind === 'spatial') this.viewer.batchStyles(commit); else commit(); }
    finally { this.syncing = false; }
    this.visibilityGeneration++;
    this.sync(); this.changed();
    if (effectiveVisibility(entry.spec)) await this.ensureEntries([entry]);
    return this.getEntity(id);
  }
  async showEntities(ids: readonly string[], opacity?: number, fit = false): Promise<EntitySnapshot[]> {
    const chosen = ids.map(id => this.requireEntry(id));
    if (ids.length > 256 || new Set(ids).size !== ids.length) throw new OperationError('INVALID_ARGUMENT', 'Expected at most 256 unique entity IDs', {field: 'ids'});
    if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)) throw new OperationError('INVALID_ARGUMENT', 'Opacity must be between zero and one', {field: 'opacity'});
    const selected = new Set(chosen);
    this.syncing = true;
    if (fit) this.beginFrameRequest();
    const commit = () => {
      for (const entry of this.entries) {
        entry.spec.visible = selected.has(entry);
        if (entry.spec.visible) entry.spec.opacity = opacity ?? (entry.spec.opacity || 1);
        entry.runtime.setOpacity(entry.spec.opacity); entry.runtime.setVisible(effectiveVisibility(entry.spec));
      }
      this.refreshBounds();
    };
    try { if (this.viewer.kind === 'spatial') this.viewer.batchStyles(commit); else commit(); }
    finally { this.syncing = false; }
    this.sync();
    const generation = ++this.visibilityGeneration, frame = this.frameGeneration;
    this.changed();
    await this.ensureEntries(chosen.filter(entry => effectiveVisibility(entry.spec)));
    if (fit && generation === this.visibilityGeneration && frame === this.frameGeneration) {
      const bounds = new THREE.Box3();
      for (const entry of chosen) if (entry.spec.placement === 'world' && effectiveVisibility(entry.spec)) bounds.union(entry.runtime.bounds);
      if (!bounds.isEmpty()) this.viewer.focusBounds(bounds);
    }
    return this.listEntities();
  }
  isolateEntity(id: string, fit = false): Promise<EntitySnapshot[]> {
    const entry = this.requireEntry(id);
    this.syncing = true;
    try { this.select(entry.spec); } finally { this.syncing = false; }
    return this.showEntities([id], undefined, fit);
  }
  async focusEntities(ids: readonly string[], animate = false): Promise<ViewMutation> {
    const entries = ids.map(id => this.requireEntry(id));
    if (!entries.length || ids.length > 256 || new Set(ids).size !== ids.length) throw new OperationError('INVALID_ARGUMENT', 'Focus requires 1–256 unique entity IDs', {field: 'ids'});
    const generation = this.visibilityGeneration, frame = this.beginFrameRequest();
    await this.ensureEntries(entries.filter(entry => effectiveVisibility(entry.spec)));
    if (generation !== this.visibilityGeneration || frame !== this.frameGeneration) return {status: 'interrupted', view: readView(this.viewer)};
    const bounds = new THREE.Box3();
    for (const entry of entries) if (entry.spec.placement === 'world' && effectiveVisibility(entry.spec)) bounds.union(entry.runtime.bounds);
    if (entries.length === 1 && entries[0].spec.placement === 'panel' && effectiveVisibility(entries[0].spec) && entries[0].runtime instanceof SurfaceRuntime) {
      entries[0].runtime.focusPanel();
    } else {
      if (bounds.isEmpty()) throw new OperationError('RESOURCE_UNAVAILABLE', 'No visible world entities to focus');
      this.viewer.focusBounds(bounds, animate);
    }
    const status = await this.viewer.waitForViewTransition(), view = readView(this.viewer);
    this.operations?.notify('view', view); return {status, view};
  }
  async qualityEntity(id: string, quality: 'raw' | 'lod'): Promise<EntitySnapshot> {
    const entry = this.requireEntry(id);
    if (!entry.capabilities.geometry || this.viewer.kind !== 'spatial') throw new OperationError('UNSUPPORTED', 'Only geometry has mesh quality', {target: id});
    if (quality === 'lod' && this.viewer.annotations.some(mark => mark.mesh === entry.spec.source.index)) throw new OperationError('CONFLICT', 'Surface-marked geometry must retain raw quality', {target: id});
    await this.viewer.setQuality(entry.spec.source.index, quality);
    this.sync(); this.changed(); return this.getEntity(id);
  }
  placementEntity(id: string, placement: 'world' | 'panel'): EntitySnapshot {
    const entry = this.requireEntry(id);
    if (!(entry.runtime instanceof SurfaceRuntime)) throw new OperationError('UNSUPPORTED', 'Geometry cannot be placed in a panel', {target: id});
    if (placement === entry.spec.placement) return this.getEntity(id);
    const existingWorld = this.entries.find(candidate => candidate.spec.placement === 'world' && candidate !== entry);
    const worldZ = existingWorld ? existingWorld.spec.position?.[2] ?? 0 : entry.spec.position?.[2] ?? 0;
    if (placement === 'world' && this.viewer.kind === 'board' && (entry.spec.renderer?.capabilities.host_space === 'spatial' || Math.abs((entry.spec.position?.[2] ?? 0) - worldZ) > 1e-6)) throw new OperationError('UNSUPPORTED', 'Spatial content cannot enter a board world', {target: id});
    entry.runtime.setPlacement(placement); this.refreshBounds(); this.render(); this.changed(); return this.getEntity(id);
  }
  contentRuntime(id: string): SurfaceRuntime {
    const runtime = this.requireEntry(id).runtime;
    if (!(runtime instanceof SurfaceRuntime)) throw new OperationError('UNSUPPORTED', 'Entity has no content surface', {target: id});
    return runtime;
  }
  getContent(id: string): ContentSnapshot { return this.contentRuntime(id).snapshot(); }
  async whenSettled(): Promise<void> {
    await Promise.all(this.entries.flatMap(entry => entry.runtime instanceof SurfaceRuntime ? [entry.runtime.whenSettled()] : []));
  }
  private visibilityGeneration = 0;
  private frameGeneration = 0;
  private readonly laidOutGeometry = new Set<number>();
  cancelPendingFrame(): void { this.frameGeneration++; }
  private beginFrameRequest(): number { this.onFrameRequest?.(); return ++this.frameGeneration; }
  async prepareVisibleFrame(): Promise<boolean> {
    const frame = this.beginFrameRequest(), generation = this.visibilityGeneration;
    await this.ensureEntries(this.entries.filter(entry => effectiveVisibility(entry.spec)));
    return frame === this.frameGeneration && generation === this.visibilityGeneration;
  }
  private async ensureEntries(entries: readonly Entry[]): Promise<void> {
    if (this.viewer.kind === 'spatial') {
      await this.viewer.ensureLoaded(entries.filter(entry => entry.spec.source.kind === 'mesh').map(entry => entry.spec.source.index));
    }
    await Promise.all(entries.flatMap(entry => entry.runtime instanceof SurfaceRuntime ? [entry.runtime.ready] : []));
    await this.whenSettled();
  }
  contentChanged(id: string): void {
    if (!this.entries.some(entry => entry.spec.id === id)) return;
    if (this.contentCommitDepth) { this.pendingContentEvents.add(id); return; }
    this.onChange?.(); this.operations?.notify('content', {entityId: id, content: this.getContent(id)});
  }
  commitContent<T>(mutation: () => T): T {
    this.contentCommitDepth++;
    try { return mutation(); }
    finally {
      if (--this.contentCommitDepth === 0) {
        const ids = [...this.pendingContentEvents]; this.pendingContentEvents.clear();
        for (const id of ids) this.contentChanged(id);
      }
    }
  }
  private setLabel(entry: Entry, value: string): void {
    const spec = entry.spec;
    const fallback = spec.source.kind === 'mesh'
      ? this.scene.meshes[spec.source.index]?.name
      : this.scene.attachments?.[spec.source.index]?.label;
    const label = value.replace(/\s+/g, ' ').trim() || fallback || spec.label;
    if (label === spec.label) return;
    this.syncing = true;
    try {
      spec.label = label; entry.runtime.setLabel(label);
      if (this.expanded === entry) this.dialogTitle.textContent = label;
    } finally { this.syncing = false; }
    this.sync(); this.changed();
  }

  constructor(readonly root: HTMLElement, private readonly viewer: SceneViewport, readonly scene: PublicScene, registry = builtInComponents(), factoryContext: ContentFactoryContext = {}) {
    this.operations = factoryContext.operations;
    this.compositor.className = 'component-compositor'; if (viewer.kind === 'spatial') root.append(this.compositor);
    this.panelRoot.className = 'component-fixed-panels'; this.panelRoot.setAttribute('aria-label', '固定内容面板'); root.append(this.panelRoot);
    this.panelRoot.id = 'component-fixed-panels';
    this.panelEdge.className = 'component-panel-resize'; this.panelEdge.tabIndex = 0;
    this.panelEdge.setAttribute('role', 'separator'); this.panelEdge.setAttribute('aria-orientation', 'vertical');
    this.panelEdge.setAttribute('aria-label', '调整固定面板宽度'); this.panelEdge.setAttribute('aria-controls', this.panelRoot.id);
    this.panelEdge.setAttribute('data-viewer-chrome', '');
    this.panelEdge.addEventListener('pointerdown', this.panelPointerDown);
    this.panelEdge.addEventListener('pointermove', this.panelPointerMove);
    this.panelEdge.addEventListener('pointerup', this.panelPointerEnd);
    this.panelEdge.addEventListener('pointercancel', this.panelPointerEnd);
    this.panelEdge.addEventListener('lostpointercapture', this.panelPointerEnd);
    this.panelEdge.addEventListener('keydown', this.panelKeyDown); root.append(this.panelEdge);
    this.panelResize = new ResizeObserver(this.updatePanelSpace); this.panelResize.observe(this.panelRoot); this.panelResize.observe(root);
    this.groupLabels.className = 'component-group-labels'; root.append(this.groupLabels);
    const customTypes = new Set<string>();
    for (const spec of sceneEntities(scene)) {
      if (spec.renderer && !customTypes.has(spec.component)) {
        registry.register({type:spec.component,capabilities:{...spec.renderer.capabilities,movable:false,resizable:false,input:contentInput},create:(spec,context)=>new SurfaceRuntime(spec,context,pluginContent)});
        customTypes.add(spec.component);
      }
      const definition = registry.get(spec.component);
      this.entries.push({spec, capabilities: definition.capabilities, runtime: definition.create(spec, {viewer, host: this, scene, ...factoryContext})});
    }
    if (this.entries.some(e => e.runtime.element)) {
      root.classList.add('has-spatial-content');
      root.addEventListener('pointerdown', this.routePointer, true);
      root.addEventListener('click', this.routeClick, true);
      root.addEventListener('wheel', this.routeWheel, {capture: true, passive: false});
      window.addEventListener('pointerup', this.releaseTouch, true);
      window.addEventListener('pointercancel', this.releaseTouch, true);
    }
    this.layout(); this.buildTree(); this.buildDialog(); this.sync();
    viewer.renderListeners.add(this.render); this.viewport.addEventListener('change', this.viewportChanged);
    viewer.entityUpdates = () => this.entries.map(e => entityUpdate(e.spec));
    this.refreshBounds();
    if (viewer.kind === 'spatial' && !scene.state.camera && viewer.hasVisibleContent) { viewer.setCanonicalView('pz'); viewer.fitAll(false); }
    if (this.entries[0]) this.select(this.entries.find(e => e.spec.id === viewer.focusedComponentId)?.spec ?? (viewer.kind === 'spatial' ? this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === viewer.selectedIndex)?.spec : undefined) ?? this.entries[0].spec, false);
    this.render();
  }
  async ready(): Promise<void> {
    const visible = this.entries.filter(e => effectiveVisibility(e.spec));
    const results = await Promise.allSettled(visible.map(e => e.runtime.ready));
    const expanded = visible.find((entry, index) => results[index].status === 'fulfilled'
      && entry.runtime instanceof SurfaceRuntime && ['focus', 'fullscreen'].includes((entry.spec.state as ContentState | undefined)?.presentation ?? 'spatial'));
    if (expanded && (!document.documentElement.classList.contains('embedded-scene') || document.documentElement.classList.contains('embedded-active'))) {
      this.present(expanded.spec, (expanded.spec.state as ContentState).presentation!);
    }
    this.render();
    await this.whenSettled();
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  // Geometry bands do not intercept DOM events. Route their covered pixels
  // to geometry, while exposed content controls remain interactive.
  private occluded(event: MouseEvent): boolean {
    const element = event.target instanceof Element ? event.target.closest('.scene-surface') : null;
    const entry = this.entries.find(e => e.runtime.element === element);
    return entry?.runtime instanceof SurfaceRuntime && entry.runtime.occludedAt(event.clientX, event.clientY);
  }
  private routePointer = (event: PointerEvent): void => {
    // Forwarded canvas events already belong to ArcballControls.
    if (!event.isTrusted && event.target instanceof HTMLCanvasElement) return;
    if (event.target === this.panelEdge) return;
    if (event.pointerType === 'touch') {
      const element = event.target instanceof Element ? event.target.closest('.scene-surface') : null;
      const runtime = this.entries.find(entry => entry.runtime.element === element)?.runtime;
      this.touches.set(event.pointerId, {event, runtime: runtime instanceof SurfaceRuntime && runtime.isNativeSpatial && !this.occluded(event) && !(event.target instanceof Element && event.target.closest('.component-handle, .component-overflow')) ? runtime : undefined});
      if (this.touches.size > 1 && [...this.touches.values()].some(touch => touch.runtime)) {
        for (const touch of this.touches.values()) touch.runtime?.cancelContentGesture();
        if (!this.cameraTouch) {
          this.cameraTouch = true;
          for (const touch of this.touches.values()) {
            if (touch.runtime || touch.event === event) this.viewer.navigatePointer(touch.event);
          }
        } else this.viewer.navigatePointer(event);
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (this.cameraTouch) { event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigatePointer(event); return; }
    }
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigatePointer(event);
      // Picking listens for pointerup on the canvas. Keep the native gesture
      // there after redirecting its start, even though DOM content receives hits.
      this.root.querySelector('canvas')?.setPointerCapture(event.pointerId);
    }
  };
  private releaseTouch = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId); if (!this.touches.size) this.cameraTouch = false;
  };
  private routeClick = (event: MouseEvent): void => {
    if (this.occluded(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private routeWheel = (event: WheelEvent): void => {
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigateWheel(event);
    }
  };
  private layout(): void {
    // Explicit positions are absolute world coordinates. Only unpositioned components are tiled.
    for (const entry of this.entries) {
      if (entry.spec.position) entry.runtime.setPosition(entry.spec.position);
    }
    const originals = new Map(sceneEntities(this.scene).map(c => [c.id, c]));
    const groups = [...componentGroups(this.entries.filter(e => e.spec.placement === 'world').map(e => e.spec)).entries()];
    const plans = groups.map(([label, specs]) => {
      const entries = specs.map(s => this.entries.find(e => e.spec === s)!);
      const geometry = entries.filter(e => !e.runtime.element);
      const geometryBounds = new THREE.Box3(); geometry.forEach(e => geometryBounds.union(e.runtime.bounds));
      const center = geometryBounds.getCenter(new THREE.Vector3());
      const size = geometryBounds.getSize(new THREE.Vector3());
      const automaticGeometry = geometry.filter(e => !e.spec.position);
      if (this.viewer.kind === 'spatial') {
        const viewer = this.viewer;
        automaticGeometry.forEach(e => this.position(e, new THREE.Vector3().fromArray(viewer.modelInfos[e.spec.source.index].translation ?? [0, 0, 0]).sub(center).toArray() as Vec3));
      }
      let x = geometry.length ? Math.max(size.x / 2, 30) + 18 : 0;
      for (const entry of entries.filter(e => e.runtime.element && !e.spec.position)) {
        const [w] = entry.spec.size ?? [110, 70];
        this.position(entry, [x + w / 2, 0, 0]); x += w + 14;
      }
      const bounds = new THREE.Box3(); entries.forEach(e => bounds.union(e.runtime.bounds));
      return {label, entries, bounds};
    });
    const packed = packGroups(plans.map(p => {const size = p.bounds.getSize(new THREE.Vector3());return [size.x,size.y] as const;}),this.root.clientWidth / Math.max(1,this.root.clientHeight));
    plans.forEach((plan, index) => {
      const center = plan.bounds.getCenter(new THREE.Vector3());
      const offset = new THREE.Vector3(...packed[index],0).sub(center);
      for (const entry of plan.entries) {
        const original = originals.get(entry.spec.id)!;
        if (!original.position) this.position(entry, new THREE.Vector3().fromArray(entry.spec.position ?? [0, 0, 0]).add(offset).toArray() as Vec3);
      }
      const geometricLabel = this.scene.label_groups.some(group =>
        group.text === plan.label && group.meshes.length === plan.entries.length &&
        plan.entries.every(entry => entry.spec.source.kind === 'mesh' && group.meshes.includes(entry.spec.source.index)));
      if (plan.label && !geometricLabel) {
        const caption = document.createElement('span'); caption.textContent = plan.label; this.groupLabels.append(caption);
        this.captions.push({element: caption, entries: plan.entries});
      }
    });
  }
  private relayoutGeometry(): void {
    const originals = new Map(sceneEntities(this.scene).map(spec => [spec.id, spec]));
    this.groupLabels.replaceChildren(); this.captions.length = 0;
    for (const entry of this.entries) {
      const original = originals.get(entry.spec.id)!;
      if (original.position) continue;
      entry.spec.position = null;
      if (entry.spec.source.kind === 'mesh' && this.viewer.kind === 'spatial') {
        entry.runtime.setPosition(this.scene.meshes[entry.spec.source.index].translation ?? [0, 0, 0]);
      } else entry.runtime.setPosition([0, 0, 0]);
    }
    this.layout();
  }
  private position(entry: Entry, position: Vec3): void { entry.spec.position = position; entry.runtime.setPosition(position); }
  refreshBounds(): void {
    const box = new THREE.Box3();
    this.entries.filter(e => e.spec.placement === 'world' && e.runtime.element && effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
    this.updatePanelSpace();
    this.viewer.setComponentBounds(box);
  }
  select(spec: SceneEntity, notify = true): void {
    const entry = this.entries.find(e => e.spec === spec); if (!entry) return;
    this.selected = entry;
    this.viewer.setFocusedComponent(spec.id);
    if (notify) { entry.runtime.select(); this.onSelect?.(spec); if (!this.syncing) this.operations?.notify('entity', {selected: spec.id}); }
    for (const e of this.entries) { const selected = e === entry; this.rows.get(e.spec.id)?.button.setAttribute('aria-pressed', String(selected)); e.runtime.element?.classList.toggle('selected', selected); }
    this.scheduleNameLayout();
  }
  selectMesh(index: number): void { const entry = this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === index); if (entry) this.select(entry.spec, false); }
  sync(): void {
    if (this.syncing) return; this.syncing = true;
    if (this.viewer.kind === 'spatial') {
      const fresh = this.viewer.modelInfos.flatMap((info, index) => info.loadState === 'ready' && !this.laidOutGeometry.has(index) ? [index] : []);
      if (fresh.length) {
        for (const index of fresh) this.laidOutGeometry.add(index);
        this.relayoutGeometry();
      }
    }
    for (const entry of this.entries) {
      const {spec, runtime} = entry;
      if (spec.source.kind === 'mesh' && this.viewer.kind === 'spatial') {
        const info = this.viewer.modelInfos[spec.source.index]; if (info) { spec.visible = info.visible; spec.opacity = info.opacity; spec.label = info.label?.text ?? info.name; }
      }
      runtime.setVisible(effectiveVisibility(spec));
      const row = this.rows.get(spec.id);
      if (row) {
        const visible = effectiveVisibility(spec);
        const percentage = Math.round(spec.opacity * 100);
        row.label = spec.label;
        row.button.setAttribute('aria-label', spec.label);
        const info = spec.source.kind === 'mesh' && this.viewer.kind === 'spatial' ? this.viewer.modelInfos[spec.source.index] : undefined;
        const status = info?.loadState === 'unloaded' ? '尚未加载' : info?.loadState === 'loading' ? '正在加载' : info?.loadState === 'error' ? '加载失败' : '';
        row.button.dataset.loadState = info?.loadState ?? 'ready';
        row.button.setAttribute('aria-description', status);
        row.button.title = `${spec.label}${status ? ` · ${status}` : ''} · 双击仅显示此元素`;
        row.edit.setAttribute('aria-label', `修改 ${spec.label} 的名称`);
        row.input.setAttribute('aria-label', `${spec.label} 的名称`);
        row.button.style.setProperty('--element-opacity', String(visible ? Math.max(.45, spec.opacity) : .35));
        row.opacity.value = String(percentage);
        row.opacity.style.setProperty('--level', `${percentage}%`);
        row.opacity.setAttribute('aria-label', `${spec.label} 透明度`);
        row.opacity.setAttribute('aria-valuetext', `${percentage}%`);
        row.opacity.title = `${spec.label} · ${percentage}%`;
        row.opacity.dataset.visible = String(visible);
        row.visibility.dataset.visible = String(visible);
        row.visibility.setAttribute('aria-label', `${visible ? '隐藏' : '显示'} ${spec.label}`);
        row.visibility.title = `${visible ? '隐藏' : '显示'} ${spec.label}`;
        if (row.color && spec.source.kind === 'mesh') {
          const color = this.viewer.kind === 'spatial' ? this.viewer.modelInfos[spec.source.index]?.color ?? '#8fa9c9' : '#8fa9c9';
          row.color.style.setProperty('--swatch', color);
          row.color.setAttribute('aria-label', `修改 ${spec.label} 的颜色`);
          row.color.title = `${spec.label} · ${color}`;
          row.palette?.setAttribute('aria-label', `${spec.label} 颜色候选`);
          for (const choice of row.choices ?? []) {
            choice.setAttribute('aria-label', `将 ${spec.label} 设为 ${choice.dataset.color}`);
            choice.setAttribute('aria-pressed', String(choice.dataset.color === color.toLowerCase()));
          }
        }
      }
    }
    this.syncing = false; this.refreshBounds(); this.scheduleNameLayout();
  }
  private scheduleNameLayout(): void {
    if (this.nameLayoutQueued) return;
    this.nameLayoutQueued = true;
    requestAnimationFrame(() => {
      this.nameLayoutQueued = false;
      const context = this.nameMeasure;
      if (!context) return;
      for (const row of this.rows.values()) {
        const style = getComputedStyle(row.button);
        const width = row.button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        if (width <= 0) continue;
        context.font = style.font;
        const display = compactLabel(row.label, text => context.measureText(text).width <= width);
        if (row.button.textContent !== display) row.button.textContent = display;
      }
    });
  }
  private finishRename(save: boolean, restoreFocus = true): void {
    const current = this.activeRename; if (!current) return;
    this.activeRename = undefined;
    current.editor.hidden = true; current.item.classList.remove('rename-open');
    if (save) this.labelEntity(current.entry.spec.id, current.input.value.trim() || current.entry.spec.label);
    this.scheduleNameLayout();
    if (restoreFocus) current.trigger.focus({preventScroll: true});
  }
  private startRename(entry: Entry, trigger: HTMLButtonElement, editor: HTMLFormElement, input: HTMLTextAreaElement, item: HTMLElement): void {
    if (this.activeRename?.editor === editor) { this.finishRename(true); return; }
    this.finishRename(true, false); this.closeColorPicker(); this.select(entry.spec);
    this.activeRename = {entry, trigger, editor, input, item};
    input.value = entry.spec.label; editor.hidden = false; item.classList.add('rename-open');
    this.scheduleNameLayout(); input.focus({preventScroll: true}); input.select();
    requestAnimationFrame(() => editor.scrollIntoView({block: 'nearest'}));
  }
  private closeColorPicker(): void {
    if (!this.openColorPicker) return;
    const {trigger, palette, item} = this.openColorPicker;
    trigger.setAttribute('aria-expanded', 'false'); palette.hidden = true; item.classList.remove('color-open');
    this.openColorPicker = undefined;
  }
  private toggleColorPicker(trigger: HTMLButtonElement, palette: HTMLElement, item: HTMLElement): void {
    const wasOpen = this.openColorPicker?.trigger === trigger;
    this.closeColorPicker();
    if (wasOpen) return;
    palette.hidden = false; trigger.setAttribute('aria-expanded', 'true'); item.classList.add('color-open');
    this.openColorPicker = {trigger, palette, item};
    requestAnimationFrame(() => palette.scrollIntoView({block: 'nearest'}));
  }
  private dismissColorPicker = (event: MouseEvent): void => {
    const target = event.target;
    const rename = this.activeRename;
    if (rename && target instanceof Node && !rename.trigger.contains(target) && !rename.editor.contains(target)) this.finishRename(true, false);
    const open = this.openColorPicker;
    if (!open || !(target instanceof Node) || open.trigger.contains(target) || open.palette.contains(target)) return;
    this.closeColorPicker();
  };

  open(spec: SceneEntity): void {
    const entry = this.entries.find(e => e.spec === spec);
    if (!entry) return;
    const mode = entry.capabilities.presentations.includes('focus') ? 'focus'
      : entry.capabilities.presentations.includes('fullscreen') ? 'fullscreen' : null;
    if (mode) this.present(spec, mode);
  }
  presentEntity(id: string, mode: Presentation): void { this.present(this.requireEntry(id).spec, mode); }
  present(spec: SceneEntity, mode: Presentation): void { this.commitContent(() => this.applyPresentation(spec, mode)); }
  private applyPresentation(spec: SceneEntity, mode: Presentation): void {
    const entry = this.requireEntry(spec.id);
    if (!entry.capabilities.presentations.includes(mode)) throw new OperationError('UNSUPPORTED', 'Unsupported entity presentation', {target: spec.id});
    if (entry.runtime instanceof SurfaceRuntime) entry.runtime.validatePresentation(mode);
    if (this.expanded?.runtime instanceof SurfaceRuntime && this.expanded !== entry) this.expanded.runtime.validatePresentation('spatial');
    if (mode === 'spatial') {
      if (this.expanded === entry) this.close();
      else entry.runtime.setPresentation(mode);
      return;
    }
    if (!entry.runtime.element) {
      entry.runtime.focus();
      return;
    }
    if (entry.runtime instanceof SurfaceRuntime && !entry.runtime.preparePresentation(mode)) return;
    if (this.expanded && this.expanded !== entry) {
      const previous = this.expanded;
      if (previous.runtime instanceof SurfaceRuntime && !previous.runtime.preparePresentation('spatial')) return;
      previous.runtime.setPresentation('spatial'); this.expanded = undefined;
    }
    this.select(spec);
    if (!this.expanded) {
      if (!this.dialog.open) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.expanded = entry; this.dialogTitle.textContent = spec.label;
      moveElement(this.expandedContent, entry.runtime.element);
      this.dialog.classList.toggle('native-dialog', entry.runtime instanceof SurfaceRuntime && entry.runtime.hasNative);
      this.viewer.setInteractionEnabled(false); if (!this.dialog.open) this.dialog.showModal();
    }
    this.dialog.classList.toggle('fullscreen-dialog', mode === 'fullscreen');
    entry.runtime.setPresentation(mode);
  }
  private close = (): void => {
    this.commitContent(() => {
      if (!this.expanded) return;
      const entry = this.expanded;
      if (entry.runtime instanceof SurfaceRuntime && !entry.runtime.preparePresentation('spatial')) return;
      this.expanded = undefined;
      entry.runtime.setPresentation('spatial'); this.dialog.close(); this.viewer.setInteractionEnabled(true);
      this.returnFocus?.focus({preventScroll: true}); this.viewer.invalidate();
    });
  };
  private buildDialog(): void {
    this.dialog.className = 'component-dialog'; this.dialog.setAttribute('aria-labelledby', 'component-dialog-title');
    this.dialogTitle.id = 'component-dialog-title'; const heading = document.createElement('header');
    const close = button('返回场景', this.close); heading.append(this.dialogTitle, close);
    this.expandedContent.className = 'component-expanded-content'; this.dialog.append(heading, this.expandedContent);
    document.querySelector('#app-shell')!.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.close(); });
    this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.close(); });
  }
  private buildTree(): void {
    this.tree.className = 'scene-tree'; this.tree.id = 'scene-tree'; this.tree.setAttribute('aria-label', '场景元素'); this.tree.dataset.labelObstacle = '';
    const heading = document.createElement('header'); const title = document.createElement('h2'); title.textContent = '场景';
    heading.append(title); this.tree.append(heading);
    const tabs = document.createElement('div'); tabs.className = 'scene-tree-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '场景内容');
    const elementsTab = button('', () => this.setSceneList({tab: 'elements'})); elementsTab.innerHTML = '<i data-lucide="layers-3" aria-hidden="true"></i>'; elementsTab.setAttribute('aria-label', '元素'); elementsTab.title = '元素';
    const infoTab = button('', () => this.setSceneList({tab: 'info'})); infoTab.innerHTML = '<i data-lucide="info" aria-hidden="true"></i>'; infoTab.setAttribute('aria-label', '信息'); infoTab.title = '信息';
    for (const [name, tab] of [['elements', elementsTab], ['info', infoTab]] as const) {
      tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.id = `scene-tree-${name}-tab`; tabs.append(tab);
    }
    heading.append(tabs);
    const elements = document.createElement('div'); elements.className = 'scene-tree-elements';
    const actions = document.createElement('div'); actions.className = 'scene-tree-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '场景显示');
    const showAll = button('全部显示', () => this.runMutation(this.showEntities(this.entries.map(entry => entry.spec.id))));
    const hideAll = button('全部隐藏', () => this.runMutation(this.showEntities([])));
    for (const [action, icon] of [[showAll, 'eye'], [hideAll, 'eye-off']] as const) {
      const marker = document.createElement('i'); marker.dataset.lucide = icon; marker.setAttribute('aria-hidden', 'true'); action.prepend(marker);
    }
    actions.append(showAll, hideAll); elements.append(actions);
    const list = document.createElement('div'); list.className = 'scene-tree-list'; list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', '场景元素列表'); elements.append(list);
    this.tree.append(elements);
    const info = document.querySelector<HTMLElement>('#scene-info')!;
    info.classList.add('scene-tree-info'); this.tree.append(info);
    this.treeViews.set('elements', {button: elementsTab, content: elements});
    this.treeViews.set('info', {button: infoTab, content: info});
    this.showTreeView('elements');
    const content = document.createElement('div'); list.append(content);
    const updateEdges = () => {
      list.style.setProperty('--scroll-fade-top', `${Math.min(16, Math.max(0, list.scrollTop))}px`);
      list.style.setProperty('--scroll-fade-bottom', `${Math.min(16, Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop))}px`);
    };
    list.addEventListener('scroll', updateEdges, {passive: true});
    this.treeResize = new ResizeObserver(() => { updateEdges(); this.scheduleNameLayout(); }); this.treeResize.observe(list); this.treeResize.observe(content);
    for (const [group, specs] of componentGroups(this.entries.map(e => e.spec))) {
      if (group) { const label = document.createElement('h3'); label.textContent = group; content.append(label); }
      for (const spec of specs) {
        const entry = this.entries.find(e => e.spec === spec)!;
        const item = document.createElement('div'); item.className = 'scene-tree-item';
        const row = document.createElement('div'); row.className = 'scene-tree-row';
        const select = button(spec.label, () => this.select(spec)); select.className = 'scene-tree-select'; select.setAttribute('aria-pressed', 'false'); select.title = `${spec.label} · 双击仅显示此元素`;
        select.addEventListener('dblclick', () => this.runMutation(this.isolateEntity(spec.id, true)));
        const name = document.createElement('div'); name.className = 'scene-tree-name';
        const editor = document.createElement('form'); editor.className = 'scene-tree-rename'; editor.hidden = true;
        const input = document.createElement('textarea'); input.rows = 2; input.maxLength = 120; input.spellcheck = false;
        const save = button('', () => {}); save.type = 'submit'; save.className = 'scene-tree-rename-save'; save.setAttribute('aria-label', '保存名称'); save.innerHTML = '<i data-lucide="check" aria-hidden="true"></i>';
        const cancel = button('', () => this.finishRename(false)); cancel.className = 'scene-tree-rename-cancel'; cancel.setAttribute('aria-label', '取消改名'); cancel.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
        editor.append(input, save, cancel);
        editor.addEventListener('submit', event => {event.preventDefault(); this.finishRename(true);});
        input.addEventListener('keydown', event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.finishRename(false); }
          if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); this.finishRename(true);}
        });
        editor.addEventListener('focusout', () => setTimeout(() => {if (this.activeRename?.editor === editor && !editor.contains(document.activeElement)) this.finishRename(true, false);}, 0));
        const edit = button('', () => this.startRename(entry, edit, editor, input, item)); edit.className = 'scene-tree-edit'; edit.innerHTML = '<i data-lucide="pencil" aria-hidden="true"></i>';
        name.append(select, edit);
        const opacity = document.createElement('input'); opacity.className = 'scene-tree-opacity'; opacity.type = 'range'; opacity.min = '0'; opacity.max = '100'; opacity.step = '1';
        opacity.addEventListener('input', () => this.runMutation(this.styleEntity(spec.id, {visible: Number(opacity.value) > 0, opacity: Number(opacity.value) / 100})));
        const visibility = button('', () => this.runMutation(this.styleEntity(spec.id, {visible: !effectiveVisibility(spec)}))); visibility.className = 'scene-tree-visibility';
        visibility.innerHTML = '<i data-lucide="eye" aria-hidden="true"></i><i data-lucide="eye-off" aria-hidden="true"></i>';
        const view: TreeRow = {button: select, edit, editor, input, label: spec.label, opacity, visibility};
        if (entry.capabilities.geometry && spec.source.kind === 'mesh') {
          item.classList.add('has-color'); row.classList.add('has-color');
          const palette = document.createElement('div'); palette.className = 'scene-tree-color-options'; palette.hidden = true;
          palette.id = `scene-color-${this.rows.size}`; palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', `${spec.label} 颜色候选`);
          const color = button('', () => this.toggleColorPicker(color, palette, item)); color.className = 'scene-tree-color';
          color.setAttribute('aria-controls', palette.id); color.setAttribute('aria-expanded', 'false');
          view.color = color; view.palette = palette; view.choices = geometryPalette.map(value => {
            const choice = button('', () => {
              this.runMutation(this.styleEntity(spec.id, {color: value}));
              this.closeColorPicker(); color.focus({preventScroll: true});
            });
            choice.className = 'scene-tree-color-choice'; choice.dataset.color = value; choice.style.setProperty('--swatch', value);
            palette.append(choice); return choice;
          });
          row.append(color); item.append(row, editor, palette);
        } else item.append(row, editor);
        row.append(name, opacity, visibility); content.append(item); this.rows.set(spec.id, view);
      }
    }
    this.toggle.className = 'icon-button'; this.toggle.type = 'button'; this.toggle.id = 'scene-tree-toggle'; this.toggle.setAttribute('aria-label', '场景元素'); this.toggle.setAttribute('aria-controls', this.tree.id);
    this.toggle.innerHTML = '<i data-lucide="layers-3" aria-hidden="true"></i>';
    this.toggle.onclick = () => this.setSceneList({open: !this.opened});
    document.querySelector('.top-actions')!.prepend(this.toggle); document.querySelector('#scene-panels')!.prepend(this.tree); this.setOpen(this.opened);
    installIcons(document);
    document.addEventListener('click', this.dismissColorPicker);
    this.tree.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (this.activeRename) { event.preventDefault(); event.stopPropagation(); this.finishRename(false); }
      else if (this.openColorPicker) { event.preventDefault(); event.stopPropagation(); const trigger = this.openColorPicker.trigger; this.closeColorPicker(); trigger.focus(); }
      else this.setSceneList({open: false});
    });
  }
  private showTreeView(view: 'elements' | 'info'): void {
    this.treeTab = view;
    if (view !== 'elements') this.finishRename(true, false);
    if (view !== 'elements') this.closeColorPicker();
    for (const [name, {button, content}] of this.treeViews) {
      const selected = name === view;
      button.setAttribute('aria-selected', String(selected));
      content.hidden = !selected;
    }
  }
  private setOpen(open: boolean): void { if (!open) {this.finishRename(true, false); this.closeColorPicker();} this.opened = open; this.tree.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open)); document.querySelector('#app-shell')!.classList.toggle('tree-open', open); if (!open && this.tree.contains(document.activeElement)) this.toggle.focus(); if (open) this.scheduleNameLayout(); }
  private viewportChanged = (): void => { this.setSceneList({open: this.viewport.matches}); };
  private renderLayers(): void {
    if (this.viewer.kind !== 'spatial') return;
    const runtimes = this.entries.flatMap(entry => entry.runtime instanceof SurfaceRuntime ? [entry.runtime] : []);
    const objects = runtimes.flatMap(runtime => runtime.object ? [runtime.object] : []);
    const surfaces = runtimes.flatMap(runtime => runtime.spatialObject ? [runtime.spatialObject] : []);
    const allDepths = [...new Set(objects.map(object => object.position.z))];
    const depths = [...new Set(surfaces.map(object => object.position.z))].sort((a,b) => a-b);
    this.root.classList.toggle('composited-content', depths.length > 0);
    this.compositor.hidden = depths.length === 0;
    for (const [z, plane] of this.planes) {
      if (allDepths.includes(z)) continue;
      for (const object of [...plane.scene.children]) this.layer.add(object);
      plane.renderer.domElement.remove(); this.planes.delete(z);
    }
    for (const z of allDepths) {
      let plane = this.planes.get(z);
      if (!plane) {
        plane = {scene: new THREE.Scene(), renderer: new CSS3DRenderer()};
        plane.renderer.domElement.className = 'component-layer';
        // Clipping must not let focus/scrollIntoView shift the projected world.
        plane.renderer.domElement.style.overflow = 'clip';
        this.planes.set(z, plane); this.compositor.append(plane.renderer.domElement);
      }
      // Keep hidden wrappers connected so visibility toggles do not reload
      // plugin frames or discard content state.
      plane.renderer.domElement.hidden = !depths.includes(z);
      for (const object of objects.filter(object => object.position.z === z)) if (object.parent !== plane.scene) plane.scene.add(object);
      plane.renderer.setSize(this.viewer.viewportWidth, this.root.clientHeight);
      plane.renderer.render(plane.scene, this.viewer.activeCamera);
    }
    if (!depths.length) return;
    while (this.bands.length < depths.length + 1) {
      const canvas = document.createElement('canvas'); canvas.className = 'component-geometry';
      this.bands.push(canvas); this.compositor.append(canvas);
    }
    while (this.bands.length > depths.length + 1) this.bands.pop()!.remove();
    let order = 0;
    const band = (index: number) => {
      const canvas = this.bands[index]; canvas.style.zIndex = String(order++); canvas.style.width = `${this.viewer.viewportWidth}px`;
      if (this.viewer.kind === 'spatial') this.viewer.renderGeometryBand(canvas, depths[index-1] ?? -Infinity, depths[index] ?? Infinity);
    };
    const plane = (index: number) => { this.planes.get(depths[index])!.renderer.domElement.style.zIndex = String(order++); };
    const camera = this.viewer.activeCamera;
    if (camera instanceof THREE.OrthographicCamera) {
      if (camera.getWorldDirection(new THREE.Vector3()).z <= 0) {
        for (let i=0;i<=depths.length;i++) { band(i); if(i<depths.length) plane(i); }
      } else {
        for (let i=depths.length;i>=0;i--) { band(i); if(i>0) plane(i-1); }
      }
    } else {
      // If the eye lies between planes, rays on opposite sides never share a
      // pixel. Paint both far branches first, then the band containing the eye.
      const split = depths.findIndex(z => z > camera.position.z);
      const middle = split < 0 ? depths.length : split;
      for (let i=0;i<middle;i++) { band(i); plane(i); }
      for (let i=depths.length;i>middle;i--) { band(i); plane(i-1); }
      band(middle);
    }
  }
  private render = (): void => {
    if (this.viewer.kind === 'spatial') for (const entry of this.entries) if (entry.runtime instanceof SurfaceRuntime) entry.runtime.updateScreenScale(this.viewer.activeCamera, this.viewer.viewportWidth, this.root.clientHeight);
    if (this.viewer.kind === 'board') for (const entry of this.entries) if (entry.runtime instanceof SurfaceRuntime) entry.runtime.updateBoardScale(this.viewer.scale);
    this.renderLayers();
    for (const caption of this.captions) {
      const box = new THREE.Box3(); caption.entries.filter(e => e.spec.placement === 'world' && effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
      caption.element.hidden = box.isEmpty(); if (box.isEmpty()) continue;
      if (this.viewer.kind === 'board') {
        const point = this.viewer.worldToScreen(box.min.x, box.max.y + 5), rect = this.root.getBoundingClientRect();
        caption.element.style.transform = `translate(${point.x - rect.left}px,${point.y - rect.top - 32}px)`;
      } else {
        const p = new THREE.Vector3(box.min.x, box.max.y + 5, box.max.z).project(this.viewer.activeCamera);
        caption.element.hidden = p.z < -1 || p.z > 1;
        caption.element.style.transform = `translate(${(p.x + 1) * this.viewer.viewportWidth / 2}px,${(1 - p.y) * this.root.clientHeight / 2 - 32}px)`;
      }
    }
  };
  dispose(): void { document.removeEventListener('click', this.dismissColorPicker); window.removeEventListener('pointerup', this.releaseTouch, true); window.removeEventListener('pointercancel', this.releaseTouch, true); this.root.classList.remove('has-spatial-content', 'has-fixed-panels'); this.root.removeEventListener('pointerdown', this.routePointer, true); this.root.removeEventListener('click', this.routeClick, true); this.root.removeEventListener('wheel', this.routeWheel, true); this.close(); this.treeResize?.disconnect(); this.panelResize?.disconnect(); this.entries.forEach(e => e.runtime.dispose()); this.viewer.renderListeners.delete(this.render); this.viewport.removeEventListener('change', this.viewportChanged); this.viewer.entityUpdates = undefined; this.viewer.setReservedSpace(0); this.root.closest<HTMLElement>('.app-shell')?.style.removeProperty('--fixed-panel-space'); this.root.classList.remove('composited-content'); this.compositor.remove(); this.panelRoot.remove(); this.panelEdge.remove(); this.planes.clear(); this.bands.length = 0; this.groupLabels.remove(); this.tree.remove(); this.toggle.remove(); this.dialog.remove(); }
}

export class SurfaceRuntime implements ComponentRuntime {
  readonly element = document.createElement('section');
  private readonly wrapper = document.createElement('div');
  private readonly panelWrapper = document.createElement('div');
  readonly object?: CSS3DObject;
  private readonly worldPosition = new THREE.Vector3();
  private visible = true;
  get spatialObject(): CSS3DObject | undefined { return this.mode === 'spatial' && this.spec.placement === 'world' && this.visible ? this.object : undefined; }
  get hasNative(): boolean { return !!this.content.native; }
  get isNativeSpatial(): boolean { return this.hasNative && this.mode === 'spatial' && this.spec.placement === 'world'; }
  private readonly content: SurfaceContent;
  private readonly body = document.createElement('div');
  private readonly header = document.createElement('header');
  private readonly menu = document.createElement('div');
  private readonly overflow: HTMLButtonElement;
  private readonly expand: HTMLButtonElement;
  private annotations?: ContentAnnotations;
  private readonly state: ContentState;
  private mode: Presentation = 'spatial';
  private gesture?: AbortController;
  private pointer?: number;
  private pendingReading?: ContentAnchor;
  private resize?: ResizeObserver;
  private settleFrame = 0;
  private settlement?: Promise<void>;
  private resolveSettlement?: () => void;
  private nativeWidth = 0;
  private nativeHeight = 0;
  private selectionButton?: HTMLButtonElement;
  private viewKey?: string;
  private contentReady = false;
  private loadError?: string;
  private initializingContent = true;
  private readonly ray = new THREE.Raycaster();
  private readonly rayPointer = new THREE.Vector2();
  private screenScale = 1;
  private readonly projectedOrigin = new THREE.Vector3();
  private readonly projectedX = new THREE.Vector3();
  private readonly projectedY = new THREE.Vector3();
  private readonly surfacePlane = new THREE.Plane();
  private readonly surfacePoint = new THREE.Vector3();
  constructor(private readonly spec: SceneEntity, private readonly context: Context, factory: ContentFactory) {
    const {host, scene} = context; this.element.className = 'scene-surface'; this.element.dataset.component = spec.component;
    this.header.className = 'component-handle'; this.header.title = spec.label;
    const label = document.createElement('span'); label.textContent = spec.label; this.header.append(label);
    const source = scene.attachments?.[spec.source.index];
    this.content = source?.url ? factory(source.url, spec.label, spec, context) : {element: document.createElement('p'), ready: Promise.reject(new Error('资源不可用')), dispose() {}};
    this.state = (spec.state ?? {}) as ContentState;
    void this.content.ready.then(async () => {
      if (this.hasNative) { this.settle(); await this.whenSettled(); }
      this.contentReady = true; this.initializingContent = false; host.contentChanged(spec.id);
    }, error => { this.loadError = error instanceof Error ? error.message : String(error); host.contentChanged(spec.id); });
    if (!source?.url) this.content.element.textContent = source?.unavailable ?? '资源不可用';
    this.body.className = 'component-body'; this.body.append(this.content.element);
    this.expand = button('全屏', () => {
      if (this.mode !== 'spatial') host.returnToScene();
      else if (this.hasNative) host.present(spec, 'fullscreen');
      else host.open(spec);
    });
    this.expand.setAttribute('aria-label', `全屏 ${spec.label}`);
    this.menu.className = 'component-overflow'; this.menu.hidden = true; this.menu.setAttribute('aria-label', `${spec.label} 内容操作`);
    this.overflow = button('更多', () => this.showMenu(this.menu.hidden)); this.overflow.setAttribute('aria-expanded', 'false');
    const placement = button(spec.placement === 'panel' ? '放回场景' : '固定面板', () => {
      host.placementEntity(spec.id, spec.placement === 'panel' ? 'world' : 'panel');
      placement.textContent = spec.placement === 'panel' ? '放回场景' : '固定面板';
    });
    placement.className = 'content-placement'; this.menu.append(placement);
    this.header.append(this.expand, this.overflow); this.element.append(this.header, this.body, this.menu);
    this.wrapper.className = 'component-world-wrapper'; this.wrapper.append(this.element);
    if (context.viewer.kind === 'spatial') { this.object = new CSS3DObject(this.wrapper); host.layer.add(this.object); }
    this.mount();
    this.header.style.touchAction = 'none';
    this.setPosition(spec.position ?? [0, 0, 0]); this.setOpacity(spec.opacity); this.size();
    // Opaque frames retain scene-owned preview input; native bodies never get this overlay.
    if (!this.content.native) {
      const enter = button(`选中 ${spec.label}`, () => host.select(spec)); enter.className = 'component-enter'; enter.setAttribute('aria-label', `选中 ${spec.label}，双击展开`); enter.textContent = ''; this.body.append(enter);
      let navigating = false, previewGesture: AbortController | undefined;
      enter.onclick = () => { if (!navigating) host.select(spec); };
      enter.addEventListener('dblclick', event => { event.preventDefault(); host.open(spec); });
      enter.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); host.open(spec); } });
      enter.addEventListener('pointerdown', event => {
        if (event.isPrimary) {
          previewGesture?.abort(); previewGesture = new AbortController(); navigating = false;
          const x = event.clientX, y = event.clientY;
          window.addEventListener('pointermove', move => { if (Math.hypot(move.clientX - x, move.clientY - y) > 6) navigating = true; }, {signal: previewGesture.signal});
          window.addEventListener('pointerup', () => previewGesture?.abort(), {once: true, signal: previewGesture.signal});
          window.addEventListener('pointercancel', () => { navigating = true; previewGesture?.abort(); }, {once: true, signal: previewGesture.signal});
        } else navigating = true;
        host.select(spec); if (spec.placement === 'world') context.viewer.navigatePointer(event);
      });
      enter.addEventListener('wheel', event => { if (spec.placement === 'world') { event.preventDefault(); context.viewer.navigateWheel(event); } }, {passive: false});
      this.content.element.inert = spec.placement === 'world';
    }
    this.header.addEventListener('dblclick', event => { if (!(event.target as Element).closest('button')) { event.preventDefault(); host.open(spec); } });
    this.header.addEventListener('pointerdown', event => {
      host.select(spec);
      if (!(event.target as Element).closest('button') && this.mode === 'spatial' && spec.placement === 'world') context.viewer.navigatePointer(event);
      else event.stopPropagation();
    });
    this.header.addEventListener('wheel', event => { event.preventDefault(); event.stopPropagation(); if (this.mode === 'spatial' && spec.placement === 'world') context.viewer.navigateWheel(event); }, {passive: false});
    this.menu.addEventListener('pointerdown', event => event.stopPropagation());
    this.menu.addEventListener('wheel', event => event.stopPropagation(), {passive: true});
    this.element.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.menu.hidden) { event.preventDefault(); event.stopPropagation(); this.closeAnnotation(); this.showMenu(false); this.overflow.focus(); }
    });
    document.addEventListener('pointerdown', this.dismissMenu);
    this.bindNative();
  }
  snapshot(): ContentSnapshot {
    const native = this.content.native;
    return {id: this.spec.id, native: !!native, ready: this.contentReady, presentation: this.mode, menu: !this.menu.hidden,
      ...(this.loadError ? {unavailable: 'Content resource is unavailable'} : {}),
      ...(native ? {state: structuredClone(this.state)} : {}),
      capabilities: {reading: !!native, selection: !!native, zoom: !!native?.zoom, fit: !!native?.fit, json: !!native?.json, annotations: !!this.annotations},
      targets: native?.catalogTargets?.() ?? [], layers: native?.layers ?? [], branches: native?.json?.branches() ?? [],
      ...(native?.targetRange ? {targetRange: native.targetRange} : {}),
      ...(this.annotations ? {annotation: this.annotations.toolbarState} : {})};
  }
  private requireNative(): NativeContent {
    if (!this.content.native) throw new OperationError('UNSUPPORTED', 'Opaque content has no native reading capabilities', {target: this.spec.id});
    if (this.loadError) throw new OperationError('RESOURCE_UNAVAILABLE', this.loadError, {target: this.spec.id});
    if (!this.contentReady) throw new OperationError('NOT_READY', 'Content is still loading', {target: this.spec.id, retryable: true});
    return this.content.native;
  }
  setReading(anchor: ContentAnchor): void {
    const native = this.requireNative();
    if (!(native.acceptsAnchor?.(anchor) ?? !!native.locate(anchor))) throw new OperationError('INVALID_ARGUMENT', 'Anchor does not belong to available source content', {field: 'anchor', target: this.spec.id});
    if (!updateContentState(this.state, {reading: anchor}, this.content.element)) throw new OperationError('INVALID_ARGUMENT', 'Content reading cannot be persisted');
    this.context.host.commitContent(() => { this.cancelContentGesture(); this.pendingReading = undefined; native.restore(anchor); this.changed(); });
  }
  async scrollContent(x: number, y: number, relative = false): Promise<void> {
    const native = this.requireNative();
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new OperationError('INVALID_ARGUMENT', 'Scroll offsets must be finite CSS pixels');
    // Explicit offsets belong to the final native layout, not transient chrome.
    this.cancelContentGesture(); this.pendingReading = undefined;
    await this.whenSettled();
    this.context.host.commitContent(() => {
      this.pendingReading = undefined;
      native.scroll.scrollLeft = relative ? native.scroll.scrollLeft + x : x;
      native.scroll.scrollTop = relative ? native.scroll.scrollTop + y : y;
      this.readingChanged();
      this.settle();
    });
    await this.whenSettled();
  }
  setSelection(enabled: boolean): void {
    const native = this.content.native;
    if (!native) throw new OperationError('UNSUPPORTED', 'Content cannot select native text', {target: this.spec.id});
    if (!updateContentState(this.state, {selection: enabled}, this.content.element)) throw new OperationError('INVALID_ARGUMENT', 'Content selection cannot be persisted');
    this.context.host.commitContent(() => {
      this.annotations?.close(); native.setSelection(enabled);
      this.element.classList.toggle('content-selecting', enabled); this.selectionButton?.setAttribute('aria-pressed', String(enabled));
    });
  }
  jsonExpand(path: string, expanded: boolean): void {
    const native = this.requireNative();
    if (!native.json) throw new OperationError('UNSUPPORTED', 'Content has no JSON tree', {target: this.spec.id});
    native.json.setExpanded(path, expanded);
    this.settle();
  }
  jsonPage(path: string): void {
    const native = this.requireNative();
    if (!native.json) throw new OperationError('UNSUPPORTED', 'Content has no JSON tree', {target: this.spec.id});
    native.json.page(path);
    this.settle();
  }
  zoom(factor: number): void {
    const native = this.requireNative();
    if (!native.zoom) throw new OperationError('UNSUPPORTED', 'Content cannot zoom', {target: this.spec.id});
    if (!Number.isFinite(factor) || factor <= 0) throw new OperationError('INVALID_ARGUMENT', 'Zoom factor must be positive', {field: 'factor'});
    this.context.host.commitContent(() => native.zoom!(factor));
    this.settle();
  }
  fit(): void {
    const native = this.requireNative();
    if (!native.fit) throw new OperationError('UNSUPPORTED', 'Content cannot fit', {target: this.spec.id});
    this.context.host.commitContent(() => native.fit!());
    this.settle();
  }
  setLayer(id: string): void {
    const native = this.requireNative();
    if (!native.layers?.some(layer => layer.id === id) || !native.setLayer) throw new OperationError('INVALID_ARGUMENT', 'Unknown content layer', {target: id});
    this.context.host.commitContent(() => {
      this.cancelContentGesture(); native.setLayer!(id); this.pendingReading = this.state.reading;
      const select = this.menu.querySelector<HTMLSelectElement>('.content-layer-select select'); if (select) select.value = id;
      this.settle(); this.annotations?.refresh();
    });
  }
  annotationEditor(): ContentAnnotations {
    this.requireNative();
    if (!this.annotations) throw new OperationError('UNSUPPORTED', 'Content has no annotations', {target: this.spec.id});
    return this.annotations;
  }
  private bindNative(): void {
    const native = this.content.native; if (!native) return;
    this.element.classList.add('native-surface');
    this.spec.state = this.state;
    this.content.element.addEventListener('contentstatechange', this.nativeStateChanged);
    native.scroll.addEventListener('dblclick', this.contentDoubleClick);
    native.setSelection(this.state.selection === true); this.element.classList.toggle('content-selecting', this.state.selection === true);
    const selection = button('选择文字', () => {
      this.setSelection(!this.state.selection); selection.setAttribute('aria-pressed', String(this.state.selection)); this.showMenu(false);
    });
    selection.setAttribute('aria-pressed', String(this.state.selection)); this.menu.append(selection);
    this.selectionButton = selection;
    this.menu.append(button('聚焦内容', () => { this.focus(); this.showMenu(false); }), button('添加内容标注', () => this.annotate()), button('屏幕画笔', () => { this.closeAnnotation(); this.showMenu(false); this.context.host.onScreenAnnotation?.(); }));
    if (native.zoom) {
      const zoom = document.createElement('div'); zoom.className = 'content-tool-row';
      for (const [label, factor] of [['缩小', .8], ['放大', 1.25]] as const) zoom.append(button(label, () => {
        this.zoom(factor);
      }));
      this.menu.append(zoom);
      if (native.fit) this.menu.append(button('适应内容', () => this.fit()));
    }
    this.annotations = new ContentAnnotations(native, this.state, this.body, this.changed, mutation => this.context.host.commitContent(mutation)); this.menu.append(this.annotations.tools);
    const addLayers = () => {
      if (!native.layers?.length || this.menu.querySelector('.content-layer-select')) return;
      const label = document.createElement('label'); label.className = 'content-layer-select'; label.textContent = '图层';
      const select = document.createElement('select'); select.setAttribute('aria-label', '图层');
      for (const layer of native.layers) { const option = document.createElement('option'); option.value = layer.id; option.textContent = layer.label; select.append(option); }
      select.value = this.state.layer ?? native.layers[0].id;
      select.addEventListener('change', () => {
        this.setLayer(select.value);
      }); label.append(select); this.menu.prepend(label);
    };
    addLayers(); void this.content.ready.then(() => {
      addLayers(); this.annotations?.refresh(); this.settle();
    }, () => {});
    native.scroll.addEventListener('pointerdown', this.contentPointer);
    native.scroll.addEventListener('wheel', this.contentWheel, {passive: false});
    this.resize = new ResizeObserver(() => {
      const width = native.scroll.clientWidth, height = native.scroll.clientHeight;
      if (width !== this.nativeWidth || height !== this.nativeHeight) {
        if (!this.initializingContent && this.nativeWidth && this.nativeHeight) this.context.host.onContentViewChange?.();
        this.pendingReading ??= this.state.reading;
        this.nativeWidth = width; this.nativeHeight = height;
        this.settle();
      }
      this.annotations?.refresh();
    }); this.resize.observe(native.scroll);
    this.pendingReading = this.state.reading; this.settle();
  }
  private changed = (): void => { this.content.element.dispatchEvent(new CustomEvent('contentstatechange', {bubbles: true})); };
  private nativeStateChanged = (): void => {
    this.element.classList.toggle('content-selecting', this.state.selection === true);
    const viewKey = JSON.stringify([this.state.reading, this.state.zoom, this.state.expanded, this.state.layer, this.state.presentation]);
    if (!this.initializingContent && this.viewKey !== undefined && this.viewKey !== viewKey) this.context.host.onContentViewChange?.();
    this.viewKey = viewKey;
    this.annotations?.refresh(); this.context.host.contentChanged(this.spec.id);
  };
  private contentDoubleClick = (event: MouseEvent): void => {
    if (this.mode !== 'spatial' || this.state.selection || this.annotations?.active || event.target instanceof Element && event.target.closest('a, button, input, select, textarea, summary')) return;
    event.preventDefault(); event.stopPropagation(); this.context.host.open(this.spec);
  };
  private readingChanged = (): void => {
    if (!this.pendingReading) { const reading = this.content.native?.capture(); if (reading && !updateContentState(this.state, {reading}, this.content.element)) return; this.changed(); }
  };
  showMenu(open: boolean): void {
    if (this.menu.hidden === !open) return;
    this.menu.hidden = !open; this.overflow.setAttribute('aria-expanded', String(open)); this.context.host.contentChanged(this.spec.id);
  }
  private dismissMenu = (event: PointerEvent): void => { if (event.target instanceof Node && !this.element.contains(event.target)) this.showMenu(false); };
  annotate(): boolean {
    if (!this.annotations) return false;
    if (!updateContentState(this.state, {selection: false}, this.content.element)) throw new OperationError('INVALID_ARGUMENT', 'Content annotation state cannot be persisted');
    return this.context.host.commitContent(() => {
      this.context.host.select(this.spec); this.element.classList.remove('content-selecting');
      this.menu.querySelector<HTMLButtonElement>('button[aria-pressed]')?.setAttribute('aria-pressed', 'false');
      this.showMenu(true); this.annotations!.open(); this.changed(); this.content.native!.scroll.focus({preventScroll: true}); return true;
    });
  }
  closeAnnotation(): void { this.context.host.commitContent(() => { this.annotations?.close(); this.content.native?.setSelection(this.state.selection === true); }); }
  cancelContentGesture(): void {
    const pointer = this.pointer; this.pointer = undefined;
    this.gesture?.abort(); this.gesture = undefined;
    if (pointer !== undefined && this.content.native?.scroll.hasPointerCapture(pointer)) this.content.native.scroll.releasePointerCapture(pointer);
    this.annotations?.cancel();
  }
  private contentPointer = (event: PointerEvent): void => {
    const native = this.content.native!; this.context.host.select(this.spec); event.stopPropagation();
    if (event.button !== 0 || event.target instanceof Element && event.target.closest('a, button, input, select, textarea, summary, [contenteditable=\"true\"]') || this.state.selection && !this.annotations?.active) return;
    if (!event.isPrimary) return;
    const start = this.local(event.clientX, event.clientY); if (!start) return;
    event.preventDefault(); this.cancelContentGesture(); this.pointer = event.pointerId; this.gesture = new AbortController();
    const signal = this.gesture.signal; let previous = start;
    const marking = this.annotations?.active === true;
    if (marking) this.annotations!.begin(start.x, start.y);
    native.scroll.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', move => {
      if (move.pointerId !== this.pointer) return;
      move.preventDefault(); move.stopImmediatePropagation();
      const point = this.local(move.clientX, move.clientY); if (!point) return;
      if (marking) this.annotations!.move(point.x, point.y);
      else { native.scroll.scrollLeft += previous.x - point.x; native.scroll.scrollTop += previous.y - point.y; }
      previous = point;
    }, {capture: true, passive: false, signal});
    window.addEventListener('pointerup', up => {
      if (up.pointerId !== this.pointer) return;
      up.preventDefault(); up.stopImmediatePropagation(); if (marking) this.annotations!.end(); else this.readingChanged(); this.cancelContentGesture();
    }, {capture: true, signal});
    window.addEventListener('pointercancel', cancel => { if (cancel.pointerId === this.pointer) this.cancelContentGesture(); }, {capture: true, signal});
    native.scroll.addEventListener('lostpointercapture', () => this.cancelContentGesture(), {once: true, signal});
  };
  private contentWheel = (event: WheelEvent): void => {
    event.stopPropagation();
    if (event.defaultPrevented) return;
    event.preventDefault();
    const native = this.content.native!; const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? native.scroll.clientHeight : 1;
    native.scroll.scrollLeft += event.deltaX * unit; native.scroll.scrollTop += event.deltaY * unit;
  };
  private local(x: number, y: number): {x: number; y: number} | undefined {
    const scroll = this.content.native!.scroll;
    if (this.mode !== 'spatial' || this.spec.placement === 'panel' || this.context.viewer.kind === 'board') {
      const rect = scroll.getBoundingClientRect();
      const scale = this.mode === 'spatial' && this.spec.placement === 'world' && this.context.viewer.kind === 'board' ? this.context.viewer.scale * (this.spec.size?.[0] ?? 110) / 800 : 1;
      return {x: (x - rect.left) / scale, y: (y - rect.top) / scale};
    }
    if (!this.object) return;
    const rect = this.context.host.root.getBoundingClientRect();
    this.ray.setFromCamera(this.rayPointer.set((x - rect.left) / this.context.viewer.viewportWidth * 2 - 1, 1 - (y - rect.top) / rect.height * 2), this.context.viewer.activeCamera);
    this.object.updateWorldMatrix(true, false);
    this.surfacePlane.setComponents(0, 0, 1, 0).applyMatrix4(this.object.matrixWorld);
    const point = this.ray.ray.intersectPlane(this.surfacePlane, this.surfacePoint); if (!point) return;
    this.object.worldToLocal(point);
    let left = 0, top = 0, element: HTMLElement | null = scroll;
    while (element && element !== this.wrapper) { left += element.offsetLeft; top += element.offsetTop; element = element.offsetParent as HTMLElement | null; }
    return {x: point.x + this.wrapper.clientWidth / 2 - left, y: -point.y + this.wrapper.clientHeight / 2 - top};
  }
  get ready(): Promise<void> { return this.content.ready.then(() => this.whenSettled()); }
  get bounds(): THREE.Box3 {
    const [w, h] = this.spec.size ?? [110,70]; const p = this.worldPosition;
    return new THREE.Box3(new THREE.Vector3(p.x - w / 2, p.y - h / 2, p.z - .1), new THREE.Vector3(p.x + w / 2, p.y + h / 2, p.z + .1));
  }
  setPosition(position: Vec3): void {
    this.worldPosition.fromArray(position); this.object?.position.fromArray(position);
    if (this.context.viewer.kind === 'board') this.size();
  }
  setVisible(visible: boolean): void {
    // CSS3DRenderer skips disconnected invisible objects; DOM owns hiding so
    // even initially hidden plugin frames mount once and retain their state.
    const changed = visible !== this.visible;
    this.visible = visible;
    this.wrapper.hidden = this.spec.placement === 'panel' || !visible;
    this.panelWrapper.hidden = this.spec.placement !== 'panel' || !visible;
    this.element.hidden = this.mode === 'spatial' && !visible;
    if (changed && this.hasNative) this.settle();
  }
  setOpacity(opacity: number): void { this.element.style.opacity = String(opacity); }
  setLabel(label: string): void {
    this.header.querySelector<HTMLElement>('span')!.textContent = label; this.header.title = label;
    this.body.querySelector<HTMLButtonElement>('.component-enter')?.setAttribute('aria-label', `选中 ${label}，双击展开`);
    this.expand.setAttribute('aria-label', this.mode === 'spatial' ? `全屏 ${label}` : '返回场景');
  }
  occludedAt(x: number, y: number): boolean {
    if (this.mode !== 'spatial' || this.spec.placement === 'panel' || this.context.viewer.kind !== 'spatial' || !this.object) return false;
    const rect = this.context.host.root.getBoundingClientRect();
    this.ray.setFromCamera(this.rayPointer.set((x-rect.left)/this.context.viewer.viewportWidth*2-1, 1-(y-rect.top)/rect.height*2), this.context.viewer.activeCamera);
    this.object.updateWorldMatrix(true, false);
    this.surfacePlane.setComponents(0, 0, 1, 0).applyMatrix4(this.object.matrixWorld);
    const point = this.ray.ray.intersectPlane(this.surfacePlane, this.surfacePoint);
    return !!point && this.context.viewer.geometryOccludes(x, y, point.toArray() as Vec3);
  }
  select(): void { this.element.classList.add('selected'); }
  async focus(): Promise<ViewMutation> {
    const mutation = await this.context.host.focusEntities([this.spec.id]);
    await this.context.host.whenSettled();
    return mutation;
  }
  focusPanel(): void {
    if (this.content.native) this.content.native.scroll.focus({preventScroll: true});
    else { this.element.tabIndex = -1; this.element.focus({preventScroll: true}); }
  }
  validatePresentation(mode: Presentation): void {
    if (!this.hasNative) return;
    const reading = this.pendingReading ?? this.content.native?.capture();
    try { validateContentState({...this.state, ...(reading ? {reading} : {}), presentation: mode}); }
    catch (error) { throw new OperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)); }
  }
  preparePresentation(mode?: Presentation): boolean {
    this.cancelContentGesture();
    const reading = this.pendingReading ?? this.content.native?.capture();
    if (this.hasNative && !updateContentState(this.state, {...(reading ? {reading} : {}), ...(mode ? {presentation: mode} : {})}, this.content.element)) return false;
    if (reading) this.pendingReading = reading;
    return true;
  }
  setPresentation(mode: Presentation): void {
    if (!this.preparePresentation(mode)) return;
    this.mode = mode;
    this.context.viewer.invalidate(); this.element.classList.toggle('expanded', mode !== 'spatial');
    this.expand.textContent = mode === 'spatial' ? '全屏' : '返回'; this.expand.setAttribute('aria-label', mode === 'spatial' ? `全屏 ${this.spec.label}` : '返回场景');
    this.content.element.inert = !this.hasNative && mode === 'spatial' && this.spec.placement === 'world';
    if (mode === 'spatial') moveElement(this.spec.placement === 'panel' ? this.panelWrapper : this.wrapper, this.element);
    this.element.hidden = mode === 'spatial' && !this.visible;
    this.content.present?.(mode); this.settle(); this.changed(); if (!this.hasNative) this.context.host.contentChanged(this.spec.id);
  }
  async whenSettled(): Promise<void> { while (this.settlement) await this.settlement; }
  private settle(): void {
    if (!this.settlement) {
      const {promise, resolve} = Promise.withResolvers<void>();
      this.settlement = promise; this.resolveSettlement = resolve;
    }
    if (this.settleFrame) cancelAnimationFrame(this.settleFrame);
    // Resize delivery may restart this sequence; only the final layout can commit.
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = requestAnimationFrame(() => {
        const native = this.content.native;
        if (native && this.pendingReading && native.scroll.clientWidth && native.scroll.clientHeight) {
          native.restore(this.pendingReading); this.pendingReading = undefined;
        }
        // Native restore consumes its own scroll events in the following frame.
        this.settleFrame = requestAnimationFrame(() => {
          this.settleFrame = 0; this.annotations?.refresh();
          const resolve = this.resolveSettlement; this.resolveSettlement = undefined; this.settlement = undefined;
          resolve?.();
        });
      });
    });
  }
  updateBoardScale(viewportScale: number): void {
    const scale = this.mode === 'spatial' && this.spec.placement === 'world' ? Math.min(8, Math.max(.5, 800 / ((this.spec.size?.[0] ?? 110) * viewportScale))) : 1;
    if (Math.abs(scale - this.screenScale) < .01) return;
    // Board framing is affine. Only screen-sized chrome changes; native source
    // dimensions and reading anchors must not be recaptured or restored.
    this.screenScale = scale; this.element.style.setProperty('--content-ui-scale', String(scale));
  }
  updateScreenScale(camera: THREE.Camera, width: number, height: number): void {
    if (!this.hasNative) return;
    let scale = 1;
    if (this.mode === 'spatial' && this.spec.placement === 'world' && this.object) {
      this.object.updateWorldMatrix(true, false);
      this.object.localToWorld(this.projectedOrigin.set(0, 0, 0)).project(camera);
      this.object.localToWorld(this.projectedX.set(1, 0, 0)).project(camera);
      this.object.localToWorld(this.projectedY.set(0, 1, 0)).project(camera);
      const x = Math.hypot((this.projectedX.x - this.projectedOrigin.x) * width / 2, (this.projectedX.y - this.projectedOrigin.y) * height / 2);
      const y = Math.hypot((this.projectedY.x - this.projectedOrigin.x) * width / 2, (this.projectedY.y - this.projectedOrigin.y) * height / 2);
      scale = Math.min(8, Math.max(.5, 1 / Math.max(.001, Math.min(x, y))));
    }
    if (Math.abs(scale - this.screenScale) < .01) return;
    if (!this.preparePresentation()) return;
    this.screenScale = scale; this.element.style.setProperty('--content-ui-scale', String(scale));
    this.settle();
  }
  private mount(): void {
    this.panelWrapper.className = 'panel-wrapper'; this.panelWrapper.hidden = this.spec.placement !== 'panel' || !this.visible;
    if (!this.panelWrapper.parentElement) this.context.host.panelRoot.append(this.panelWrapper);
    if (this.context.viewer.kind === 'board' && !this.wrapper.parentElement) this.context.viewer.stage.append(this.wrapper);
    if (this.spec.placement === 'panel') {
      if (this.mode === 'spatial') moveElement(this.panelWrapper, this.element);
      this.wrapper.hidden = true;
    } else {
      if (this.mode === 'spatial') moveElement(this.wrapper, this.element);
      this.wrapper.hidden = !this.visible;
    }
    this.element.classList.toggle('panel-surface', this.spec.placement === 'panel');
  }
  setPlacement(placement: 'world' | 'panel'): void {
    if (!this.preparePresentation()) throw new OperationError('INVALID_ARGUMENT', 'Content state cannot be persisted');
    this.spec.placement = placement; this.mount(); this.size(); this.setVisible(this.visible);
    this.content.element.inert = !this.hasNative && this.mode === 'spatial' && placement === 'world';
    const button = this.menu.querySelector<HTMLButtonElement>('.content-placement'); if (button) button.textContent = placement === 'panel' ? '放回场景' : '固定面板';
    this.settle();
  }
  private size(): void {
    const [w,h] = this.spec.size ?? [110,70], p = this.worldPosition;
    this.wrapper.style.width = '800px'; this.wrapper.style.height = `${800 * h / w}px`;
    this.panelWrapper.style.height = 'min(65vh, 520px)';
    // CSS3DRenderer owns and caches the spatial wrapper matrix, even while its
    // content is in a panel/dialog. Clearing it leaves the next render unscaled.
    if (this.context.viewer.kind === 'board') this.wrapper.style.transform = this.spec.placement === 'world'
      ? `translate(${p.x - w / 2}px,${p.y + h / 2}px) scale(${w / 800},${-w / 800})` : '';
    this.object?.scale.setScalar(w / 800); this.context.viewer.invalidate();
  }
  dispose(): void {
    this.cancelContentGesture(); if (this.settleFrame) cancelAnimationFrame(this.settleFrame); this.resize?.disconnect(); this.annotations?.dispose();
    this.resolveSettlement?.(); this.resolveSettlement = undefined; this.settlement = undefined;
    const native = this.content.native; native?.scroll.removeEventListener('pointerdown', this.contentPointer); native?.scroll.removeEventListener('wheel', this.contentWheel);
    native?.scroll.removeEventListener('dblclick', this.contentDoubleClick); this.content.element.removeEventListener('contentstatechange', this.nativeStateChanged);
    document.removeEventListener('pointerdown', this.dismissMenu); this.content.dispose(); this.object?.removeFromParent(); this.wrapper.remove(); this.panelWrapper.remove(); this.element.remove();
  }
}
function button(text: string, action: () => void): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = action; return button; }
function moveElement(parent: HTMLElement, element: HTMLElement): void {
  // Preserve iframe browsing context on browsers supporting state-preserving moves.
  const movable = parent as HTMLElement & {moveBefore?: (node: Node, child: Node | null) => void};
  if (movable.moveBefore && parent.isConnected && element.isConnected) movable.moveBefore(element, null); else parent.append(element);
}
