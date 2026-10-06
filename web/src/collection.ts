import './collection.css';
import {loadCollection, shareCollection, type CollectionOverview, type SceneUpdate, type ShareResponse, type ScreenStroke, type CollectionLayout, type Shading, type Projection, type RenderMode} from './api';
import {MarkupCanvas} from './markup';
import {takeInitialScene} from './bootstrap';
import {installIcons} from './icons';
import {OperationError, OperationHost, type OperationEvent, type Operation} from './operations/core';
import {connectWindowOperations, publishOperations, type OperationClient} from './operations/transport';
import {registerCollectionOperations, type CollectionState, type CollectionCopyResult} from './operations/collection';
import type {AnnotationToolbarState} from './annotations/editor';
import {createAnnotationToolbar} from './annotations/toolbar';
import {annotationOperations} from './operations/annotations';
import {sectionOperations} from './operations/section';
import {viewOperations, type ViewSnapshot} from './operations/view';
import {workbenchOperations, type WorkbenchState} from './operations/workbench';

const token = location.pathname.match(/\/s\/([^/]+)$/)?.[1] ?? '';
if (!token) throw new Error('Missing collection token');
const owner = sessionStorage.getItem(`blind.owner.${token}`) ?? undefined;
const originalDock = document.querySelector<HTMLElement>('.review-dock')!;
const originalShare = originalDock.querySelector<HTMLButtonElement>('#share-view')!;
const mainDock = originalDock.querySelector<HTMLElement>('.dock-main')!;
const observeDock = originalDock.querySelector<HTMLElement>('.dock-observe')!;
const observeTrigger = originalDock.querySelector<HTMLButtonElement>('#observe-trigger')!;
const observeBack = originalDock.querySelector<HTMLButtonElement>('#observe-back')!;
originalShare.setAttribute('aria-label', '分享全部场景');
const shell = document.createElement('div'); shell.className = 'app-shell collection-shell';
const sceneTabs = document.createElement('nav'); sceneTabs.className = 'collection-scene-tabs'; sceneTabs.setAttribute('role', 'tablist'); sceneTabs.setAttribute('aria-label', '场景切换');
const tabs = new Map<string, HTMLButtonElement>();
const expandButtons = new Map<string, HTMLButtonElement>();
sceneTabs.addEventListener('keydown', event => {
  const index = overview.scenes.findIndex(scene => scene.id === active);
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.size : event.key === 'ArrowLeft' ? (index + tabs.size - 1) % tabs.size : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.size - 1 : undefined;
  if (next === undefined) return;
  event.preventDefault(); tabs.get(overview.scenes[next].id)?.focus();
});
const stage = document.createElement('main'); stage.className = 'collection-stage'; stage.setAttribute('aria-label', '多场景视图');
const inkCanvas = document.createElement('canvas'); inkCanvas.className = 'markup-canvas collection-markup'; inkCanvas.setAttribute('aria-label', '全部场景屏幕画笔');
const inkBadges = document.createElement('div'); inkBadges.className = 'collection-ink-badges';
stage.append(inkCanvas, inkBadges);
const dialog = document.createElement('dialog'); dialog.className = 'collection-share';
const toast = document.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status');
shell.append(sceneTabs, stage, originalDock, dialog, toast); document.body.replaceChildren(shell);
installIcons(shell);

let overview: CollectionOverview;
let active = new URLSearchParams(location.search).get('scene') ?? '';
let mode: 'split' | 'single' = 'single';
let maximized = false;
let cards = new Map<string, HTMLElement>();
let frames = new Map<string, HTMLIFrameElement>();
let ready = new Set<string>();
const clients = new Map<string, OperationClient>();
let copySequence = 0;
let shareLinks: ShareResponse | undefined;
let toastTimer = 0;
let layoutFrame = 0;
let activated: string | undefined;
const observeStates = new Map<string, {open: boolean; category: string | null}>();
const annotationStates = new Map<string, AnnotationToolbarState>();
const viewStates = new Map<string, ViewSnapshot>();
const host = new OperationHost({sceneId: `collection:${token}`, ready: () => !!overview});
const disposePage = publishOperations(host);
let toolbar: HTMLElement | undefined;
type AnnotationMode = 'select' | 'point' | 'line' | 'screen';
let annotationMode: AnnotationMode | null = null;
let observeOpen = false;
let activeObserveCategory: string | null = null;
let color = '#ff6b5e';
let selectedStroke: string | undefined;
let strokeBefore: ScreenStroke[] | undefined;
let strokeLayout: CollectionLayout | undefined;
let parkedViewChanged = false;
const strokeHistory: ScreenStroke[][] = [];
const strokeFuture: ScreenStroke[][] = [];
const markup = new MarkupCanvas(inkCanvas);
markup.onStrokeStart = () => {strokeBefore = markup.exportStrokes(); selectedStroke = undefined;};
markup.onStrokeEnd = () => {
  if (strokeBefore && markup.exportStrokes().length > strokeBefore.length) {
    strokeHistory.push(strokeBefore); if (strokeHistory.length > 40) strokeHistory.shift(); strokeFuture.length = 0;
    selectedStroke = markup.exportStrokes().at(-1)?.id;
    strokeLayout = captureLayout();
  }
  strokeBefore = undefined; syncToolbar(); host.notify('annotation', annotationState());
};
markup.onChange = () => {shareLinks = undefined; renderInkBadges(); syncToolbar();};

