import './styles.css';
import { ApiError, loadScene, shareScene, type HostCandidate, type MeshQuality, type PublicScene, type ShareResponse } from './api';
import { MarkupCanvas } from './markup';
import { MeshViewer } from './viewer';

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
const brushToolbar = $('#brush-toolbar');
const brushTool = $('#brush-tool') as HTMLButtonElement;
const drawHint = $('#draw-hint');
const undoBrush = $('#undo-brush') as HTMLButtonElement;
const clearBrush = $('#clear-brush') as HTMLButtonElement;
const palette = ['#8fa9c9', '#8ca49c', '#b2a4ad', '#bf8078', '#8f8bb2', '#b7b3aa'];

const token = location.pathname.match(/^\/(?:s|v)\/([^/]+)$/)?.[1];
let owner = token ? restoreOwner(token) : undefined;
let scene: PublicScene | undefined;
let panelOpen = false;
let panelMode: 'mesh' | 'info' = 'mesh';
let shareLinks: ShareResponse | undefined;
let toastTimer = 0;
let panelHeight = 0;
let dragStart: { y: number; height: number } | null = null;
let suppressHandleClick = false;
let expanded = false;
let loadProgress = { completed: 0, total: 0, rawFallbacks: 0 };
let longLoadTimer = 0;
const meshViewer = new MeshViewer(root);
const markup = new MarkupCanvas($('#markup-canvas') as HTMLCanvasElement);

meshViewer.onSelectionChange = () => {
  syncDetailControls();
};
meshViewer.onModelChange = () => { syncDetailControls(); syncSceneMeta(); };
meshViewer.onLoadProgress = (progress) => {
  loadProgress = progress;
  renderLoadProgress();
};
meshViewer.onViewChangeStart = invalidateMarkupForViewChange;
markup.onChange = () => {
  meshViewer.setStrokes(markup.exportStrokes());
  syncBrushControls();
};
markup.onActiveChange = (active) => shell.classList.toggle('drawing-stroke', active);

void start();

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
    title.textContent = scene.title;
    startLongLoadHint();
    await meshViewer.load(scene);
    markup.load(scene.state.strokes ?? []);
    owner = scene.owner ? owner : undefined;
    renderMeshOptions(); renderSwatches(); syncDetailControls(); syncSceneMeta();
    finishLoading();
  } catch (error) {
    finishLoading(); hideViewerControls();
    invalid.hidden = false;
    if (!(error instanceof ApiError && error.status === 410)) {
      invalid.querySelector('span')!.textContent = error instanceof ApiError ? String(error.status) : 'ERR';
    }
  }
}

