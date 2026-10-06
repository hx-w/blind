const exportMode = new URLSearchParams(location.search).has('render');
const sceneId = new URLSearchParams(location.search).get('scene');
const embedded = new URLSearchParams(location.search).has('embedded');
import './styles.css';
import { ComponentViewer } from './component-viewer';
import { ApiError, loadScene, shareScene, type HostCandidate, type MeshQuality, type PublicScene, type ShareResponse } from './api';
import { MarkupCanvas } from './markup';
import { MeshViewer } from './viewer';
import { SurfaceEditor } from './surface';
import { SectionViewer } from './section-viewer';
import { installIcons } from './icons';
import { installShortcuts } from './shortcuts';
import {takeInitialScene} from './bootstrap';
import {OperationHost, OperationError, type Operation} from './operations/core';
import {publishOperations, serveWindowOperations} from './operations/transport';
import {registerWorkbenchOperations, workbenchOperations, type WorkbenchState, type ShareSheetState, type ClipboardOutcome} from './operations/workbench';
import {registerEntityOperations, entityOperations} from './operations/entities';
import {registerContentOperations} from './operations/content';
import {registerViewOperations, viewOperations, readView} from './operations/view';
import {registerAnnotationOperations} from './operations/annotations';
import {registerSectionOperations} from './operations/section';
import {BoardViewport} from './viewport/board';
import {resolveViewportMode} from './viewport/mode';
import type {SceneViewport} from './viewport/types';
import {ScreenAnnotationEditor} from './annotations/screen-editor';
import type {AnnotationEditor} from './annotations/editor';

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const shell = $('#app-shell');
const root = $('#canvas-root');
const viewerElement = $('#viewer');
const title = $('#scene-title');
const meta = $('#scene-meta');
const dock = $('.review-dock');
const mainDock = $('.dock-main');
const observeDock = $('.dock-observe');
const observeTrigger = $('#observe-trigger') as HTMLButtonElement;
const observeBack = $('#observe-back') as HTMLButtonElement;
const observeCategories = document.querySelectorAll<HTMLButtonElement>('[data-observe-category]');
const lightControls = $('#light-controls');
const lightAzimuth = $('#light-azimuth') as HTMLInputElement;
const lightElevation = $('#light-elevation') as HTMLInputElement;
const lightIntensity = $('#light-intensity') as HTMLInputElement;
const loading = $('#loading-state');
const loadingTitle = $('#loading-title');
const loadingMeter = $('#loading-meter');
const loadingBar = $('#loading-bar');
const loadingProgress = $('#loading-progress');
const invalid = $('#invalid-state');
const empty = $('#empty-state');
const sceneSelectedInfo = $('#scene-selected-info');
const sceneSelectedLabel = $('#scene-selected-label');
const sceneSelectedMeta = $('#scene-selected-meta');
const sceneInfoQuality = $('#scene-info-quality');
const lodSaving = $('#lod-saving');
const axesToggle = $('#axes-toggle') as HTMLInputElement;
const lightToggle = $('#light-toggle') as HTMLInputElement;
const shareDialog = $('#share-sheet') as HTMLDialogElement;
const shareOptions = $('.share-options');
const shareTitle = $('#share-title');
const backHost = $('#back-host') as HTMLButtonElement;
const shareHostTrigger = $('#share-host-trigger') as HTMLButtonElement;
const shareHostCurrent = $('#share-host-current');
const shareHostPicker = $('#share-host-picker');
const shareHostList = $('#share-host-list');
const copyFull = $('#copy-full');
const manualCopy = $('#manual-copy');
const manualCopyValue = $('#manual-copy-value') as HTMLTextAreaElement;
const toast = $('#toast');
const brushTool = $('#brush-tool') as HTMLButtonElement;

