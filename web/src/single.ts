const exportMode = new URLSearchParams(location.search).has('render');
const sceneId = new URLSearchParams(location.search).get('scene');
const embedded = new URLSearchParams(location.search).has('embedded');
if (exportMode) document.documentElement.classList.add('export-mode');
if (embedded) document.documentElement.classList.add('embedded-scene');
import './styles.css';
import { ComponentViewer } from './component-viewer';
import { ApiError, loadScene, shareScene, type HostCandidate, type MeshQuality, type PublicScene, type ShareResponse } from './api';
import { MarkupCanvas } from './markup';
import { MeshViewer } from './viewer';
import { SurfaceEditor } from './surface';
import { installShortcuts } from './shortcuts';

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const isMobileViewport = (): boolean => matchMedia('(max-width: 759px)').matches;

const shell = $('#app-shell');
const root = $('#canvas-root');
const viewerElement = $('#viewer');
const title = $('#scene-title');
const meta = $('#scene-meta');
const sceneInfo = $('#scene-info');
const sceneInfoToggle = $('#scene-info-toggle');
const meshControls = $('#mesh-controls');
const renderControls = $('#render-controls');
const renderTrigger = $('#render-trigger') as HTMLButtonElement;
const lightControls = $('#light-controls');
const lightAzimuth = $('#light-azimuth') as HTMLInputElement;
const lightElevation = $('#light-elevation') as HTMLInputElement;
const lightIntensity = $('#light-intensity') as HTMLInputElement;
const panelTitle = $('#panel-title');
const panelScroll = $('#panel-scroll');
const loading = $('#loading-state');
const loadingTitle = $('#loading-title');
const loadingMeter = $('#loading-meter');
const loadingBar = $('#loading-bar');
const loadingProgress = $('#loading-progress');
const invalid = $('#invalid-state');
const empty = $('#empty-state');
const panel = $('#control-panel');
const panelContext = $('#panel-context');
const dragZone = $('#panel-drag-zone');
const detailsTrigger = $('.panel-trigger') as HTMLButtonElement;
const detailMeshSelect = $('#detail-mesh-select') as HTMLSelectElement;
const meshVisibleToggle = $('#mesh-visible-toggle') as HTMLInputElement;
const meshLabelText = $('#mesh-label-text') as HTMLInputElement;
const meshSummaryDot = $('#mesh-summary-dot');
const meshSummaryName = $('#mesh-summary-name');
const meshSummaryMeta = $('#mesh-summary-meta');
const lodSaving = $('#lod-saving');
const opacity = $('#opacity-range') as HTMLInputElement;
const opacityValue = $('#opacity-value') as HTMLOutputElement;
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
const palette = ['#8fa9c9', '#8ca49c', '#b2a4ad', '#bf8078', '#8f8bb2', '#b7b3aa'];

// The viewer may be mounted under a configured base path, so the s/v marker
// can sit after an arbitrary prefix (e.g. /blind/s/{token}).
const token = location.pathname.match(/\/(?:s|v)\/([^/]+)$/)?.[1];
const sessionKey = token && sceneId ? `blind.collection.${token}.${sceneId}` : undefined;
// With a <base href> injected, fragment-only links resolve against the base
// URL and would navigate away from the scene; scroll and focus manually.
$('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  viewerElement.focus();
});
let owner = token ? restoreOwner(token) : undefined;
let scene: PublicScene | undefined;
let sceneReady = false;
let components: ComponentViewer | undefined;
let panelOpen = false;
let panelMode: 'mesh' | 'info' | 'render' = 'mesh';
let shareLinks: ShareResponse | undefined;
let shareRequestGeneration = 0;
let shortcutCopyGeneration = 0;
let toastTimer = 0;
let panelHeight = 0;
let dragStart: { y: number; height: number } | null = null;
let suppressHandleClick = false;
let expanded = false;
let loadProgress = { completed: 0, total: 0, rawFallbacks: 0, failed: 0 };
let longLoadTimer = 0;
const meshViewer = new MeshViewer(root);
const markup = new MarkupCanvas($('#markup-canvas') as HTMLCanvasElement);
new ResizeObserver(entries => {
  shell.style.setProperty('--detail-panel-height', `${entries[0].target.getBoundingClientRect().height}px`);
}).observe($('#control-panel'));
const surface = new SurfaceEditor(meshViewer, markup, shell, {closePanel, toast: showToast, change: syncDetailControls});

