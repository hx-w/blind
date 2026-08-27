import './styles.css';
import { ApiError, loadScene, shareScene, type PublicScene, type ShareLinks } from './api';
import { MeshViewer } from './viewer';

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
const gridToggle = $('#grid-toggle') as HTMLInputElement;
const axesToggle = $('#axes-toggle') as HTMLInputElement;
const lightToggle = $('#light-toggle') as HTMLInputElement;
const shareDialog = $('#share-sheet') as HTMLDialogElement;
const copyFull = $('#copy-full');
const toast = $('#toast');
const palette = ['#8fa9c9', '#8ca49c', '#b2a4ad', '#bf8078', '#8f8bb2', '#b7b3aa'];

const token = location.pathname.match(/^\/v\/([^/]+)$/)?.[1];
let owner = token ? restoreOwner(token) : undefined;
let scene: PublicScene | undefined;
let activePanel: 'meshes' | 'style' | null = null;
let shareLinks: ShareLinks | undefined;
let toastTimer = 0;
let panelHeight = 0;
let dragStart: { y: number; height: number } | null = null;
let suppressHandleClick = false;
let expanded = false;
const meshViewer = new MeshViewer(root);

meshViewer.onSelectionChange = () => {
  renderMeshList(); syncStyleControls();
};

void start();