// The viewer may be mounted under a configured base path, so the short-link marker
// can sit after an arbitrary prefix (e.g. /blind/s/{token}).
const token = location.pathname.match(/\/s\/([^/]+)$/)?.[1];
const sessionKey = token && sceneId ? `blind.collection.${token}.${sceneId}` : undefined;
// With a <base href> injected, fragment-only links resolve against the base
// URL and would navigate away from the scene; scroll and focus manually.
$('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  viewerElement.focus();
});
let owner = token ? sessionStorage.getItem(`blind.owner.${token}`) ?? undefined : undefined;
let scene: PublicScene | undefined;
let sceneReady = false;
let components: ComponentViewer | undefined;
let observeOpen = false;
let activeObserveCategory: string | null = null;
let shareLinks: ShareResponse | undefined;
let shareRequestGeneration = 0;
let shortcutCopyGeneration = 0;
let toastTimer = 0;
let loadProgress = { completed: 0, total: 0, rawFallbacks: 0, failed: 0 };
let longLoadTimer = 0;
const operations = new OperationHost({sceneId: sceneId ?? 'scene', ready: () => sceneReady, exporting: exportMode});
let viewport: SceneViewport;
let geometryViewer: MeshViewer | undefined;
let surface: AnnotationEditor;
let section: SectionViewer | undefined;
const markup = new MarkupCanvas($('#markup-canvas') as HTMLCanvasElement);
markup.onChange = () => {
  viewport?.setStrokes(markup.exportStrokes());
  surface?.refreshList();
};
markup.onActiveChange = (active) => shell.classList.toggle('drawing-stroke', active);

installIcons();
void start();

function saveEmbeddedState(): import('./api').SceneUpdate | null {
  if (!embedded || !sceneReady || !sessionKey) return null;
  markup.finishActive(); surface.finishForShare();
  const update = viewport.exportUpdate();
  sessionStorage.setItem(sessionKey, JSON.stringify(update));
  return update;
}

const unpublishOperations = publishOperations(operations);
const disconnectParent = embedded ? serveWindowOperations(operations) : undefined;
if (embedded && sceneId) {
  const focusScene = () => operations.notify('lifecycle', {focus: true});
  window.addEventListener('pointerdown', focusScene, true);
  window.addEventListener('focus', focusScene);
  window.addEventListener('focusin', focusScene);
  window.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c' || event.altKey || event.repeat) return;
    if (window.getSelection()?.toString()) return;
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable],dialog[open]')) return;
    event.preventDefault();
    operations.notify('lifecycle', {shortcut: event.shiftKey ? 'view' : 'image'});
  }, true);
  window.addEventListener('pagehide', () => { saveEmbeddedState(); });
}
operations.subscribe(event => {
  if (!sceneReady || event.domain === 'ui' || event.domain === 'lifecycle') return;
  syncSceneControls(); syncSceneMeta();
  operations.notify('ui', workbenchState());
});
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  operations.dispose(); disconnectParent?.(); unpublishOperations(); components?.dispose();
});

$('#scene-notice').addEventListener('click', () => runUI(workbenchOperations.info, {}));

function runUI<P, R>(operation: Operation<P, R>, params: P): void {
  void operations.run(operation, params).catch(error => showToast(error instanceof Error ? error.message : '操作失败'));
}
function workbenchState(): WorkbenchState {
  return {observe: {open: observeOpen, category: activeObserveCategory}, annotation: surface.toolbarState, view: readView(viewport)};
}