meshViewer.onSelectionChange = () => {
  components?.selectMesh(meshViewer.selectedIndex); syncDetailControls(); surface.refreshList();
};
meshViewer.onModelChange = () => { syncDetailControls(); syncSceneMeta(); surface.refreshList(); components?.sync(); };
meshViewer.onLoadProgress = (progress) => {
  loadProgress = progress;
  renderLoadProgress();
};
meshViewer.onViewChangeStart = invalidateMarkupForViewChange;
markup.onChange = () => {
  meshViewer.setStrokes(markup.exportStrokes());
  surface.refreshList();
};
markup.onActiveChange = (active) => shell.classList.toggle('drawing-stroke', active);

void start();

function saveEmbeddedState(): import('./api').SceneUpdate | null {
  if (!embedded || !sceneReady || !sessionKey) return null;
  markup.finishActive(); surface.finishForShare();
  const update = meshViewer.exportUpdate();
  sessionStorage.setItem(sessionKey, JSON.stringify(update));
  return update;
}

if (embedded && sceneId) {
  const focusScene = () => parent.postMessage({type:'blind:scene-focus', id:sceneId}, location.origin);
  window.addEventListener('pointerdown', focusScene, true);
  window.addEventListener('focus', focusScene);
  window.addEventListener('focusin', focusScene);
  window.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c' || event.altKey || event.repeat) return;
    if (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable],dialog[open]')) return;
    event.preventDefault();
    parent.postMessage({type:'blind:scene-shortcut', id:sceneId, kind:event.shiftKey ? 'view' : 'image'}, location.origin);
  }, true);
  window.addEventListener('pagehide', () => { saveEmbeddedState(); });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'blind:scene-command' || event.data.id !== sceneId) return;
    const command = event.data.command as string;
    if (command === 'snapshot') {
      parent.postMessage({type:'blind:scene-snapshot', id:sceneId, requestId:event.data.requestId, update:saveEmbeddedState()}, location.origin);
      return;
    }
    if (!sceneReady) return;
    if (command === 'activate') document.documentElement.classList.add('embedded-active');
    if (command === 'deactivate') { document.documentElement.classList.remove('embedded-active'); surface.exit(); closePanel(); saveEmbeddedState(); }
    if (command === 'fit') meshViewer.fitAll();
    if (command === 'details') detailsTrigger.click();
    if (command === 'render') renderTrigger.click();
    if (command === 'annotate') brushTool.click();
    if (command === 'info') sceneInfoToggle.click();
  });
  new MutationObserver(() => parent.postMessage({type:'blind:scene-tool-mode', id:sceneId, annotation:shell.classList.contains('surface-mode')}, location.origin))
    .observe(shell, {attributes:true, attributeFilter:['class']});
}

$('#scene-notice').addEventListener('click', () => openPanel('info'));
sceneInfoToggle.addEventListener('click', () => {
  if (panelOpen && panelMode === 'info') closePanel(); else openPanel('info');
});