function sceneClient(id: string): OperationClient {
  if (!cards.has(id)) throw new OperationError('INVALID_ARGUMENT', 'Unknown collection scene', {field: 'sceneId', target: id});
  const client = clients.get(id);
  if (!client || !ready.has(id)) throw new OperationError('NOT_READY', 'Scene is not ready', {target: id, retryable: true});
  return client;
}
async function runScene<P, R>(id: string, operation: Operation<P, R>, params: P): Promise<R> {
  return await sceneClient(id).run(operation, params);
}
function report(error: unknown): void {notify(error instanceof Error ? error.message : String(error));}
function ui(action: Promise<unknown>): void {void action.catch(report);}
async function sendScope(id: string): Promise<void> {
  await runScene(id, workbenchOperations.screenScope, {scope: mode === 'single' ? 'scene' : 'collection'});
}
async function refreshSceneState(id: string): Promise<void> {
  const [annotation, view] = await Promise.all([
    runScene(id, annotationOperations.get, {}), runScene(id, viewOperations.get, {}),
  ]);
  annotationStates.set(id, annotation);
  viewStates.set(id, view);
  if (id === active) {applyAnnotationState(); syncObserveMode();}
}
function captureLayout(): CollectionLayout {
  const rect = stage.getBoundingClientRect();
  if (mode === 'single') {
    const columns = Math.ceil(Math.sqrt(overview.scenes.length));
    const rows = Math.ceil(overview.scenes.length / columns);
    let tileWidth = Math.round(rect.width), tileHeight = Math.round(rect.height);
    const extent = (width:number, height:number) => ({width:columns*width+columns-1, height:rows*height+rows-1});
    const full = extent(tileWidth, tileHeight);
    const scale = Math.min(1,4096/full.width,4096/full.height,Math.sqrt(16_000_000/(full.width*full.height)));
    tileWidth = Math.max(160,Math.floor(tileWidth*scale)); tileHeight = Math.max(135,Math.floor(tileHeight*scale));
    return {columns,...extent(tileWidth,tileHeight)};
  }
  return {width:Math.round(rect.width),height:Math.round(rect.height),columns:getComputedStyle(stage).gridTemplateColumns.split(' ').length};
}
function rememberStrokes(): void {strokeHistory.push(markup.exportStrokes()); if (strokeHistory.length > 40) strokeHistory.shift(); strokeFuture.length = 0;}
function invalidateCollectionInk(): void {
  if (!markup.hasStrokes && !strokeHistory.length && !strokeFuture.length && !strokeBefore) return;
  selectedStroke = undefined; strokeBefore = undefined; strokeLayout = undefined;
  parkedViewChanged = false;
  strokeHistory.length = 0; strokeFuture.length = 0; shareLinks = undefined;
  markup.clear(); syncToolbar();
  notify('视角已改变，批注已隐藏');
  host.notify('annotation', annotationState());
}
function exitAnnotation(): void {
  markup.finishActive(); markup.setEnabled(false); annotationMode = null;
  shell.classList.remove('annotation-mode');
  if (toolbar) toolbar.hidden = true;
  mainDock.append(originalShare);
}
function setObserveToolbar(open: boolean, keyboard = false): void {
  if (observeOpen === open) return;
  observeOpen = open;
  if (keyboard) originalDock.classList.add('dock-no-motion');
  originalDock.classList.toggle('is-observing', open);
  mainDock.classList.toggle('is-current', !open);
  observeDock.classList.toggle('is-current', open);
  mainDock.inert = open; observeDock.inert = !open;
  mainDock.setAttribute('aria-hidden', String(open));
  observeDock.setAttribute('aria-hidden', String(!open));
  observeTrigger.setAttribute('aria-expanded', String(open));
  if (keyboard) requestAnimationFrame(() => originalDock.classList.remove('dock-no-motion'));
  host.notify('ui', {observe: {open: observeOpen, category: activeObserveCategory}});
}
observeTrigger.addEventListener('click', event => { setObserveToolbar(true, event.detail === 0); observeBack.focus({preventScroll:true}); });
observeBack.addEventListener('click', event => { setObserveToolbar(false, event.detail === 0); observeTrigger.focus({preventScroll:true}); });
function setObserveCategory(category: string | null): void {
  activeObserveCategory = activeObserveCategory === category ? null : category;
  for (const button of originalDock.querySelectorAll<HTMLButtonElement>('[data-observe-category]')) {
    const selected = button.dataset.observeCategory === activeObserveCategory;
    button.classList.toggle('active', selected); button.setAttribute('aria-expanded', String(selected));
  }
  for (const detail of originalDock.querySelectorAll<HTMLElement>('.observe-detail')) detail.hidden = detail.id !== `observe-${activeObserveCategory}` && !(activeObserveCategory === 'scene' && detail.id === 'render-controls');
  originalDock.classList.toggle('detail-open', !!activeObserveCategory);
  host.notify('ui', {observe: {open: observeOpen, category: activeObserveCategory}});
  syncObserveMode();
}
for (const button of originalDock.querySelectorAll<HTMLButtonElement>('[data-observe-category]')) button.addEventListener('click', () => setObserveCategory(button.dataset.observeCategory ?? null));
for (const button of originalDock.querySelectorAll<HTMLButtonElement>('[data-observe-mode]')) button.addEventListener('click', () => {
  ui(runScene(active, viewOperations.settings, {render_mode: button.dataset.observeMode as RenderMode}));
});
originalDock.querySelector('#section-trigger')?.addEventListener('click', () => { if (activeObserveCategory) setObserveCategory(null); ui(runScene(active, sectionOperations.open, {})); });
for (const kind of ['shading', 'projection'] as const) for (const button of originalDock.querySelectorAll<HTMLButtonElement>(`[data-${kind}]`)) button.addEventListener('click', () => {
  ui(runScene(active, viewOperations.settings, kind === 'shading' ? {shading: button.dataset.shading as Shading} : {projection: button.dataset.projection as Projection}));
});
for (const [id, kind] of [['axes-toggle', 'axes'], ['light-toggle', 'background']] as const) originalDock.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', event => {
  const checked = (event.target as HTMLInputElement).checked;
  ui(runScene(active, viewOperations.settings, kind === 'background' ? {background: checked ? 'light' : 'dark'} : {axes: checked}));
});
for (const control of ['azimuth', 'elevation', 'intensity'] as const) originalDock.querySelector<HTMLInputElement>(`#light-${control}`)?.addEventListener('input', event => {
  const value = Number((event.target as HTMLInputElement).value);
  const id = active, view = viewStates.get(id), light = view?.kind === 'spatial' ? view.settings.light : undefined;
  if (light) ui(runScene(id, viewOperations.settings, {light: {...light, [control]: control === 'intensity' ? value / 100 : value}}));
  originalDock.querySelector(`#light-${control}-value`)!.textContent = `${value}${control === 'intensity' ? '%' : '°'}`;
});
function syncObserveMode(): void {
  const view = viewStates.get(active), settings = view?.kind === 'spatial' ? view.settings : undefined, renderMode = settings?.render_mode;
  for (const button of originalDock.querySelectorAll<HTMLButtonElement>('[data-observe-mode]')) {
    const selected = button.dataset.observeMode === renderMode;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    button.disabled = view?.kind !== 'spatial';
  }
  originalDock.classList.toggle('observe-raking', renderMode === 'raking' && activeObserveCategory === 'light');
  originalDock.querySelector<HTMLElement>('#light-controls')!.hidden = renderMode !== 'raking' || activeObserveCategory !== 'light';
  for (const kind of ['shading', 'projection'] as const) for (const button of originalDock.querySelectorAll<HTMLButtonElement>(`[data-${kind}]`)) {
    button.classList.toggle('active', button.dataset[kind] === settings?.[kind]); button.disabled = view?.kind !== 'spatial';
  }
  for (const [id, checked] of [['axes-toggle', settings?.axes ?? false], ['light-toggle', view?.settings.background === 'light']] as const) {
    const input = originalDock.querySelector<HTMLInputElement>(`#${id}`);
    if (input) {input.checked = checked; input.disabled = id === 'axes-toggle' && view?.kind !== 'spatial';}
  }
  for (const control of ['azimuth', 'elevation', 'intensity'] as const) {
    const input = originalDock.querySelector<HTMLInputElement>(`#light-${control}`), setting = settings?.light?.[control];
    const value = setting === undefined ? undefined : control === 'intensity' ? Math.round(setting * 100) : setting;
    if (input && value !== undefined) input.value = String(value);
    if (value !== undefined) originalDock.querySelector(`#light-${control}-value`)!.textContent = `${value}${control === 'intensity' ? '%' : '°'}`;
  }
  const section = originalDock.querySelector<HTMLButtonElement>('#section-trigger'); if (section) section.disabled = view?.kind !== 'spatial';
}
function renderInkBadges(): void {
  inkBadges.replaceChildren();
  markup.exportStrokes().forEach((stroke, index) => {
    const points = markup.displayPoints(index); const point = points[Math.floor(points.length / 2)]; if (!point) return;
    const bounds = stage.getBoundingClientRect();
    const button = document.createElement('button'); button.type = 'button'; button.textContent = stroke.label || `画笔 ${index + 1}`;
    button.style.left = `${point[0] - bounds.left}px`; button.style.top = `${point[1] - bounds.top}px`;
    button.style.setProperty('--ink', stroke.color); button.classList.toggle('selected', selectedStroke === stroke.id);
    button.addEventListener('click', () => ui(selectAnnotation('screen', stroke.id)));
    inkBadges.append(button);
  });
}
function ensureToolbar(): void {
  if (toolbar) return;
  toolbar = createAnnotationToolbar(true);
  shell.append(toolbar);
  toolbar.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.surfaceMode) {ui(setAnnotationTool(button.dataset.surfaceMode as AnnotationMode)); return;}
    if (button.dataset.surfaceColor) {ui(setAnnotationColor(button.dataset.surfaceColor)); return;}
    const state = annotationState();
    switch (button.id) {
      case 'surface-done': ui(closeAnnotation()); break;
      case 'surface-undo': ui(annotationHistory('undo')); break;
      case 'surface-redo': ui(annotationHistory('redo')); break;
      case 'surface-delete': if (state.selection) ui(removeAnnotation(state.selection.kind, state.selection.id)); break;
      case 'surface-end': ui(finishAnnotation()); break;
      case 'surface-close': if (state.selection) ui(runScene(active, annotationOperations.setClosed, {id: state.selection.id, closed: !state.closed})); break;
    }
  });
  toolbar.querySelector<HTMLInputElement>('#surface-name')!.addEventListener('change', event => {
    const value = (event.target as HTMLInputElement).value.trim(), selection = annotationState().selection;
    if (selection?.kind === 'screen') ui(editScreen(selection.id, value));
    else if (selection) ui(runScene(active, annotationOperations.editSurface, {id: selection.id, label: value}));
  });
}
function isGlobalInk(): boolean {return mode === 'split' && annotationMode === 'screen';}
function annotationState(): AnnotationToolbarState {
  const child = annotationStates.get(active);
  if (isGlobalInk()) {
    const stroke = markup.exportStrokes().find(value => value.id === selectedStroke);
    return {active: annotationMode !== null, mode: 'screen', color: stroke?.color ?? color, selection: stroke ? {kind: 'screen', id: stroke.id} : null, label: stroke?.label ?? '', canUndo: !!strokeHistory.length, canRedo: !!strokeFuture.length, canClose: false, closed: false, canFinishLine: false, busy: false, status: '全部场景画笔 · 可跨场景划线', supportsSurface: child?.supportsSurface ?? false};
  }
  return child ?? {active: false, mode: 'select', color, selection: null, label: '', canUndo: false, canRedo: false, canClose: false, closed: false, canFinishLine: false, busy: false, status: '', supportsSurface: false};
}
function applyAnnotationState(): void {
  const state = annotationStates.get(active);
  if (state?.active) {
    ensureToolbar(); annotationMode = state.mode; color = state.color; markup.setColor(color);
    shell.classList.add('annotation-mode'); toolbar!.querySelector('.surface-actions')!.append(originalShare);
    markup.setEnabled(isGlobalInk());
  } else if (annotationMode) exitAnnotation();
  syncToolbar();
}
function syncToolbar(): void {
  if (!toolbar) return;
  toolbar.hidden = annotationMode === null; if (annotationMode === null) return;
  const state = annotationState();
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-surface-mode]')) {
    button.hidden = !state.supportsSurface && ['point', 'line'].includes(button.dataset.surfaceMode!);
    const on = button.dataset.surfaceMode === annotationMode;
    button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on));
    button.disabled = state.busy || (!state.supportsSurface && ['point', 'line'].includes(button.dataset.surfaceMode!));
  }
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-surface-color]')) button.setAttribute('aria-pressed', String(button.dataset.surfaceColor === state.color));
  toolbar.querySelector<HTMLElement>('.surface-selection')!.hidden = !state.selection;
  const input = toolbar.querySelector<HTMLInputElement>('#surface-name')!; if (document.activeElement !== input) input.value = state.label;
  toolbar.querySelector<HTMLButtonElement>('#surface-undo')!.disabled = !state.canUndo;
  toolbar.querySelector<HTMLButtonElement>('#surface-redo')!.disabled = !state.canRedo;
  toolbar.querySelector<HTMLButtonElement>('#surface-close')!.hidden = !state.canClose;
  toolbar.querySelector<HTMLButtonElement>('#surface-close')!.textContent = state.closed ? '打开' : '闭合';
  toolbar.querySelector<HTMLButtonElement>('#surface-end')!.hidden = !state.canFinishLine;
  toolbar.querySelector<HTMLButtonElement>('#surface-delete')!.disabled = !state.selection || state.busy;
  toolbar.querySelector<HTMLElement>('#surface-hint')!.textContent = state.status;
  markup.setSelection(markup.exportStrokes().findIndex(stroke => stroke.id === selectedStroke)); renderInkBadges();
}
async function beginAnnotation(): Promise<void> {
  const id = active; sceneClient(id); ensureToolbar();
  await sendScope(id); await runScene(id, workbenchOperations.annotationOpen, {target: 'screen'}); await refreshSceneState(id);
}
async function closeAnnotation(): Promise<void> {
  const id = active; markup.finishActive(); await runScene(id, workbenchOperations.annotationClose, {});
  if (id === active) exitAnnotation();
  await refreshSceneState(id);
}
async function setAnnotationTool(value: AnnotationMode): Promise<void> {
  const id = active;
  // Child UI events can enable the new tool before its operation result arrives.
  // Finish the previous gesture now, never a stroke begun during that round trip.
  markup.finishActive(); selectedStroke = undefined;
  await runScene(id, annotationOperations.setTool, {mode: value});
  if (id !== active) return;
  annotationMode = value; markup.setEnabled(isGlobalInk());
  await refreshSceneState(id); host.notify('annotation', annotationState());
}
async function setAnnotationColor(value: string): Promise<void> {
  const id = active, global = isGlobalInk(), selection = selectedStroke;
  if (global && selection) editGlobalScreen(selection, undefined, value);
  else await runScene(id, annotationOperations.setColor, {color: value});
  if (id === active) {color = value; markup.setColor(value);}
  await refreshSceneState(id); host.notify('annotation', annotationState());
}
function globalStroke(id: string): {strokes: ScreenStroke[]; index: number} {
  const strokes = markup.exportStrokes(), index = strokes.findIndex(stroke => stroke.id === id);
  if (index < 0) throw new OperationError('INVALID_ARGUMENT', 'Unknown collection screen annotation', {field: 'id', target: id});
  return {strokes, index};
}
function editGlobalScreen(id: string, label?: string, value?: string): void {
  const {strokes, index} = globalStroke(id); rememberStrokes();
  if (label !== undefined) strokes[index].label = label || undefined;
  if (value !== undefined) strokes[index].color = value;
  markup.load(strokes); host.notify('annotation', annotationState());
}
async function selectAnnotation(kind: 'screen' | 'surface', id: string): Promise<void> {
  if (kind === 'screen' && markup.exportStrokes().some(stroke => stroke.id === id)) {
    if (mode !== 'split') throw new OperationError('CONFLICT', 'Collection ink is parked outside its split composition');
    const sceneId = active;
    if (!annotationMode) await beginAnnotation();
    if (active !== sceneId) throw new OperationError('CONFLICT', 'Active scene changed while opening annotation tools', {target: sceneId});
    await setAnnotationTool('screen');
    if (active !== sceneId) throw new OperationError('CONFLICT', 'Active scene changed while selecting collection ink', {target: sceneId});
    selectedStroke = id; syncToolbar(); host.notify('annotation', annotationState());
  } else {const sceneId = active; await runScene(sceneId, annotationOperations.select, {kind, id}); await refreshSceneState(sceneId);}
}
async function editScreen(id: string, label?: string, value?: string): Promise<void> {
  if (markup.exportStrokes().some(stroke => stroke.id === id)) editGlobalScreen(id, label, value);
  else {const sceneId = active; await runScene(sceneId, annotationOperations.editScreen, {id, ...(label !== undefined ? {label} : {}), ...(value !== undefined ? {color: value} : {})}); await refreshSceneState(sceneId);}
}
async function removeAnnotation(kind: 'screen' | 'surface', id: string): Promise<void> {
  if (kind === 'screen' && markup.exportStrokes().some(stroke => stroke.id === id)) {
    const {strokes, index} = globalStroke(id); rememberStrokes(); strokes.splice(index, 1); selectedStroke = undefined; markup.load(strokes); host.notify('annotation', annotationState());
  } else {const sceneId = active; await runScene(sceneId, annotationOperations.remove, {kind, id}); await refreshSceneState(sceneId);}
}
async function annotationHistory(action: 'undo' | 'redo'): Promise<void> {
  if (isGlobalInk()) {
    markup.finishActive();
    const from = action === 'undo' ? strokeHistory : strokeFuture, to = action === 'undo' ? strokeFuture : strokeHistory;
    if (!from.length) throw new OperationError('CONFLICT', `No annotation ${action} available`);
    to.push(markup.exportStrokes()); markup.load(from.pop()!); selectedStroke = undefined; syncToolbar(); host.notify('annotation', annotationState());
  } else {const id = active; await runScene(id, action === 'undo' ? annotationOperations.undo : annotationOperations.redo, {}); await refreshSceneState(id);}
}
async function finishAnnotation(): Promise<void> {
  if (isGlobalInk()) {markup.finishActive(); host.notify('annotation', annotationState());}
  else {const id = active; await runScene(id, annotationOperations.finish, {}); await refreshSceneState(id);}
}
async function cancelAnnotation(): Promise<void> {
  if (isGlobalInk()) {markup.cancelActive(); strokeBefore = undefined; host.notify('annotation', annotationState());}
  else {const id = active; await runScene(id, annotationOperations.cancel, {}); await refreshSceneState(id);}
}