async function start(): Promise<void> {
  if (!token) {
    loading.hidden = true; empty.hidden = false;
    hideViewerControls(); return;
  }
  try {
    startLongLoadHint();
    scene = takeInitialScene<PublicScene>() ?? await loadScene(token, owner);
    if (embedded && sessionKey) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as import('./api').SceneUpdate | null;
        if (saved && saved.meshes?.length === scene.meshes.length) {
          scene.state = saved.state;
          scene.meshes.forEach((mesh, index) => Object.assign(mesh, saved.meshes[index]));
          const entities = scene.entities;
          if (saved.entities) {
            for (const component of entities) {
              const update = saved.entities.find(candidate => candidate.id === component.id);
              if (update) Object.assign(component, update);
            }
          }
        }
      } catch { sessionStorage.removeItem(sessionKey); }
    }
    title.textContent = scene.source ? `${scene.title}\n\n来源主机：${scene.source.host}\n用户：${scene.source.user} · ${scene.source.name}` : scene.title;
    const artifactList = document.createElement('div');
    artifactList.className = 'scene-artifacts';
    for (const warning of scene.warnings ?? []) {
      const row = document.createElement('p'); row.textContent = warning.message; artifactList.append(row);
    }
    if (scene.attachments?.length) {
      const heading = document.createElement('p'); heading.textContent = `附件（${scene.attachments.length}）`; artifactList.append(heading);
      for (const attachment of scene.attachments) {
        const row = document.createElement('p');
        if (attachment.url) {
          const link = document.createElement('a'); link.href = attachment.url; link.textContent = attachment.label; link.download = ''; row.append(link);
        } else { row.textContent = `${attachment.label} · ${attachment.unavailable ?? '不可用'}`; }
        artifactList.append(row);
      }
    }
    title.insertAdjacentElement('afterend', artifactList);
    startLongLoadHint();
    viewport = resolveViewportMode(scene) === 'board' ? new BoardViewport(root) : new MeshViewer(root);
    geometryViewer = viewport.kind === 'spatial' ? viewport : undefined;
    shell.dataset.viewport = viewport.kind;
    root.setAttribute('aria-label', viewport.kind === 'board' ? '可交互二维画板' : '可交互 3D 场景');
    $('.skip-link').textContent = viewport.kind === 'board' ? '跳到画板' : '跳到 3D 视图';
    $('#gesture-hint span').textContent = viewport.kind === 'board' ? '单指移动' : '单指旋转';
    observeCategories.forEach(button => {button.hidden = viewport.kind === 'board' && button.dataset.observeCategory !== 'scene';});
    $('#section-trigger').hidden = viewport.kind === 'board';
    axesToggle.closest('label')!.hidden = viewport.kind === 'board';
    viewport.onLoadProgress = progress => {loadProgress = progress; renderLoadProgress();};
    viewport.onViewChangeStart = invalidateMarkupForViewChange;
    viewport.onViewChangeEnd = () => {if (sceneReady) operations.notify('view', readView(viewport));};
    viewport.onModelChange = () => {
      syncSceneControls(); syncSceneMeta(); surface?.refreshList(); components?.sync(); section?.refresh();
      if (sceneReady && !components?.entityMutationActive) operations.notify('entity');
    };
    if (geometryViewer) geometryViewer.onSelectionChange = () => {
      components?.selectMesh(geometryViewer!.selectedIndex); syncSceneControls(); surface?.refreshList();
    };
    if (geometryViewer) geometryViewer.onEntityFocus = (ids, animate) => runUI(entityOperations.focus, {ids: [...ids], animate});
    const annotationCallbacks = {toast: showToast, change: () => {
      syncSceneControls();
      if (sceneReady) operations.notify('annotation', surface.toolbarState);
    }};
    surface = geometryViewer ? new SurfaceEditor(geometryViewer, markup, shell, annotationCallbacks) : new ScreenAnnotationEditor(viewport, markup, shell, annotationCallbacks);
    section = geometryViewer ? new SectionViewer(geometryViewer, showToast) : undefined;
    await viewport.load(scene, exportMode);
    if (loadProgress.total > 0 && loadProgress.failed === loadProgress.total && !scene.entities.some(c => c.source.kind === 'attachment')) {
      throw new Error('No models could be loaded');
    }
    $('[data-copy="image"]').hidden = false;
    components = new ComponentViewer(root, viewport, scene, undefined, {operations});
    components.onSelect = () => syncSceneControls();
    components.onChange = () => syncSceneControls();
    components.onContentViewChange = invalidateMarkupForViewChange;
    components.onScreenAnnotation = () => runUI(workbenchOperations.annotationOpen, {target: 'screen'});
    if (section) section.onShow = () => {components?.setSceneList({open: false});};
    if (!exportMode) void components.ready().catch(() => {});
    registerViewOperations(operations, viewport);
    registerEntityOperations(operations, components);
    registerContentOperations(operations, components);
    registerAnnotationOperations(operations, surface, viewport, markup);
    registerSectionOperations(operations, section, geometryViewer);
    registerWorkbenchOperations(operations, {
      state: workbenchState,
      whenSettled: () => components!.whenSettled(),
      observe: params => {
        if (viewport.kind === 'board' && params.category && params.category !== 'scene') throw new OperationError('UNSUPPORTED', 'This observation category requires a spatial viewport', {target: params.category});
        if (params.open !== undefined) setObserveToolbar(params.open);
        if (params.category !== undefined) setObserveCategory(params.category);
        operations.notify('ui', workbenchState());
      },
      info: () => components!.openInfo(),
      shareSheet: setShareSheet,
      copy: copyShareLink,
      annotationOpen: async target => {
        setObserveToolbar(false); section?.close();
        if (target !== 'screen' && components?.annotateContent()) {surface.exit(); return;}
        components?.closeContentAnnotation(); components?.returnToScene(); await surface.enter();
      },
      annotationClose: () => {components?.closeContentAnnotation(); surface.exit();},
      annotationScope: scope => surface.setExternalScreenMarkup(scope === 'collection'),
      activate: async active => {
        document.documentElement.classList.toggle('embedded-active', active);
        if (active) {surface.resume(); await components!.ready();}
        else {section?.deactivate(); surface.suspend(); saveEmbeddedState();}
        operations.notify('ui', workbenchState());
      },
      snapshot: () => viewport.exportUpdate(),
      prepareSnapshot: () => {markup.finishActive(); surface.finishForShare(); const update = viewport.exportUpdate(); if (sessionKey) sessionStorage.setItem(sessionKey, JSON.stringify(update)); return update;},
      share: createShare,
      resources: () => (scene!.attachments ?? []).map(item => ({id: item.id, label: item.label, byteSize: item.byte_size, available: !!item.url})),
      resource: id => {
        const item = scene!.attachments?.find(candidate => candidate.id === id);
        if (!item) throw new OperationError('UNKNOWN_ENTITY', 'Unknown attachment', {target: id});
        if (!item.url) throw new OperationError('RESOURCE_UNAVAILABLE', 'Attachment is unavailable', {target: id});
        return {id, url: item.url, filename: item.label};
      },
    });
    markup.load(scene.state.strokes ?? []);
    surface.load();
    owner = scene.owner ? owner : undefined;
    syncSceneControls(); syncSceneMeta();
    section?.load();
    const notices = (scene.warnings?.length ?? 0) + loadProgress.failed;
    if (notices > 0) {
      const notice = $('#scene-notice'); notice.hidden = false;
      notice.textContent = `场景部分可用 · ${notices} 项提示`;
      if (loadProgress.failed) {
        const row = document.createElement('p'); row.textContent = `${loadProgress.failed} 个模型加载失败；请检查网络或稍后重试。`; artifactList.prepend(row);
      }
    }
    sceneReady = true;
    if (!embedded && !exportMode) dock.hidden = false;
    finishLoading();
    operations.notify('lifecycle', {ready: true});
    operations.notify('ui', workbenchState());
    if (exportMode) {
      if (loadProgress.failed) throw new Error('Export failed: geometry unavailable');
      await components.ready(); await document.fonts.ready;
      const settled = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => settled.resolve()));
      await settled.promise;
      document.documentElement.dataset.renderStatus = 'ready';
    }
  } catch (error) {
    operations.notify('lifecycle', {error: error instanceof Error ? error.message : 'Scene failed'});
    sceneReady = false;
    if (exportMode) { document.documentElement.dataset.renderStatus = 'error'; document.documentElement.dataset.renderError = error instanceof Error ? error.message : 'Scene render failed'; }
    finishLoading(); hideViewerControls();
    invalid.hidden = false;
    if (!(error instanceof ApiError && error.status === 410)) {
      invalid.querySelector('span')!.textContent = error instanceof ApiError ? String(error.status) : 'ERR';
      invalid.querySelector('h2')!.textContent = error instanceof ApiError && error.status === 404 ? '场景不存在' : '暂时无法打开场景';
      invalid.querySelector('p')!.textContent = error instanceof ApiError && error.status === 404 ? '请检查链接是否正确。' : '资源或服务暂时不可用，请稍后重试。';
    }
  }
}