function renderLoadProgress(): void {
  const { completed, total, rawFallbacks } = loadProgress;
  const percent = total > 0 ? Math.round(completed / total * 100) : 0;
  loadingMeter.hidden = total === 0;
  loadingMeter.setAttribute('aria-valuenow', String(percent));
  loadingBar.style.setProperty('--loading-progress', `${percent}%`);
  loadingTitle.textContent = completed >= total && total > 0 ? '正在打开场景' : '正在生成 LOD';
  loadingProgress.textContent = total > 0
    ? `${completed} / ${total} Mesh${rawFallbacks > 0 ? ` · ${rawFallbacks} 个回退 Raw` : ''}`
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
  detailMeshSelect.replaceChildren(...meshViewer.modelInfos.map((mesh, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = mesh.name;
    return option;
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
  const selected = meshViewer.selectedModel; if (!selected) return;
  panelContext.textContent = panelOpen && panelMode === 'mesh' ? selected.name : '';
  detailMeshSelect.value = String(meshViewer.selectedIndex);
  meshSummaryName.textContent = selected.name;
  meshSummaryMeta.textContent = `${selected.format.toUpperCase()} · Raw ${formatBytes(selected.raw_bytes)}`;
  meshSummaryDot.style.setProperty('--mesh-color', selected.color);
  meshVisibleToggle.checked = selected.visible;
  meshLabelText.value = selected.label?.text ?? '';
  opacity.value = String(Math.round(selected.opacity * 100)); opacityValue.value = `${opacity.value}%`;
  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((button) => {
    const quality = button.dataset.quality as MeshQuality;
    button.classList.toggle('active', quality === selected.quality);
    button.setAttribute('aria-pressed', String(quality === selected.quality));
    button.disabled = selected.loading;
  });
  if (selected.loading) lodSaving.textContent = `正在加载 ${selected.quality === 'lod' ? 'Raw' : 'LOD'} Mesh`;
  else if (selected.lod_bytes !== undefined) {
    const { delta, percent } = savings(selected.raw_bytes, selected.lod_bytes);
    lodSaving.textContent = delta >= 0
      ? `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 节省 ${formatBytes(delta)} (${percent}%)`
      : `Raw ${formatBytes(selected.raw_bytes)} · LOD ${formatBytes(selected.lod_bytes)} · 小型 Mesh 增加 ${formatBytes(-delta)}`;
  } else if (selected.lod_error) lodSaving.textContent = 'LOD 暂不可用，当前已回退到 Raw';
  else lodSaving.textContent = '首次切换到 LOD 后显示节省量';
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((button) => button.classList.toggle('active', button.style.getPropertyValue('--swatch').trim().toLowerCase() === selected.color.toLowerCase()));
  const state = meshViewer.currentState;
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.classList.toggle('active', button.dataset.shading === state.shading));
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.classList.toggle('active', button.dataset.projection === state.projection));
  axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
}

detailsTrigger.addEventListener('click', () => {
  if (panelOpen && panelMode === 'mesh') closePanel(); else openPanel('mesh');
});

meshLabelText.addEventListener('input', () => meshViewer.setLabel(meshLabelText.value));

function openPanel(mode: 'mesh' | 'info'): void {
  panelOpen = true; expanded = false;
  panelMode = mode;
  sceneInfo.hidden = mode !== 'info'; meshControls.hidden = mode !== 'mesh';
  panelTitle.textContent = mode === 'info' ? '场景信息' : '详情';
  panelScroll.classList.toggle('show-scene-info', mode === 'info');
  panelScroll.scrollTop = 0;
  syncPanelTriggers();
  if (isMobileViewport()) setPanelHeight(innerHeight * 0.58);
  dragZone.setAttribute('aria-label', '展开详情面板');
  shell.classList.add('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'false');
  panel.inert = false;
  syncDetailControls();
}

function closePanel(restoreFocus = false): void {
  panelOpen = false; shell.classList.remove('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'true');
  if (restoreFocus) (panelMode === 'info' ? sceneInfoToggle : detailsTrigger).focus();
  panel.inert = true;
  syncPanelTriggers();
  shell.style.setProperty('--sheet-height', '0px');
}

function syncPanelTriggers(): void {
  for (const [trigger, mode] of [[detailsTrigger, 'mesh'], [sceneInfoToggle, 'info']] as const) {
    const active = panelOpen && panelMode === mode;
    trigger.classList.toggle('active', active);
    trigger.setAttribute('aria-expanded', String(active));
  }
}

function setPanelHeight(value: number): void {
  panelHeight = Math.max(0, Math.min(value, innerHeight * 0.82));
  shell.style.setProperty('--sheet-height', `${panelHeight}px`);
}

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
  setPanelHeight(innerHeight * (expanded ? 0.82 : 0.58));
  panel.classList.toggle('expanded', expanded);
  dragZone.setAttribute('aria-label', expanded ? '收起详情面板' : '展开详情面板');
}

$('#close-panel').addEventListener('click', () => closePanel(true));
panel.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closePanel(true); }
});
$('#fit-view').addEventListener('click', () => { meshViewer.fitAll(); showToast('已适配全部可见 Mesh'); });
detailMeshSelect.addEventListener('change', () => meshViewer.select(Number(detailMeshSelect.value)));
meshVisibleToggle.addEventListener('change', () => meshViewer.setVisible(meshViewer.selectedIndex, meshVisibleToggle.checked));
opacity.addEventListener('input', () => { meshViewer.setOpacity(Number(opacity.value) / 100); opacityValue.value = `${opacity.value}%`; });
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