function notify(message: string): void {
  toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2500);
}
function mount(id: string): void {
  if (frames.has(id)) return;
  const card = cards.get(id)!;
  const frame = document.createElement('iframe');
  frame.className = 'collection-frame'; frame.title = `${overview.scenes.find(scene => scene.id === id)!.title} 场景`;
  frame.src = `${location.pathname}?scene=${encodeURIComponent(id)}&embedded=1`;
  card.querySelector('.collection-viewport')!.append(frame); frames.set(id, frame);
  if (!frame.contentWindow) throw new OperationError('RESOURCE_UNAVAILABLE', 'Scene window unavailable', {target: id});
  let client = connectWindowOperations(frame.contentWindow, id);
  clients.set(id, client); client.subscribe(event => receiveSceneEvent(id, event));
  let loaded = false;
  frame.addEventListener('load', () => {
    if (loaded) {
      client.dispose(); ready.delete(id); annotationStates.delete(id); viewStates.delete(id);
      client = connectWindowOperations(frame.contentWindow!, id);
      clients.set(id, client); client.subscribe(event => receiveSceneEvent(id, event));
    }
    loaded = true;
    const connection = client;
    void connection.run(workbenchOperations.get, {}).then(value => {
      if (clients.get(id) !== connection) return;
      ready.add(id); acceptUIState(id, value); updateFocus(); ui(sendScope(id));
      if (id !== active) ui(runScene(id, workbenchOperations.activate, {active: false}));
      host.notify('collection', collectionState());
    }).catch(error => {if (!(error instanceof OperationError && ['NOT_READY', 'DISPOSED'].includes(error.code))) report(error);});
  });
}
async function snapshot(id: string, prepare = false): Promise<SceneUpdate> {
  return await runScene(id, prepare ? workbenchOperations.prepareSnapshot : workbenchOperations.snapshot, {});
}
function fitGrid(): number | null {
  const count = overview.scenes.length;
  const width = stage.clientWidth, height = stage.clientHeight;
  const candidates = Array.from({length:count},(_,i)=>i+1).filter(columns => {
    const rows = Math.ceil(count / columns);
    return (width-columns+1)/columns >= 480 && (height-rows+1)/rows >= 360;
  });
  const score = (columns:number) => {
    const rows = Math.ceil(count / columns);
    const paneWidth = (width-columns+1)/columns, paneHeight = (height-rows+1)/rows;
    return Math.min(paneWidth/paneHeight,paneHeight/paneWidth);
  };
  return candidates.sort((a,b)=>score(b)-score(a))[0] ?? null;
}
function layout(): void {
  for (const card of cards.values()) if (!card.hidden) {
    const bounds = card.getBoundingClientRect();
    card.style.setProperty('--park-width', `${bounds.width || stage.clientWidth}px`);
    card.style.setProperty('--park-height', `${bounds.height || stage.clientHeight}px`);
  }
  const columns = maximized ? null : fitGrid();
  const nextMode = columns ? 'split' : 'single';
  mode = nextMode;
  shell.classList.toggle('collection-split',mode==='split'); shell.classList.toggle('collection-single',mode==='single');
  shell.classList.toggle('collection-maximized', maximized);
  sceneTabs.hidden = mode === 'split' || overview.scenes.length < 2;
  const rows = mode === 'split' ? Math.ceil(overview.scenes.length / columns!) : 1;
  stage.style.gridTemplateColumns = `repeat(${columns ?? 1},minmax(0,1fr))`;
  stage.style.gridTemplateRows = `repeat(${rows},minmax(0,1fr))`;
  for (const scene of overview.scenes) {
    const card = cards.get(scene.id)!;
    // Park, rather than destroy, inactive frames at their last viewport size.
    // Camera, reading, quality, selection and local undo stacks stay in that scene.
    card.hidden = mode === 'single' && scene.id !== active;
    card.inert = card.hidden;
    const expand = expandButtons.get(scene.id);
    if (expand) {
      const expanded = maximized && scene.id === active;
      expand.setAttribute('aria-expanded', String(expanded));
      expand.setAttribute('aria-label', expanded ? '还原分屏' : `放大 ${scene.title}`);
      expand.title = expanded ? '还原分屏' : '放大场景';
    }
    mount(scene.id);
    if (ready.has(scene.id)) ui(sendScope(scene.id));
  }
  // Global ink belongs to its captured split composition, not the temporary
  // maximized/tab viewport. Keep it parked until that composition returns.
  if (mode === 'split' && parkedViewChanged) invalidateCollectionInk();
  if (mode === 'split' && strokeLayout) {
    const current = captureLayout();
    if (current.width !== strokeLayout.width || current.height !== strokeLayout.height || current.columns !== strokeLayout.columns)
      invalidateCollectionInk();
  }
  markup.setEnabled(annotationMode==='screen' && mode==='split');
  updateFocus(); renderInkBadges(); syncToolbar();
  host.notify('collection', collectionState());
}
function scheduleLayout(): void {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {layoutFrame=0;layout();});
}
function updateFocus(): void {
  for (const [id,card] of cards) {
    card.classList.toggle('active',id===active);
    card.querySelector('.collection-scene-label')?.setAttribute('aria-pressed', String(id === active));
    const tab = tabs.get(id);
    if (tab) { tab.setAttribute('aria-selected', String(id === active)); tab.tabIndex = id === active ? 0 : -1; }
  }
  if (!sceneTabs.hidden) tabs.get(active)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  const title = overview.scenes.find(scene=>scene.id===active)?.title ?? '';
  originalDock.setAttribute('aria-label',`${title} 场景查看工具`);
  toolbar?.setAttribute('aria-label',`${title} 场景标注工具`);
  if (activated !== active) {
    if (activated) ui(runScene(activated, workbenchOperations.activate, {active: false}));
    activated = undefined;
    if (ready.has(active)) {activated = active; ui(runScene(active, workbenchOperations.activate, {active: true}));}
  }
}
function focus(id: string): void {
  if (!cards.has(id)) throw new OperationError('INVALID_ARGUMENT', 'Unknown collection scene', {field: 'sceneId', target: id});
  if (id === active) return;
  observeStates.set(active,{open:observeOpen,category:activeObserveCategory});
  exitAnnotation();
  active = id; shareLinks = undefined;
  const state = observeStates.get(id);
  setObserveToolbar(state?.open ?? false,true);
  activeObserveCategory = null; setObserveCategory(state?.category ?? null);
  syncObserveMode();
  if (mode === 'single') layout(); else updateFocus();
  host.notify('collection', collectionState());
}
async function setMaximized(id: string | undefined, value: boolean): Promise<void> {
  if (id !== undefined) focus(id);
  if (annotationMode && ready.has(active)) ui(runScene(active, workbenchOperations.annotationClose, {}));
  exitAnnotation(); maximized = value; shareLinks = undefined;
  layout(); expandButtons.get(active)?.focus({preventScroll: true});
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await Promise.all([...ready].map(sceneId => runScene(sceneId, workbenchOperations.get, {})));
}
function acceptUIState(id: string, value: unknown): void {
  const state = value as WorkbenchState;
  annotationStates.set(id, state.annotation); viewStates.set(id, state.view);
  if (id === active) {applyAnnotationState(); syncObserveMode();}
}
function receiveSceneEvent(id: string, event: OperationEvent): void {
  if (event.sceneId !== id) return;
  shareLinks = undefined;
  if (event.domain === 'ui') {if (event.data) acceptUIState(id, event.data); else ui(refreshSceneState(id));}
  else if (event.domain === 'annotation') ui(refreshSceneState(id));
  else if (event.domain === 'view') {
    if (event.data) viewStates.set(id, event.data as ViewSnapshot);
    if (id === active) syncObserveMode();
  } else if (event.domain === 'view:invalidated') {
    if (mode === 'single') {
      if (markup.hasStrokes || strokeHistory.length || strokeFuture.length || strokeBefore) parkedViewChanged = true;
    } else invalidateCollectionInk();
  } else if (event.domain === 'lifecycle') {
    const data = event.data as {ready?: boolean; disposed?: boolean; focus?: boolean; shortcut?: 'view' | 'image'; error?: string};
    if (data.ready) {
      ready.add(id); ui(sendScope(id)); ui(refreshSceneState(id));
      if (id === active) updateFocus(); else ui(runScene(id, workbenchOperations.activate, {active: false}));
    }
    if (data.focus) focus(id);
    if (data.shortcut && id === active) ui(copyLink(data.shortcut));
    if (data.error || data.disposed) {
      ready.delete(id); annotationStates.delete(id); viewStates.delete(id);
      if (activated === id) activated = undefined;
      if (data.error) notify(`${overview.scenes.find(scene => scene.id === id)?.title}：${data.error}`);
      clients.get(id)?.dispose();
    }
  }
  host.notify('collection:scene', {sceneId: id, revision: event.revision, domain: event.domain});
}
function collectionState(): CollectionState {
  return {activeSceneId: active, layout: captureLayout(), mode, maximized,
    scenes: overview.scenes.map(scene => ({...scene, ready: ready.has(scene.id), parked: !!cards.get(scene.id)?.hidden})),
    strokes: markup.exportStrokes(), selection: selectedStroke ?? null, canUndo: !!strokeHistory.length, canRedo: !!strokeFuture.length};
}
async function refreshLinks(origin?: string): Promise<ShareResponse> {
  const activeSceneId = active;
  markup.finishActive();
  const sceneUpdates: Record<string, SceneUpdate> = {};
  for (const scene of overview.scenes) sceneUpdates[scene.id] = await snapshot(scene.id, true);
  if (parkedViewChanged) invalidateCollectionInk();
  const composition = mode === 'single' && markup.hasStrokes && strokeLayout ? strokeLayout : captureLayout();
  const links = await shareCollection(token, activeSceneId, sceneUpdates, markup.exportStrokes(), composition, owner, origin);
  shareLinks = links; host.notify('share', {activeSceneId}); return links;
}
async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); notify('链接已复制'); }
  catch { window.prompt('复制链接', value); }
}
async function copyLink(kind: 'view' | 'image'): Promise<CollectionCopyResult> {
  const sequence = ++copySequence;
  const pending = refreshLinks(shareLinks?.origin).then(links => kind === 'view' ? links.viewer_url : links.image_url);
  let writeResult: Promise<boolean> | undefined;
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({'text/plain': pending.then(value => new Blob([value], {type:'text/plain'}))});
      writeResult = navigator.clipboard.write([item]).then(() => true, () => false);
    } catch { /* Fall back to plain text copy. */ }
  }
  const value = await pending;
  if (sequence !== copySequence) throw new OperationError('CANCELLED', 'A newer copy request superseded this one');
  let copied = writeResult ? await writeResult : false;
  if (!writeResult && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Show a manual copy prompt. */ }
  }
  if (sequence !== copySequence) throw new OperationError('CANCELLED', 'A newer copy request superseded this one');
  if (copied) notify('链接已复制');
  else window.prompt('复制链接', value);
  return {status: copied ? 'copied' : 'manual'};
}
function showShare(links: ShareResponse): void {
  dialog.replaceChildren();
  const title = document.createElement('h2'); title.textContent = '分享多场景'; dialog.append(title);
  if (links.hosts.length > 1) {
    const select = document.createElement('select'); select.setAttribute('aria-label', '链接地址');
    for (const host of links.hosts) { const option = document.createElement('option'); option.value = host.origin; option.textContent = host.address; option.selected = host.origin === links.origin; select.append(option); }
    select.addEventListener('change', async () => { try { showShare(await refreshLinks(select.value)); } catch (error) { notify(String(error)); } }); dialog.append(select);
  }
  for (const [label, value] of [['全部场景视角链接', links.viewer_url], ['全部场景图片', links.image_url], ['完整信息', links.full_text]] as const) {
    if (!value || (label === '完整信息' && !overview.owner)) continue;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', async () => { await copy(value); dialog.close(); }); dialog.append(button);
  }
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', () => dialog.close()); dialog.append(close);
  if (!dialog.open) dialog.showModal();
}
originalShare.addEventListener('click', async () => {
  originalShare.disabled = true;
  try { showShare(await refreshLinks()); }
  catch (error) { notify(error instanceof Error ? error.message : '无法分享场景'); }
  finally { originalShare.disabled = false; }
});
window.addEventListener('keydown', event => {
  if (annotationMode && !dialog.open && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable]'))) {
    if (event.key === 'Escape') {event.preventDefault(); ui(closeAnnotation()); return;}
    if (annotationMode === 'screen') {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); ui(annotationHistory(event.shiftKey ? 'redo' : 'undo')); return;
      }
      const selection = annotationState().selection;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault(); ui(removeAnnotation(selection.kind, selection.id)); return;
      }
    }
  }
  const macOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const modifier = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.repeat || event.key.toLowerCase() !== 'c' || dialog.open) return;
  if (window.getSelection()?.toString() || event.composedPath().some(node => node instanceof HTMLElement &&
    (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"]')))) return;
  event.preventDefault();
  ui(copyLink(event.shiftKey ? 'view' : 'image'));
});
for (const [selector, action] of [['#fit-view','fit'], ['#brush-tool','annotate']] as const) {
  originalDock.querySelector(selector)?.addEventListener('click', () => action === 'annotate' ? (setObserveToolbar(false), ui(beginAnnotation())) : ui(runScene(active, viewOperations.fit, {})));
}
registerCollectionOperations(host, {
  state: collectionState, select: focus, layout: setMaximized,
  uiState: () => ({observe: {open: observeOpen, category: activeObserveCategory}, annotation: annotationState(), view: viewStates.get(active) ?? null}),
  catalog: id => sceneClient(id).catalog(),
  execute: (id, operation, params) => sceneClient(id).execute(operation, params),
  snapshot, share: refreshLinks,
  copy: kind => {
    if (!navigator.userActivation?.isActive) throw new OperationError('USER_ACTIVATION_REQUIRED', 'Copy requires a user gesture; use share:create to retrieve links');
    return copyLink(kind);
  },
  observe: (open, category) => {
    if (open !== undefined) setObserveToolbar(open);
    if (category !== undefined && category !== activeObserveCategory) setObserveCategory(category);
  },
  annotationOpen: beginAnnotation, annotationClose: closeAnnotation, annotationGet: annotationState,
  annotationTool: setAnnotationTool, annotationColor: setAnnotationColor, annotationSelect: selectAnnotation,
  annotationEdit: editScreen, annotationRemove: removeAnnotation, annotationHistory,
  annotationFinish: finishAnnotation, annotationCancel: cancelAnnotation,
  annotationClosed: async (id, closed) => {const sceneId = active; await runScene(sceneId, annotationOperations.setClosed, {id, closed}); await refreshSceneState(sceneId);},
  screenCreate: value => {
    if (mode !== 'split') throw new OperationError('CONFLICT', 'Global ink requires the split composition');
    markup.finishActive();
    const strokes = markup.exportStrokes();
    if (strokes.length >= 64 || strokes.reduce((total, stroke) => total + stroke.points.length, value.points.length) > 4096)
      throw new OperationError('CONFLICT', 'Collection screen annotation capacity reached');
    rememberStrokes();
    const stroke = {...value, id: crypto.randomUUID()}; strokes.push(stroke); markup.load(strokes);
    strokeLayout = captureLayout(); selectedStroke = stroke.id; host.notify('annotation', annotationState()); return stroke;
  },
  screenClear: () => {markup.finishActive(); rememberStrokes(); selectedStroke = undefined; markup.clear(); host.notify('annotation', annotationState());},
});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  for (const client of clients.values()) client.dispose();
  disposePage(); host.dispose();
});