function renderLoadProgress(): void {
  const { completed, total, rawFallbacks, failed } = loadProgress;
  const percent = total > 0 ? Math.round(completed / total * 100) : 0;
  loadingMeter.hidden = total === 0;
  loadingMeter.setAttribute('aria-valuenow', String(percent));
  loadingBar.style.setProperty('--loading-progress', `${percent}%`);
  loadingTitle.textContent = completed >= total && total > 0 ? '正在打开场景' : '正在生成 LOD';
  loadingProgress.textContent = total > 0
    ? `${completed} / ${total} Mesh${rawFallbacks > 0 ? ` · ${rawFallbacks} 个回退 Raw` : ''}${failed > 0 ? ` · ${failed} 个不可用` : ''}`
    : '正在验证源 Mesh';
}

function startLongLoadHint(): void {
  window.clearTimeout(longLoadTimer);
  longLoadTimer = window.setTimeout(() => {
    if (!loading.hidden && (loadProgress.total === 0 || loadProgress.completed < loadProgress.total)) {
      loadingTitle.textContent = loadProgress.total === 0
        ? '源 Mesh 较大，正在验证'
        : '首次生成 LOD，可能需要片刻';
    }
  }, 1800);
}

function finishLoading(): void {
  window.clearTimeout(longLoadTimer);
  loading.hidden = true;
}