const axisOrb = $('#axis-orb'); const viewPopover = $('#view-popover');
axisOrb.addEventListener('click', () => { const open = !viewPopover.classList.contains('open'); viewPopover.classList.toggle('open', open); viewPopover.setAttribute('aria-hidden', String(!open)); axisOrb.setAttribute('aria-expanded', String(open)); });
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => { meshViewer.setCanonicalView(button.dataset.view!); viewPopover.classList.remove('open'); }));

$('#fullscreen').addEventListener('click', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.requestFullscreen(); });

brushTool.addEventListener('click', enterDrawMode);
$('#finish-brush').addEventListener('click', exitDrawMode);
undoBrush.addEventListener('click', () => markup.undo());
clearBrush.addEventListener('click', () => markup.clear());
document.querySelectorAll<HTMLButtonElement>('[data-brush-color]').forEach((button) => button.addEventListener('click', () => {
  const color = button.dataset.brushColor!;
  markup.setColor(color);
  document.querySelectorAll<HTMLButtonElement>('[data-brush-color]').forEach((candidate) => {
    const active = candidate === button;
    candidate.classList.toggle('active', active);
    candidate.setAttribute('aria-pressed', String(active));
  });
}));

$('#share-view').addEventListener('click', async () => {
  if (!token) return;
  const button = $('#share-view') as HTMLButtonElement; button.disabled = true; button.classList.add('working');
  try {
    await refreshShareLinks();
    resetShareSheet();
    shareDialog.showModal();
  } catch (error) { showToast(error instanceof Error ? error.message : '无法创建分享链接'); }
  finally { button.disabled = false; button.classList.remove('working'); }
});

shareHostTrigger.addEventListener('click', openHostPicker);
backHost.addEventListener('click', showShareMain);

async function refreshShareLinks(origin?: string): Promise<void> {
  if (!token) return;
  markup.finishActive();
  shareLinks = await shareScene(token, meshViewer.exportUpdate(), owner, origin);
  renderShareHosts(shareLinks);
  copyFull.hidden = !shareLinks.full_text;
}

async function selectShareHost(origin: string): Promise<void> {
  if (!token || !shareLinks) return;
  setShareBusy(true);
  try {
    await refreshShareLinks(origin);
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

function enterDrawMode(): void {
  if (markup.isEnabled) return;
  closePanel();
  viewPopover.classList.remove('open');
  viewPopover.setAttribute('aria-hidden', 'true');
  axisOrb.setAttribute('aria-expanded', 'false');
  markup.setEnabled(true);
  meshViewer.setInteractionEnabled(false);
  shell.classList.add('draw-mode');
  brushToolbar.hidden = false;
  drawHint.hidden = false;
  brushTool.setAttribute('aria-pressed', 'true');
  syncBrushControls();
  meshViewer.refreshLabels();
}

function exitDrawMode(): void {
  if (!markup.isEnabled) return;
  markup.setEnabled(false);
  meshViewer.setInteractionEnabled(true);
  shell.classList.remove('draw-mode', 'drawing-stroke');
  brushToolbar.hidden = true;
  drawHint.hidden = true;
  brushTool.setAttribute('aria-pressed', 'false');
  meshViewer.refreshLabels();
}

function invalidateMarkupForViewChange(): void {
  if (!markup.hasStrokes) return;
  markup.clear();
  showToast('视角已改变，批注已隐藏');
}

function syncBrushControls(): void {
  undoBrush.disabled = clearBrush.disabled = !markup.hasStrokes;
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
