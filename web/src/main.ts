import './styles.css';
import { ApiError, loadScene, shareScene, type HostCandidate, type PublicScene, type ShareResponse } from './api';
import { MarkupCanvas } from './markup';
import { MeshViewer } from './viewer';

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

const isMobileViewport = (): boolean => matchMedia('(max-width: 759px)').matches;
const meshSheetHeight = (): number => Math.min(innerHeight * 0.52, 62 + meshViewer.modelCount * 58);

const shell = $('#app-shell');
const root = $('#canvas-root');
const viewerElement = $('#viewer');
const title = $('#scene-title');
const meta = $('#scene-meta');
const loading = $('#loading-state');
const invalid = $('#invalid-state');
const empty = $('#empty-state');
const panel = $('#control-panel');
const panelTitle = $('#panel-title');
const panelContext = $('#panel-context');
const dragZone = $('#panel-drag-zone');
const meshList = $('#mesh-list');
const meshCount = $('#mesh-count');
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
let activePanel: 'meshes' | 'style' | null = null;
let shareLinks: ShareResponse | undefined;
let toastTimer = 0;
let panelHeight = 0;
let dragStart: { y: number; height: number } | null = null;
let suppressHandleClick = false;
let expanded = false;
const meshViewer = new MeshViewer(root);
const markup = new MarkupCanvas($('#markup-canvas') as HTMLCanvasElement);

meshViewer.onSelectionChange = () => {
  renderMeshList(); syncStyleControls();
};
meshViewer.onViewChangeStart = invalidateMarkupForViewChange;
markup.onChange = () => {
  meshViewer.setStrokes(markup.exportStrokes());
  syncBrushControls();
};
markup.onActiveChange = (active) => shell.classList.toggle('drawing-stroke', active);

void start();

async function start(): Promise<void> {
  if (!token) {
    loading.hidden = true; empty.hidden = false;
    hideViewerControls(); return;
  }
  try {
    scene = await loadScene(token, owner);
    await meshViewer.load(scene);
    markup.load(scene.state.strokes ?? []);
    title.textContent = scene.title;
    meta.textContent = `${scene.meshes.length} ${scene.meshes.length === 1 ? 'mesh' : 'meshes'} · ${formatBytes(scene.meshes.reduce((sum, mesh) => sum + mesh.byte_size, 0))}`;
    meshCount.textContent = String(scene.meshes.length);
    owner = scene.owner ? owner : undefined;
    renderMeshList(); renderSwatches(); syncStyleControls();
    loading.hidden = true;
  } catch (error) {
    loading.hidden = true; hideViewerControls();
    invalid.hidden = false;
    if (!(error instanceof ApiError && error.status === 410)) {
      invalid.querySelector('span')!.textContent = error instanceof ApiError ? String(error.status) : 'ERR';
    }
  }
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

function renderMeshList(): void {
  meshList.replaceChildren();
  meshViewer.modelInfos.forEach((mesh, index) => {
    const row = document.createElement('div'); row.className = `mesh-row${index === meshViewer.selectedIndex ? ' selected' : ''}`;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'mesh-select';
    select.setAttribute('aria-label', `选择 ${mesh.name}`);
    select.innerHTML = `<span class="mesh-dot" style="--mesh-color:${escapeAttribute(mesh.color)}"></span><span class="mesh-copy"><strong>${escapeHtml(mesh.name)}</strong><small>${mesh.format.toUpperCase()} · ${formatBytes(mesh.byte_size)}</small></span>`;
    select.addEventListener('click', () => { meshViewer.select(index); if (isMobileViewport()) closePanel(); });
    const eye = document.createElement('button'); eye.type = 'button'; eye.className = 'mesh-eye';
    eye.setAttribute('aria-label', mesh.visible ? `隐藏 ${mesh.name}` : `显示 ${mesh.name}`);
    eye.setAttribute('aria-pressed', String(mesh.visible)); eye.innerHTML = eyeIcon(mesh.visible);
    eye.addEventListener('click', () => { meshViewer.setVisible(index, !mesh.visible); renderMeshList(); });
    row.append(select, eye); meshList.append(row);
  });
}

function renderSwatches(): void {
  const host = $('#color-swatches'); host.replaceChildren();
  palette.forEach((color) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'swatch';
    button.style.setProperty('--swatch', color); button.setAttribute('aria-label', `使用颜色 ${color}`);
    button.addEventListener('click', () => { meshViewer.setColor(color); syncStyleControls(); renderMeshList(); });
    host.append(button);
  });
}

function syncStyleControls(): void {
  const selected = meshViewer.selectedModel; if (!selected) return;
  panelContext.textContent = activePanel === 'style' ? selected.name : '';
  opacity.value = String(Math.round(selected.opacity * 100)); opacityValue.value = `${opacity.value}%`;
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((button) => button.classList.toggle('active', button.style.getPropertyValue('--swatch').trim().toLowerCase() === selected.color.toLowerCase()));
  const state = meshViewer.currentState;
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.classList.toggle('active', button.dataset.shading === state.shading));
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.classList.toggle('active', button.dataset.projection === state.projection));
  axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
}

document.querySelectorAll<HTMLButtonElement>('.panel-trigger').forEach((button) => button.addEventListener('click', () => {
  const target = button.dataset.panel as 'meshes' | 'style';
  if (activePanel === target) closePanel(); else openPanel(target);
}));