function hideViewerControls(): void {
  document.querySelectorAll<HTMLElement>('[data-viewer-chrome]').forEach((element) => { element.hidden = true; });
}

function syncSceneControls(): void {
  const component = components?.selectedEntity;
  const geometry = !component || !!components?.selectedGeometry;
  const state = viewport.currentState;
  axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
  syncRenderControls();
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach(button => button.classList.toggle('active', button.dataset.shading === state.shading));
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach(button => button.classList.toggle('active', button.dataset.projection === state.projection));
  const selected = geometry ? geometryViewer?.selectedModel : undefined;
  sceneSelectedInfo.hidden = !component && !selected;
  sceneInfoQuality.hidden = !selected;
  if (component || selected) {
    sceneSelectedLabel.textContent = component?.label ?? selected?.label?.text ?? selected?.name ?? '';
    sceneSelectedMeta.textContent = selected
      ? `${selected.format.toUpperCase()} · Raw ${formatBytes(selected.raw_bytes)}`
      : `${component!.component.toUpperCase()} · ${formatBytes(scene?.attachments?.[component!.source.index]?.byte_size ?? 0)}`;
  }
  if (!selected) return;
  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => {
    const quality = button.dataset.quality as MeshQuality;
    button.classList.toggle('active', quality === selected.quality);
    button.setAttribute('aria-pressed', String(quality === selected.quality));
    button.disabled = selected.loading || (quality === 'lod' && geometryViewer!.annotations.some(mark => mark.mesh === geometryViewer!.selectedIndex));
  });
  if (geometryViewer!.annotations.some(mark => mark.mesh === geometryViewer!.selectedIndex)) lodSaving.textContent = '表面标记使用 Raw，分享后位置保持一致';
  else if (selected.loading) lodSaving.textContent = `正在加载 ${selected.quality === 'lod' ? 'Raw' : 'LOD'} Mesh`;
  else if (selected.lod_bytes !== undefined) {
    const { delta, percent } = savings(selected.raw_bytes, selected.lod_bytes);
    lodSaving.textContent = delta >= 0
      ? `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 节省 ${formatBytes(delta)} (${percent}%)`
      : `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 小型 Mesh 增加 ${formatBytes(-delta)}`;
  } else if (selected.lod_error) lodSaving.textContent = 'LOD 暂不可用，当前已回退到 Raw';
  else lodSaving.textContent = '首次切换到 LOD 后显示节省量';
}

function setObserveToolbar(open: boolean): void {
  if (observeOpen === open) return;
  observeOpen = open;
  dock.classList.toggle('is-observing', open);
  mainDock.classList.toggle('is-current', !open);
  observeDock.classList.toggle('is-current', open);
  mainDock.inert = open; observeDock.inert = !open;
  mainDock.setAttribute('aria-hidden', String(open));
  observeDock.setAttribute('aria-hidden', String(!open));
  observeTrigger.setAttribute('aria-expanded', String(open));
}
observeTrigger.addEventListener('click', event => {
  if (event.detail === 0) dock.classList.add('dock-no-motion');
  runUI(workbenchOperations.observe, {open: true});
  requestAnimationFrame(() => dock.classList.remove('dock-no-motion'));
  observeBack.focus({preventScroll: true});
});
observeBack.addEventListener('click', event => {
  if (event.detail === 0) dock.classList.add('dock-no-motion');
  runUI(workbenchOperations.observe, {open: false});
  requestAnimationFrame(() => dock.classList.remove('dock-no-motion'));
  observeTrigger.focus({preventScroll: true});
});
function setObserveCategory(category: string | null): void {
  activeObserveCategory = category;
  for (const button of observeCategories) {
    const active = button.dataset.observeCategory === activeObserveCategory;
    button.classList.toggle('active', active); button.setAttribute('aria-expanded', String(active));
  }
  for (const detail of observeDock.querySelectorAll<HTMLElement>('.observe-detail')) detail.hidden = detail.id !== `observe-${activeObserveCategory}` && !(activeObserveCategory === 'scene' && detail.id === 'render-controls');
  dock.classList.toggle('detail-open', !!activeObserveCategory);
  syncRenderControls();
}
observeCategories.forEach(button => button.addEventListener('click', () => runUI(workbenchOperations.observe, {category: activeObserveCategory === button.dataset.observeCategory ? null : button.dataset.observeCategory as 'shading' | 'light' | 'projection' | 'scene'})));
$('#section-trigger').addEventListener('click', () => {if (activeObserveCategory) runUI(workbenchOperations.observe, {category: null});});
document.querySelectorAll<HTMLButtonElement>('[data-observe-mode]').forEach(button => button.addEventListener('click', () => runUI(viewOperations.settings, {render_mode: button.dataset.observeMode as 'matte' | 'raking' | 'normals'})));