try {
  overview = takeInitialScene<CollectionOverview>() ?? await loadCollection(token, owner);
  strokeLayout=overview.layout ?? undefined;
  markup.load(overview.strokes ?? []);
  if (!overview.scenes.some(scene => scene.id === active)) active = overview.active_scene_id;
  document.title = `${overview.title} · Blind`;
  stage.setAttribute('aria-label', `${overview.title} 多场景视图`);
  for (const scene of overview.scenes) {
    const card = document.createElement('section'); card.className = 'collection-card'; card.dataset.scene = scene.id; card.setAttribute('aria-label',scene.title);
    card.id = `collection-scene-${scene.id}`;
    const label = document.createElement('button'); label.type = 'button'; label.className = 'collection-scene-label'; label.title = scene.title;
    const chip = document.createElement('span'); chip.className = 'collection-label-chip';
    const name = document.createElement('span'); name.textContent = scene.title; chip.append(name); label.append(chip);
    label.addEventListener('click',()=>focus(scene.id)); label.addEventListener('focus',()=>focus(scene.id));
    card.addEventListener('pointerdown',()=>focus(scene.id));
    const viewport = document.createElement('div'); viewport.className = 'collection-viewport'; card.append(label,viewport); stage.append(card); cards.set(scene.id,card);
    if (overview.scenes.length > 1) {
      const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'collection-scene-expand';
      expand.setAttribute('aria-controls', card.id);
      expand.innerHTML = '<i data-lucide="maximize-2"></i><i data-lucide="minimize-2"></i>';
      expand.addEventListener('click', () => ui(setMaximized(scene.id, !maximized))); card.append(expand); expandButtons.set(scene.id, expand);
      const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = scene.title; tab.title = scene.title;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', card.id);
      tab.addEventListener('click', () => focus(scene.id)); tab.addEventListener('focus', () => focus(scene.id));
      sceneTabs.append(tab); tabs.set(scene.id, tab);
    }
  }
  installIcons(stage);
  scheduleLayout(); new ResizeObserver(() => {scheduleLayout();renderInkBadges();}).observe(stage);
} catch (error) { notify(error instanceof Error ? error.message : '无法打开多场景'); }