async function start(): Promise<void> {
  if (!token) {
    loading.hidden = true; empty.hidden = false;
    hideViewerControls(); return;
  }
  try {
    startLongLoadHint();
    scene = await loadScene(token, owner);
    if (embedded && sessionKey) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? 'null') as import('./api').SceneUpdate | null;
        if (saved && saved.meshes?.length === scene.meshes.length) {
          scene.state = saved.state;
          scene.meshes.forEach((mesh, index) => Object.assign(mesh, saved.meshes[index]));
          if (scene.components && saved.components) {
            for (const component of scene.components) {
              const update = saved.components.find(candidate => candidate.id === component.id);
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
    await meshViewer.load(scene, exportMode);
    if (loadProgress.total > 0 && loadProgress.failed === loadProgress.total && !scene.components?.some(c => c.source.kind === 'attachment')) {
      throw new Error('No models could be loaded');
    }
    $('[data-copy="image"]').hidden = false;
    components = new ComponentViewer(root, meshViewer, scene);
    components.onSelect = () => syncDetailControls();
    components.onChange = () => syncDetailControls();
    window.addEventListener('pagehide', event => { if (!event.persisted) components?.dispose(); });
    markup.load(scene.state.strokes ?? []);
    surface.load();
    owner = scene.owner ? owner : undefined;
    renderMeshOptions(); renderSwatches(); syncDetailControls(); syncSceneMeta();
    const notices = (scene.warnings?.length ?? 0) + loadProgress.failed;
    if (notices > 0) {
      const notice = $('#scene-notice'); notice.hidden = false;
      notice.textContent = `场景部分可用 · ${notices} 项提示`;
      if (loadProgress.failed) {
        const row = document.createElement('p'); row.textContent = `${loadProgress.failed} 个模型加载失败；请检查网络或稍后重试。`; artifactList.prepend(row);
      }
    }
    sceneReady = true;
    finishLoading();
    if (embedded && sceneId) parent.postMessage({type:'blind:scene-ready', id:sceneId}, location.origin);
    if (exportMode) {
      if (loadProgress.failed) throw new Error('Export failed: geometry unavailable');
      await components.ready(); await document.fonts.ready;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      document.documentElement.dataset.renderStatus = 'ready';
    }
  } catch (error) {
    if (embedded && sceneId) parent.postMessage({type:'blind:scene-error', id:sceneId, message:error instanceof Error ? error.message : 'Scene failed'}, location.origin);
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

function restoreOwner(sceneToken: string): string | undefined {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get('owner') ?? undefined;
  if (fromHash) {
    sessionStorage.setItem(`blind.owner.${sceneToken}`, fromHash);
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  return sessionStorage.getItem(`blind.owner.${sceneToken}`) ?? undefined;
}

function hideViewerControls(): void {
  document.querySelectorAll<HTMLElement>('[data-viewer-chrome]').forEach((element) => { element.hidden = true; });
}

function renderMeshOptions(): void {
  detailMeshSelect.replaceChildren(...(components?.components ?? []).map(component => {
    const option = document.createElement('option'); option.value = component.id; option.textContent = component.label; return option;
  }));
}

function renderSwatches(): void {
  const host = $('#color-swatches'); host.replaceChildren();
  palette.forEach((color) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'swatch';
    button.style.setProperty('--swatch', color); button.setAttribute('aria-label', `使用颜色 ${color}`);
    button.addEventListener('click', () => { meshViewer.setColor(color); syncDetailControls(); });
    host.append(button);
  });
}

function syncDetailControls(): void {
  const component = components?.selectedComponent;
  const geometry = !component || component.source.kind === 'mesh';
  document.querySelectorAll<HTMLElement>('[data-geometry-only]').forEach(element => { element.hidden = !geometry; });
  if (component) {
    detailMeshSelect.value = component.id;
    opacity.value = String(Math.round(component.opacity * 100)); opacityValue.value = `${opacity.value}%`;
    meshVisibleToggle.checked = component.visible && component.opacity > 0;
  }
  const state = meshViewer.currentState;
  axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
  syncRenderControls();
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach(button => button.classList.toggle('active', button.dataset.projection === state.projection));
  if (component && !geometry) {
    panelContext.textContent = panelOpen && panelMode === 'mesh' ? component.label : '';
    meshSummaryName.textContent = component.label;
    meshSummaryMeta.textContent = `${component.component.toUpperCase()} · ${formatBytes(scene?.attachments?.[component.source.index]?.byte_size ?? 0)}`;
    meshSummaryDot.style.setProperty('--mesh-color', 'var(--accent)');
    return;
  }
  const selected = meshViewer.selectedModel; if (!selected) return;
  panelContext.textContent = panelOpen && panelMode === 'mesh' ? selected.label?.text ?? selected.name : '';
  if (!component) detailMeshSelect.value = String(meshViewer.selectedIndex);
  meshSummaryName.textContent = selected.label?.text ?? selected.name;
  meshSummaryMeta.textContent = `${selected.format.toUpperCase()} · Raw ${formatBytes(selected.raw_bytes)}`;
  meshSummaryDot.style.setProperty('--mesh-color', selected.color);
  meshVisibleToggle.checked = selected.visible;
  meshLabelText.value = selected.label?.text ?? '';
  opacity.value = String(Math.round(selected.opacity * 100)); opacityValue.value = `${opacity.value}%`;
  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => {
    const quality = button.dataset.quality as MeshQuality;
    button.classList.toggle('active', quality === selected.quality);
    button.setAttribute('aria-pressed', String(quality === selected.quality));
    button.disabled = selected.loading || (quality === 'lod' && meshViewer.annotations.some(mark => mark.mesh === meshViewer.selectedIndex));
  });
  if (meshViewer.annotations.some(mark => mark.mesh === meshViewer.selectedIndex)) lodSaving.textContent = '表面标记使用 Raw，分享后位置保持一致';
  else if (selected.loading) lodSaving.textContent = `正在加载 ${selected.quality === 'lod' ? 'Raw' : 'LOD'} Mesh`;
  else if (selected.lod_bytes !== undefined) {
    const { delta, percent } = savings(selected.raw_bytes, selected.lod_bytes);
    lodSaving.textContent = delta >= 0
      ? `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 节省 ${formatBytes(delta)} (${percent}%)`
      : `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 小型 Mesh 增加 ${formatBytes(-delta)}`;
  } else if (selected.lod_error) lodSaving.textContent = 'LOD 暂不可用，当前已回退到 Raw';
  else lodSaving.textContent = '首次切换到 LOD 后显示节省量';
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((button) => button.classList.toggle('active', button.style.getPropertyValue('--swatch').trim().toLowerCase() === selected.color.toLowerCase()));
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.classList.toggle('active', button.dataset.shading === state.shading));
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.classList.toggle('active', button.dataset.projection === state.projection));
  axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
}

detailsTrigger.addEventListener('click', () => {
  if (panelOpen && panelMode === 'mesh') closePanel(); else openPanel('mesh');
});
renderTrigger.addEventListener('click', () => {
  if (panelOpen && panelMode === 'render') closePanel(); else openPanel('render');
});

function syncRenderControls(): void {
  const mode = meshViewer.renderMode, light = meshViewer.lightSettings;
  document.querySelectorAll<HTMLButtonElement>('[data-render-mode]').forEach(button => {
    const active = button.dataset.renderMode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  lightControls.hidden = mode !== 'raking';
  lightAzimuth.value = String(light.azimuth); lightElevation.value = String(light.elevation); lightIntensity.value = String(Math.round(light.intensity * 100));
  $('#light-azimuth-value').textContent = `${light.azimuth}°`;
  $('#light-elevation-value').textContent = `${light.elevation}°`;
  $('#light-intensity-value').textContent = `${Math.round(light.intensity * 100)}%`;
}

document.querySelectorAll<HTMLButtonElement>('[data-render-mode]').forEach(button => button.addEventListener('click', () => {
  meshViewer.setRenderMode(button.dataset.renderMode as 'matte' | 'raking' | 'normals'); syncRenderControls();
  if (panelOpen && panelMode === 'render' && isMobileViewport() && !expanded) setPanelHeight(innerHeight * renderPanelRatio());
}));
for (const input of [lightAzimuth, lightElevation, lightIntensity]) input.addEventListener('input', () => {
  meshViewer.setLight({azimuth: Number(lightAzimuth.value), elevation: Number(lightElevation.value), intensity: Number(lightIntensity.value) / 100});
  syncRenderControls();
});

meshLabelText.addEventListener('input', () => { meshViewer.setLabel(meshLabelText.value); components?.sync(); });

function openPanel(mode: 'mesh' | 'info' | 'render'): void {
  panelOpen = true; expanded = false;
  panelMode = mode;
  sceneInfo.hidden = mode !== 'info'; meshControls.hidden = mode !== 'mesh'; renderControls.hidden = mode !== 'render';
  panelTitle.textContent = mode === 'info' ? '场景信息' : mode === 'render' ? '渲染检视' : '详情';
  panelScroll.classList.toggle('show-scene-info', mode === 'info');
  panelScroll.scrollTop = 0;
  syncPanelTriggers();
  if (isMobileViewport()) setPanelHeight(innerHeight * (mode === 'render' ? renderPanelRatio() : 0.58));
  dragZone.setAttribute('aria-label', '展开详情面板');
  shell.classList.add('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'false');
  panel.inert = false;
  syncDetailControls();
}

function closePanel(restoreFocus = false): void {
  panelOpen = false; shell.classList.remove('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'true');
  if (restoreFocus) (panelMode === 'info' ? sceneInfoToggle : panelMode === 'render' ? renderTrigger : detailsTrigger).focus();
  panel.inert = true;
  syncPanelTriggers();
  shell.style.setProperty('--sheet-height', '0px');
}

function syncPanelTriggers(): void {
  for (const [trigger, mode] of [[detailsTrigger, 'mesh'], [renderTrigger, 'render'], [sceneInfoToggle, 'info']] as const) {
    const active = panelOpen && panelMode === mode;
    trigger.classList.toggle('active', active);
    trigger.setAttribute('aria-expanded', String(active));
  }
  if (embedded && sceneId) parent.postMessage({type:'blind:scene-panel', id:sceneId, mode:panelOpen ? panelMode : null}, location.origin);
}

function setPanelHeight(value: number): void {
  panelHeight = Math.max(0, Math.min(value, innerHeight * 0.82));
  shell.style.setProperty('--sheet-height', `${panelHeight}px`);
}

function renderPanelRatio(): number { return meshViewer.renderMode === 'raking' ? 0.58 : 0.43; }

dragZone.addEventListener('pointerdown', (event) => {
  if (!panelOpen || !isMobileViewport()) return;
  dragStart = { y: event.clientY, height: panelHeight }; dragZone.setPointerCapture(event.pointerId); panel.classList.add('dragging');
});
dragZone.addEventListener('pointermove', (event) => { if (dragStart) setPanelHeight(dragStart.height + dragStart.y - event.clientY); });
dragZone.addEventListener('pointerup', (event) => {
  if (!dragStart) return; dragZone.releasePointerCapture(event.pointerId); panel.classList.remove('dragging');
  const delta = dragStart.y - event.clientY; dragStart = null;
  suppressHandleClick = Math.abs(delta) > 8;
  if (delta < -90) { closePanel(); return; }
  expanded = panelHeight > innerHeight * 0.68 || delta > 70;
  applyDetailDetent();
});
dragZone.addEventListener('click', () => {
  if (suppressHandleClick) { suppressHandleClick = false; return; }
  if (panelOpen && isMobileViewport()) {
    expanded = !expanded; applyDetailDetent();
  }
});
dragZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    if (panelOpen) { event.preventDefault(); expanded = !expanded; applyDetailDetent(); }
  }
});

function applyDetailDetent(): void {
  setPanelHeight(innerHeight * (expanded ? 0.82 : panelMode === 'render' ? renderPanelRatio() : 0.58));
  panel.classList.toggle('expanded', expanded);
  dragZone.setAttribute('aria-label', expanded ? '收起详情面板' : '展开详情面板');
}

$('#close-panel').addEventListener('click', () => closePanel(true));
panel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closePanel(true); }
});
$('#fit-view').addEventListener('click', () => { meshViewer.fitAll(); showToast('已适配全部可见元素'); });
detailMeshSelect.addEventListener('change', () => components?.selectById(detailMeshSelect.value));
meshVisibleToggle.addEventListener('change', () => components?.setSelectedVisible(meshVisibleToggle.checked));
opacity.addEventListener('input', () => { components?.setSelectedOpacity(Number(opacity.value) / 100); opacityValue.value = `${opacity.value}%`; });
document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => button.addEventListener('click', async () => {
  const quality = button.dataset.quality as MeshQuality;
  try {
    await meshViewer.setQuality(meshViewer.selectedIndex, quality);
    syncDetailControls(); syncSceneMeta();
  } catch (error) {
    showToast(error instanceof Error ? error.message : `无法加载 ${quality.toUpperCase()} Mesh`);
  }
}));
document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.addEventListener('click', () => { meshViewer.setShading(button.dataset.shading as 'smooth' | 'flat' | 'wire'); syncDetailControls(); }));
// Framing changes surface through meshViewer.onViewChangeStart from the viewer
// itself, so programmatic actions clear marks the same way gestures do.
document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.addEventListener('click', () => { meshViewer.setProjection(button.dataset.projection as 'perspective' | 'orthographic'); syncDetailControls(); }));
axesToggle.addEventListener('change', () => meshViewer.setAxes(axesToggle.checked));
lightToggle.addEventListener('change', () => meshViewer.setBackground(lightToggle.checked ? 'light' : 'dark'));