function syncRenderControls(): void {
  const mode = geometryViewer?.renderMode ?? 'matte', light = geometryViewer?.lightSettings ?? {azimuth: 45, elevation: 20, intensity: 1};
  document.querySelectorAll<HTMLButtonElement>('[data-observe-mode]').forEach(button => {
    const active = button.dataset.observeMode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  lightControls.hidden = mode !== 'raking' || activeObserveCategory !== 'light';
  dock.classList.toggle('observe-raking', mode === 'raking' && activeObserveCategory === 'light');
  lightAzimuth.value = String(light.azimuth); lightElevation.value = String(light.elevation); lightIntensity.value = String(Math.round(light.intensity * 100));
  $('#light-azimuth-value').textContent = `${light.azimuth}°`;
  $('#light-elevation-value').textContent = `${light.elevation}°`;
  $('#light-intensity-value').textContent = `${Math.round(light.intensity * 100)}%`;
}

for (const input of [lightAzimuth, lightElevation, lightIntensity]) input.addEventListener('input', () => runUI(viewOperations.settings, {light: {azimuth: Number(lightAzimuth.value), elevation: Number(lightElevation.value), intensity: Number(lightIntensity.value) / 100}}));
$('#fit-view').addEventListener('click', () => runUI(viewOperations.fit, {}));
document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach(button => button.addEventListener('click', () => {
  const entityId = components?.selectedEntity?.id;
  if (entityId) runUI(entityOperations.quality, {id: entityId, quality: button.dataset.quality as MeshQuality});
}));
document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach(button => button.addEventListener('click', () => runUI(viewOperations.settings, {shading: button.dataset.shading as 'smooth' | 'flat' | 'wire'})));
document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach(button => button.addEventListener('click', () => runUI(viewOperations.settings, {projection: button.dataset.projection as 'perspective' | 'orthographic'})));
axesToggle.addEventListener('change', () => runUI(viewOperations.settings, {axes: axesToggle.checked}));
lightToggle.addEventListener('change', () => runUI(viewOperations.settings, {background: lightToggle.checked ? 'light' : 'dark'}));
brushTool.addEventListener('click', () => runUI(workbenchOperations.annotationOpen, {}));
$('#share-view').addEventListener('click', async () => {
  if (!token) return;
  const button = $('#share-view') as HTMLButtonElement; button.disabled = true; button.classList.add('working');
  try {
    await operations.run(workbenchOperations.shareSheet, {open: true});
  } catch (error) { showToast(error instanceof Error ? error.message : '无法创建分享链接'); }
  finally { button.disabled = false; button.classList.remove('working'); }
});

shareHostTrigger.addEventListener('click', () => runUI(workbenchOperations.shareSheet, {open: true, mode: 'hosts'}));
backHost.addEventListener('click', () => runUI(workbenchOperations.shareSheet, {open: true, mode: 'main'}));

async function createShare(origin?: string): Promise<ShareResponse> {
  if (!token) throw new OperationError('RESOURCE_UNAVAILABLE', '场景链接不可用');
  markup.finishActive(); surface.finishForShare();
  const links = await shareScene(token, viewport.exportUpdate(), owner, origin);
  operations.notify('share', {viewer_url: links.viewer_url, image_url: links.image_url});
  return links;
}
async function refreshShareLinks(origin?: string): Promise<ShareResponse | null> {
  const generation = ++shareRequestGeneration;
  let links: ShareResponse;
  try { links = await operations.run(workbenchOperations.share, {origin}) as ShareResponse; }
  catch (error) { if (generation !== shareRequestGeneration) return null; throw error; }
  if (generation !== shareRequestGeneration) return null;
  shareLinks = links;
  renderShareHosts(links); copyFull.hidden = !links.full_text;
  return links;
}

async function selectShareHost(origin: string): Promise<void> {
  if (!token || !shareLinks) return;
  setShareBusy(true);
  try {
    if (!await refreshShareLinks(origin)) return;
    showShareMain();
    showToast('链接地址已切换');
  } catch (error) {
    showToast(error instanceof Error ? error.message : '无法切换链接地址');
  } finally {
    setShareBusy(false);
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', () => {
  runUI(workbenchOperations.copy, {kind: button.dataset.copy as 'view' | 'image' | 'full'});
}));
installShortcuts([
  {key: 'c', run: () => runUI(workbenchOperations.copy, {kind: 'image', fresh: true})},
  {key: 'c', shift: true, run: () => runUI(workbenchOperations.copy, {kind: 'view', fresh: true})},
], () => sceneReady && !exportMode && !(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || embedded
  || matchMedia('(pointer: coarse) and (hover: none)').matches));

async function copyShareLink({kind, fresh = false}: {kind: 'image' | 'view' | 'full'; fresh?: boolean}): Promise<ClipboardOutcome> {
  if (!navigator.userActivation.isActive) throw new OperationError('USER_ACTIVATION_REQUIRED', 'Clipboard writes require a user gesture; use share:create to obtain links');
  const generation = ++shortcutCopyGeneration;
  const pending = (fresh || !shareLinks ? refreshShareLinks(shareLinks?.origin) : Promise.resolve(shareLinks)).then(links => {
    if (!links || generation !== shortcutCopyGeneration) throw new OperationError('CANCELLED', 'A newer copy request superseded this one');
    const value = kind === 'image' ? links.image_url : kind === 'view' ? links.viewer_url : links.full_text;
    if (!value) throw new OperationError('RESOURCE_UNAVAILABLE', 'This share has no full owner information');
    return value;
  });
  // Start the clipboard write in the key event's user activation. Safari loses
  // that activation if the share request is awaited before calling write().
  let writeResult: Promise<boolean> | undefined;
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({'text/plain': pending.then(value => new Blob([value], {type: 'text/plain'}))});
      writeResult = navigator.clipboard.write([item]).then(() => true, () => false);
    } catch { /* Fall back to a plain text write or manual copy. */ }
  }
  const value = await pending;
  if (generation !== shortcutCopyGeneration) throw new OperationError('CANCELLED', 'A newer copy request superseded this one');
  if (writeResult ? await writeResult : await copyText(value).catch(() => false)) {
    shareDialog.close(); resetShareSheet();
    showToast(kind === 'image' ? '图片链接已复制' : kind === 'view' ? '视角链接已复制' : '完整信息已复制');
    return {status: 'copied', value};
  }
  resetShareSheet(); if (!shareDialog.open) shareDialog.showModal(); showManualCopy(value);
  return {status: 'manual', value};
}