async function start(): Promise<void> {
  if (!token) {
    loading.hidden = true; empty.hidden = false;
    hideViewerControls(); return;
  }
  try {
    scene = await loadScene(token, owner);
    await meshViewer.load(scene);
    title.textContent = scene.title;
    meta.textContent = `${scene.meshes.length} ${scene.meshes.length === 1 ? 'mesh' : 'meshes'} · ${formatBytes(scene.meshes.reduce((sum, mesh) => sum + mesh.byte_size, 0))}`;
    meshCount.textContent = String(scene.meshes.length);
    owner = scene.owner ? owner : undefined;
    renderMeshList(); renderSwatches(); syncStyleControls();
    loading.hidden = true;
  } catch (error) {
    loading.hidden = true; hideViewerControls();
    if (error instanceof ApiError && error.status === 410) invalid.hidden = false;
    else { invalid.hidden = false; invalid.querySelector('span')!.textContent = error instanceof ApiError ? String(error.status) : 'ERR'; }
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
  document.querySelectorAll<HTMLElement>('.review-dock,.top-actions,.view-control,.gesture-hint').forEach((element) => { element.hidden = true; });
}

function renderMeshList(): void {
  meshList.replaceChildren();
  meshViewer.modelInfos.forEach((mesh, index) => {
    const row = document.createElement('div'); row.className = `mesh-row${index === meshViewer.selectedIndex ? ' selected' : ''}`;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'mesh-select';
    select.setAttribute('aria-label', `选择 ${mesh.name}`);
    select.innerHTML = `<span class="mesh-dot" style="--mesh-color:${escapeAttribute(mesh.color)}"></span><span class="mesh-copy"><strong>${escapeHtml(mesh.name)}</strong><small>${mesh.format.toUpperCase()} · ${formatBytes(mesh.byte_size)}</small></span>`;
    select.addEventListener('click', () => { meshViewer.select(index); if (matchMedia('(max-width: 759px)').matches) closePanel(); });
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
  document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((button) => button.classList.toggle('active', rgbToHex(button.style.getPropertyValue('--swatch')) === selected.color.toLowerCase()));
  const state = meshViewer.currentState;
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((button) => button.classList.toggle('active', button.dataset.shading === state.shading));
  document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.classList.toggle('active', button.dataset.projection === state.projection));
  gridToggle.checked = state.grid; axesToggle.checked = state.axes; lightToggle.checked = state.background === 'light';
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
  if (matchMedia('(max-width: 759px)').matches) {
    panelHeight = kind === 'meshes' ? Math.min(innerHeight * 0.52, 62 + meshViewer.modelCount * 58) : innerHeight * 0.44;
    setPanelHeight(panelHeight);
  }
  dragZone.setAttribute('aria-label', kind === 'style' ? '展开样式面板' : '关闭 Mesh 面板');
  shell.classList.add('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'false');
  syncStyleControls(); requestAnimationFrame(() => meshViewer.resize());
}

function closePanel(): void {
  activePanel = null; shell.classList.remove('panel-open'); panel.classList.remove('expanded'); panel.setAttribute('aria-hidden', 'true');
  document.querySelectorAll<HTMLButtonElement>('.panel-trigger').forEach((button) => { button.classList.remove('active'); button.setAttribute('aria-expanded', 'false'); });
  shell.style.setProperty('--sheet-height', '0px'); requestAnimationFrame(() => meshViewer.resize());
}

function setPanelHeight(value: number): void {
  panelHeight = Math.max(0, Math.min(value, innerHeight * 0.82));
  shell.style.setProperty('--sheet-height', `${panelHeight}px`);
  requestAnimationFrame(() => meshViewer.resize());
}

dragZone.addEventListener('pointerdown', (event) => {
  if (!activePanel || !matchMedia('(max-width: 759px)').matches) return;
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
  } else setPanelHeight(Math.min(innerHeight * 0.52, 62 + meshViewer.modelCount * 58));
});
dragZone.addEventListener('click', () => {
  if (suppressHandleClick) { suppressHandleClick = false; return; }
  if (activePanel === 'style' && matchMedia('(max-width: 759px)').matches) {
    expanded = !expanded; applyStyleDetent();
  } else if (activePanel === 'meshes' && matchMedia('(max-width: 759px)').matches) {
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
document.querySelectorAll<HTMLButtonElement>('[data-projection]').forEach((button) => button.addEventListener('click', () => { meshViewer.setProjection(button.dataset.projection as 'perspective' | 'orthographic'); syncStyleControls(); }));
gridToggle.addEventListener('change', () => meshViewer.setGrid(gridToggle.checked));
axesToggle.addEventListener('change', () => meshViewer.setAxes(axesToggle.checked));
lightToggle.addEventListener('change', () => meshViewer.setBackground(lightToggle.checked ? 'light' : 'dark'));

const axisOrb = $('#axis-orb'); const viewPopover = $('#view-popover');
axisOrb.addEventListener('click', () => { const open = !viewPopover.classList.contains('open'); viewPopover.classList.toggle('open', open); viewPopover.setAttribute('aria-hidden', String(!open)); axisOrb.setAttribute('aria-expanded', String(open)); });
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => { meshViewer.setCanonicalView(button.dataset.view!); viewPopover.classList.remove('open'); }));

$('#fullscreen').addEventListener('click', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.requestFullscreen(); });

$('#share-view').addEventListener('click', async () => {
  if (!token) return;
  const button = $('#share-view') as HTMLButtonElement; button.disabled = true; button.classList.add('working');
  try {
    shareLinks = await shareScene(token, meshViewer.exportUpdate(), owner);
    copyFull.hidden = !shareLinks.full_text;
    shareDialog.showModal();
  } catch (error) { showToast(error instanceof Error ? error.message : '无法创建分享链接'); }
  finally { button.disabled = false; button.classList.remove('working'); }
});

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  if (!shareLinks) return;
  const kind = button.dataset.copy as 'view' | 'image' | 'full';
  const value = kind === 'view' ? shareLinks.viewer_url : kind === 'image' ? shareLinks.image_url : shareLinks.full_text;
  if (!value) return;
  try {
    await copyText(value);
    shareDialog.close();
    showToast(kind === 'view' ? '视角链接已复制' : kind === 'image' ? '图片链接已复制' : '完整信息已复制');
  } catch {
    showToast('复制失败，请使用安全连接后重试');
  }
}));
$('#close-share').addEventListener('click', () => shareDialog.close());
shareDialog.addEventListener('click', (event) => { if (event.target === shareDialog) shareDialog.close(); });

window.addEventListener('resize', () => {
  if (activePanel && matchMedia('(max-width: 759px)').matches) openPanel(activePanel);
  else meshViewer.resize();
});
viewerElement.addEventListener('pointerdown', () => $('#gesture-hint').classList.add('dismissed'), { once: true });

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return; }
  const textarea = document.createElement('textarea'); textarea.value = value; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
  document.body.append(textarea); textarea.select();
  const copied = document.execCommand('copy'); textarea.remove();
  if (!copied) throw new Error('clipboard unavailable');
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
function rgbToHex(value: string): string { return value.trim().toLowerCase(); }