brushTool.addEventListener('click', () => void surface.enter());
$('#share-view').addEventListener('click', async () => {
  if (!token) return;
  const button = $('#share-view') as HTMLButtonElement; button.disabled = true; button.classList.add('working');
  try {
    if (!await refreshShareLinks()) return;
    resetShareSheet();
    shareDialog.showModal();
  } catch (error) { showToast(error instanceof Error ? error.message : '无法创建分享链接'); }
  finally { button.disabled = false; button.classList.remove('working'); }
});

shareHostTrigger.addEventListener('click', openHostPicker);
backHost.addEventListener('click', showShareMain);

async function refreshShareLinks(origin?: string): Promise<ShareResponse | null> {
  if (!token) throw new Error('场景链接不可用');
  const generation = ++shareRequestGeneration;
  markup.finishActive();
  surface.finishForShare();
  let links: ShareResponse;
  try { links = await shareScene(token, meshViewer.exportUpdate(), owner, origin); }
  catch (error) { if (generation !== shareRequestGeneration) return null; throw error; }
  if (generation !== shareRequestGeneration) return null;
  shareLinks = links;
  renderShareHosts(links);
  copyFull.hidden = !links.full_text;
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

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  if (!shareLinks) return;
  const kind = button.dataset.copy as 'view' | 'image' | 'full';
  const value = kind === 'view' ? shareLinks.viewer_url : kind === 'image' ? shareLinks.image_url : shareLinks.full_text;
  if (!value) return;
  try {
    if (await copyText(value)) {
      shareDialog.close();
      showToast(kind === 'view' ? '视角链接已复制' : kind === 'image' ? '图片链接已复制' : '完整信息已复制');
    } else {
      showManualCopy(value);
    }
  } catch {
    showManualCopy(value);
  }
}));
installShortcuts([
  {key: 'c', run: () => copyCurrentLink('image')},
  {key: 'c', shift: true, run: () => copyCurrentLink('view')},
], () => sceneReady && !exportMode && !(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || embedded
  || matchMedia('(pointer: coarse) and (hover: none)').matches));