async function setShareSheet({open, mode = 'main'}: {open: boolean; mode?: 'main' | 'hosts' | 'manual'}): Promise<ShareSheetState> {
  if (!open) {shareDialog.close(); resetShareSheet();}
  else {
    if ((mode === 'main' || !shareLinks) && !await refreshShareLinks()) throw new OperationError('CANCELLED', 'A newer share request superseded this one');
    resetShareSheet(); if (!shareDialog.open) shareDialog.showModal();
    if (mode === 'hosts') openHostPicker();
    if (mode === 'manual') showManualCopy(shareLinks!.viewer_url);
  }
  return {open: shareDialog.open, mode: open ? mode : 'main', origin: shareLinks?.origin ?? null};
}
$('#select-copy').addEventListener('click', selectManualCopy);
$('#back-share').addEventListener('click', () => runUI(workbenchOperations.shareSheet, {open: true}));
$('#close-share').addEventListener('click', () => runUI(workbenchOperations.shareSheet, {open: false}));
shareDialog.addEventListener('click', (event) => {
  if (event.target === shareDialog) runUI(workbenchOperations.shareSheet, {open: false});
});

viewerElement.addEventListener('pointerdown', () => $('#gesture-hint').classList.add('dismissed'), { once: true });

function invalidateMarkupForViewChange(): void {
  if (!sceneReady) return;
  operations.notify('view:invalidated');
  const hadStrokes = markup.hasStrokes;
  markup.clear(); surface.invalidateScreenHistory();
  if (hadStrokes) showToast('视角已改变，批注已隐藏');
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard || !window.isSecureContext) return false;
  await navigator.clipboard.writeText(value);
  return true;
}