function openPanel(kind: 'meshes' | 'style'): void {
  activePanel = kind; expanded = false;
  panelTitle.textContent = kind === 'meshes' ? 'Mesh' : '样式';
  panelContext.textContent = kind === 'style' ? meshViewer.selectedModel?.name ?? '' : '';
  document.querySelectorAll<HTMLElement>('[data-panel-content]').forEach((section) => { section.hidden = section.dataset.panelContent !== kind; });
  document.querySelectorAll<HTMLButtonElement>('.panel-trigger').forEach((button) => {
    const active = button.dataset.panel === kind; button.classList.toggle('active', active); button.setAttribute('aria-expanded', String(active));
  });
  if (isMobileViewport()) {
    panelHeight = kind === 'meshes' ? meshSheetHeight() : innerHeight * 0.44;
    setPanelHeight(panelHeight);
  }
  dragZone.setAttribute('aria-label', kind === 'style' ? '展开样式面板' : '关闭 Mesh 面板');
  shell.classList.add('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'false');
  syncStyleControls();
}

function closePanel(): void {
  activePanel = null; shell.classList.remove('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'true');
  document.querySelectorAll<HTMLButtonElement>('.panel-trigger').forEach((button) => { button.classList.remove('active'); button.setAttribute('aria-expanded', 'false'); });
  shell.style.setProperty('--sheet-height', '0px');
}

function setPanelHeight(value: number): void {
  panelHeight = Math.max(0, Math.min(value, innerHeight * 0.82));
  shell.style.setProperty('--sheet-height', `${panelHeight}px`);
}

dragZone.addEventListener('pointerdown', (event) => {
  if (!activePanel || !isMobileViewport()) return;
  dragStart = { y: event.clientY, height: panelHeight }; dragZone.setPointerCapture(event.pointerId); panel.classList.add('dragging');
});
dragZone.addEventListener('pointermove', (event) => { if (dragStart) setPanelHeight(dragStart.height + dragStart.y - event.clientY); });
dragZone.addEventListener('pointerup', (event) => {
  if (!dragStart) return; dragZone.releasePointerCapture(event.pointerId); panel.classList.remove('dragging');
  const delta = dragStart.y - event.clientY; dragStart = null;
  suppressHandleClick = Math.abs(delta) > 8;
  if (delta < -90) { closePanel(); return; }
  if (activePanel === 'style') {
    expanded = panelHeight > innerHeight * 0.62 || delta > 70;
    applyStyleDetent();
  } else setPanelHeight(meshSheetHeight());
});
dragZone.addEventListener('click', () => {
  if (suppressHandleClick) { suppressHandleClick = false; return; }
  if (activePanel === 'style' && isMobileViewport()) {
    expanded = !expanded; applyStyleDetent();
  } else if (activePanel === 'meshes' && isMobileViewport()) {
    closePanel();
  }
});
dragZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    if (activePanel === 'style') { event.preventDefault(); expanded = !expanded; applyStyleDetent(); }
    else if (activePanel === 'meshes') { event.preventDefault(); closePanel(); }
  }
});

function applyStyleDetent(): void {
  setPanelHeight(innerHeight * (expanded ? 0.82 : 0.44));
  panel.classList.toggle('expanded', expanded);
  dragZone.setAttribute('aria-label', expanded ? '收起样式面板' : '展开样式面板');
}

$('#close-panel').addEventListener('click', closePanel);
$('#fit-view').addEventListener('click', () => { meshViewer.fitAll(); showToast('已适配全部可见 Mesh'); });
opacity.addEventListener('input', () => { meshViewer.setOpacity(Number(opacity.value) / 100); opacityValue.value = `${opacity.value}%`; });
document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.addEventListener('click', () => { meshViewer.setShading(button.dataset.shading as 'smooth' | 'flat' | 'wire'); syncStyleControls(); }));
// Framing changes surface through meshViewer.onViewChangeStart from the viewer
// itself, so programmatic actions clear marks the same way gestures do.
document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.addEventListener('click', () => { meshViewer.setProjection(button.dataset.projection as 'perspective' | 'orthographic'); syncStyleControls(); }));
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
  if (!activePanel || !isMobileViewport()) return;
  if (activePanel === 'meshes') setPanelHeight(meshSheetHeight());
  else applyStyleDetent();
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
}

function exitDrawMode(): void {
  if (!markup.isEnabled) return;
  markup.setEnabled(false);
  meshViewer.setInteractionEnabled(true);
  shell.classList.remove('draw-mode', 'drawing-stroke');
  brushToolbar.hidden = true;
  drawHint.hidden = true;
  brushTool.setAttribute('aria-pressed', 'false');
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

function eyeIcon(visible: boolean): string {
  return visible
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z"/><circle cx="12" cy="12" r="2.5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16M10.6 7.2A9.3 9.3 0 0 1 12 7c5.8 0 9 5 9 5a15 15 0 0 1-2.1 2.6M6.4 8.3A15.5 15.5 0 0 0 3 12s3.2 5 9 5c.9 0 1.8-.1 2.6-.4"/></svg>';
}

function escapeHtml(value: string): string { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }
function escapeAttribute(value: string): string { return value.replace(/["'<>]/g, ''); }