async function copyCurrentLink(kind: 'image' | 'view'): Promise<void> {
  if (!token) return;
  const generation = ++shortcutCopyGeneration;
  const pending = refreshShareLinks(shareLinks?.origin).then(links => {
    if (!links || generation !== shortcutCopyGeneration) throw new SupersededShare();
    return kind === 'image' ? links.image_url : links.viewer_url;
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
  try {
    const value = await pending;
    if (generation !== shortcutCopyGeneration) return;
    if (writeResult ? await writeResult : await copyText(value).catch(() => false)) {
      if (generation === shortcutCopyGeneration) showToast(kind === 'image' ? '图片链接已复制' : '视角链接已复制');
      return;
    }
    if (generation !== shortcutCopyGeneration) return;
    resetShareSheet(); shareDialog.showModal(); showManualCopy(value);
  } catch (error) {
    if (error instanceof SupersededShare) return;
    if (generation === shortcutCopyGeneration) showToast(error instanceof Error ? error.message : '无法复制链接');
  }
}
class SupersededShare extends Error {}
$('#select-copy').addEventListener('click', selectManualCopy);
$('#back-share').addEventListener('click', resetShareSheet);
$('#close-share').addEventListener('click', () => { shareDialog.close(); resetShareSheet(); });
shareDialog.addEventListener('click', (event) => {
  if (event.target === shareDialog) { shareDialog.close(); resetShareSheet(); }
});

window.addEventListener('resize', () => {
  if (!panelOpen || !isMobileViewport()) return;
  applyDetailDetent();
});
viewerElement.addEventListener('pointerdown', () => $('#gesture-hint').classList.add('dismissed'), { once: true });

function invalidateMarkupForViewChange(): void {
  if (!markup.hasStrokes) return;
  markup.clear();
  surface.invalidateScreenHistory();
  showToast('视角已改变，批注已隐藏');
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
    row.innerHTML = `<span><small>${hostKind(host)}</small><code>${escapeHtml(host.origin)}</code></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.5"/></svg>`;
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
  const models = meshViewer.modelInfos;
  const rawBytes = models.reduce((sum, mesh) => sum + mesh.raw_bytes, 0);
  const activeBytes = models.reduce((sum, mesh) => sum + (mesh.quality === 'lod' ? mesh.lod_bytes ?? mesh.raw_bytes : mesh.raw_bytes), 0);
  meta.textContent = `${models.length} ${models.length === 1 ? 'mesh' : 'meshes'} · 当前 ${formatBytes(activeBytes)} · ${savings(rawBytes, activeBytes).comparison}`;
}

function escapeHtml(value: string): string { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