function showManualCopy(value: string): void {
  shareOptions.hidden = true;
  manualCopy.hidden = false;
  manualCopyValue.value = value;
  requestAnimationFrame(selectManualCopy);
}

function selectManualCopy(): void {
  manualCopyValue.focus();
  manualCopyValue.setSelectionRange(0, manualCopyValue.value.length);
}

function resetShareSheet(): void {
  showShareMain();
  manualCopy.hidden = true;
  manualCopyValue.value = '';
}

function renderShareHosts(response: ShareResponse): void {
  shareHostCurrent.textContent = response.origin;
  shareHostList.replaceChildren(...response.hosts.map((host) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'share-host-row';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(host.origin === response.origin));
    row.setAttribute('aria-label', `使用 ${host.origin}`);
    row.innerHTML = `<span><small>${hostKind(host)}</small><code>${escapeHtml(host.origin)}</code></span><i data-lucide="check" aria-hidden="true"></i>`;
    installIcons(row);
    row.addEventListener('click', () => { void selectShareHost(host.origin); });
    return row;
  }));
}

function hostKind(host: HostCandidate): string {
  if (host.primary) return '首选';
  if (host.scope === 'configured') return '已配置';
  if (host.scope === 'current') return '当前地址';
  if (host.scope === 'local') return '本机';
  if (host.address.includes(':')) return host.scope === 'private' ? '私有 IPv6' : 'IPv6';
  return host.scope === 'private' ? '私有网络' : '全局地址';
}

function setShareBusy(busy: boolean): void {
  shareHostTrigger.disabled = busy;
  shareOptions.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((button) => { button.disabled = busy; });
  shareHostList.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = busy; });
}

function openHostPicker(): void {
  shareOptions.hidden = true;
  manualCopy.hidden = true;
  shareHostPicker.hidden = false;
  backHost.hidden = false;
  shareHostTrigger.setAttribute('aria-expanded', 'true');
  shareTitle.textContent = '链接地址';
  requestAnimationFrame(() => shareHostList.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
}

function showShareMain(): void {
  shareOptions.hidden = false;
  shareHostPicker.hidden = true;
  backHost.hidden = true;
  shareHostTrigger.setAttribute('aria-expanded', 'false');
  shareTitle.textContent = '分享';
}

function showToast(message: string): void {
  toast.textContent = message; toast.classList.add('visible'); window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 1800);
}

function formatBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

function savings(raw: number, lod: number): { delta: number; percent: number; comparison: string } {
  const delta = raw - lod;
  const percent = raw > 0 ? Math.round(Math.max(0, delta) / raw * 100) : 0;
  const comparison = delta >= 0 ? `节省 ${percent}%` : `增加 ${formatBytes(-delta)}`;
  return { delta, percent, comparison };
}

function syncSceneMeta(): void {
  if (!scene) return;
  if (!geometryViewer) {
    const documents = scene.entities.filter(entity => entity.source.kind === 'attachment');
    meta.textContent = `${documents.length} 个组件 · ${formatBytes((scene.attachments ?? []).reduce((sum, item) => sum + (item.byte_size ?? 0), 0))} · 2D 画板`;
    return;
  }
  const models = geometryViewer?.modelInfos ?? [];
  const rawBytes = models.reduce((sum, mesh) => sum + mesh.raw_bytes, 0);
  const activeBytes = models.reduce((sum, mesh) => sum + (mesh.quality === 'lod' ? mesh.lod_bytes ?? mesh.raw_bytes : mesh.raw_bytes), 0);
  meta.textContent = `${models.length} ${models.length === 1 ? 'mesh' : 'meshes'} · 当前 ${formatBytes(activeBytes)} · ${savings(rawBytes, activeBytes).comparison}`;
}

function escapeHtml(value: string): string { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
