import './collection.css';
import {loadCollection, shareCollection, type CollectionOverview, type SceneUpdate, type ShareResponse, type ScreenStroke, type CollectionLayout} from './api';
import {MarkupCanvas} from './markup';
import {takeInitialScene} from './bootstrap';

const token = location.pathname.match(/\/s\/([^/]+)$/)?.[1] ?? '';
if (!token) throw new Error('Missing collection token');
const owner = sessionStorage.getItem(`blind.owner.${token}`) ?? undefined;
const originalDock = document.querySelector('.review-dock')!.cloneNode(true) as HTMLElement;
const originalShare = originalDock.querySelector<HTMLButtonElement>('#share-view')!;
originalShare.setAttribute('aria-label', '分享全部场景');
const shell = document.createElement('div'); shell.className = 'app-shell collection-shell';
const tabs = document.createElement('nav'); tabs.className = 'collection-tabs'; tabs.setAttribute('aria-label', '场景');
const stage = document.createElement('main'); stage.className = 'collection-stage'; stage.setAttribute('aria-label', '多场景视图');
const inkCanvas = document.createElement('canvas'); inkCanvas.className = 'markup-canvas collection-markup'; inkCanvas.setAttribute('aria-label', '全部场景屏幕画笔');
const inkBadges = document.createElement('div'); inkBadges.className = 'collection-ink-badges';
stage.append(inkCanvas, inkBadges);
const dialog = document.createElement('dialog'); dialog.className = 'collection-share';
const toast = document.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status');
shell.append(tabs, stage, originalDock, dialog, toast); document.body.replaceChildren(shell);

let overview: CollectionOverview;
let active = new URLSearchParams(location.search).get('scene') ?? '';
let mode: 'split' | 'tabs' = 'tabs';
let cards = new Map<string, HTMLElement>();
let frames = new Map<string, HTMLIFrameElement>();
let ready = new Set<string>();
let snapshotSequence = 0;
let copySequence = 0;
let shareLinks: ShareResponse | undefined;
let toastTimer = 0;
let layoutQueue = Promise.resolve();
let toolbar: HTMLElement | undefined;
type AnnotationMode = 'select' | 'point' | 'line' | 'screen';
let annotationMode: AnnotationMode | null = null;
let color = '#ff6b5e';
let selectedStroke: number | undefined;
let strokeBefore: ScreenStroke[] | undefined;
let strokeLayout: CollectionLayout | undefined;
const strokeHistory: ScreenStroke[][] = [];
const strokeFuture: ScreenStroke[][] = [];
const markup = new MarkupCanvas(inkCanvas);
markup.onStrokeStart = () => {strokeBefore = markup.exportStrokes(); selectedStroke = undefined;};
markup.onStrokeEnd = () => {
  if (strokeBefore && markup.exportStrokes().length > strokeBefore.length) {
    strokeHistory.push(strokeBefore); if (strokeHistory.length > 40) strokeHistory.shift(); strokeFuture.length = 0;
    selectedStroke = markup.exportStrokes().length - 1;
    strokeLayout ??= currentLayout();
  }
  strokeBefore = undefined; syncToolbar();
};
markup.onChange = () => {shareLinks = undefined; renderInkBadges(); syncToolbar();};

function sendSurface(control: string, value?: string): void {
  frames.get(active)?.contentWindow?.postMessage({type:'blind:scene-command', id:active, command:'surface-control', control, value}, location.origin);
}
function sendScope(id: string): void {
  frames.get(id)?.contentWindow?.postMessage({type:'blind:scene-command',id,command:'screen-scope',value:mode==='tabs'?'scene':'global'},location.origin);
}
function currentLayout(): CollectionLayout {
  if (mode === 'tabs') {
    const columns=Math.ceil(Math.sqrt(overview.scenes.length));
    const rows=Math.ceil(overview.scenes.length/columns);
    const rect=stage.getBoundingClientRect();
    let tileWidth=Math.round(rect.width), tileHeight=Math.round(rect.height)+35;
    const extent=(width:number,height:number) => ({width:16+columns*width+(columns-1)*8,height:16+rows*height+(rows-1)*8});
    const full=extent(tileWidth,tileHeight);
    const scale=Math.min(1,4096/full.width,4096/full.height,Math.sqrt(16_000_000/(full.width*full.height)));
    tileWidth=Math.max(160,Math.floor(tileWidth*scale));tileHeight=Math.max(135,Math.floor(tileHeight*scale));
    return {columns,...extent(tileWidth,tileHeight)};
  }
  const rect=stage.getBoundingClientRect();
  return {width:Math.round(rect.width),height:Math.round(rect.height),columns:getComputedStyle(stage).gridTemplateColumns.split(' ').length};
}
function rememberStrokes(): void {strokeHistory.push(markup.exportStrokes()); if (strokeHistory.length > 40) strokeHistory.shift(); strokeFuture.length = 0;}
function exitAnnotation(): void {
  markup.finishActive(); markup.setEnabled(false); annotationMode = null;
  shell.classList.remove('annotation-mode');
  if (toolbar) toolbar.hidden = true;
  originalDock.append(originalShare);
}
function renderInkBadges(): void {
  inkBadges.replaceChildren();
  markup.exportStrokes().forEach((stroke, index) => {
    const points = markup.displayPoints(index); const point = points[Math.floor(points.length / 2)]; if (!point) return;
    const bounds = stage.getBoundingClientRect();
    const button = document.createElement('button'); button.type = 'button'; button.textContent = stroke.label || `画笔 ${index + 1}`;
    button.style.left = `${point[0] - bounds.left}px`; button.style.top = `${point[1] - bounds.top}px`;
    button.style.setProperty('--ink', stroke.color); button.classList.toggle('selected', selectedStroke === index);
    button.addEventListener('click', () => { if (!annotationMode) beginAnnotation(); selectedStroke=index; annotationMode='screen'; markup.setEnabled(true); sendSurface('mode','screen'); syncToolbar(); });
    inkBadges.append(button);
  });
}
function ensureToolbar(id: string): void {
  if (toolbar) return;
  const source = frames.get(id)?.contentDocument?.querySelector<HTMLElement>('#surface-toolbar');
  if (!source) return;
  toolbar = source.cloneNode(true) as HTMLElement; toolbar.hidden = true; shell.append(toolbar);
  toolbar.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return;
    if (button.dataset.surfaceMode) {
      annotationMode = button.dataset.surfaceMode as AnnotationMode;
      if (annotationMode === 'screen') markup.setEnabled(mode==='split');
      else {markup.finishActive(); markup.setEnabled(false); selectedStroke=undefined;}
      sendSurface('mode', button.dataset.surfaceMode); syncToolbar(); return;
    }
    if (button.dataset.surfaceColor) {
      color=button.dataset.surfaceColor; markup.setColor(color);
      if (annotationMode === 'screen' && mode==='split' && selectedStroke !== undefined) {
        rememberStrokes(); const strokes=markup.exportStrokes(); strokes[selectedStroke].color=color; markup.load(strokes);
      }
      sendSurface('color',color); syncToolbar(); return;
    }
    const action = button.id.replace(/^surface-/, '');
    if (action === 'done') {sendSurface('done'); exitAnnotation(); return;}
    if (annotationMode === 'screen' && mode==='split' && ['undo','redo','delete'].includes(action)) {
      if (action === 'delete' && selectedStroke !== undefined) {rememberStrokes(); const strokes=markup.exportStrokes(); strokes.splice(selectedStroke,1); selectedStroke=undefined; markup.load(strokes);}
      if (action === 'undo' && strokeHistory.length) {strokeFuture.push(markup.exportStrokes()); markup.load(strokeHistory.pop()!); selectedStroke=undefined;}
      if (action === 'redo' && strokeFuture.length) {strokeHistory.push(markup.exportStrokes()); markup.load(strokeFuture.pop()!); selectedStroke=undefined;}
      syncToolbar(); return;
    }
    if (['undo','redo','close','end','delete'].includes(action)) sendSurface(action);
  });
  toolbar.querySelector<HTMLInputElement>('#surface-name')?.addEventListener('change', event => {
    const value = (event.target as HTMLInputElement).value.trim();
    if (annotationMode === 'screen' && mode==='split' && selectedStroke !== undefined) {
      rememberStrokes(); const strokes=markup.exportStrokes(); strokes[selectedStroke].label=value || undefined; markup.load(strokes);
    } else sendSurface('name',value);
  });
}
function syncToolbar(): void {
  if (!toolbar) return;
  toolbar.hidden = annotationMode === null;
  if (annotationMode === null) return;
  const source = frames.get(active)?.contentDocument?.querySelector<HTMLElement>('#surface-toolbar');
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-surface-mode]')) {
    const on = button.dataset.surfaceMode === annotationMode;
    button.classList.toggle('active',on); button.setAttribute('aria-pressed',String(on));
  }
  for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-surface-color]'))
    button.setAttribute('aria-pressed',String(button.dataset.surfaceColor === color));
  if (annotationMode === 'screen' && mode==='split') {
    const stroke = markup.exportStrokes()[selectedStroke ?? -1];
    toolbar.querySelector<HTMLElement>('.surface-selection')!.hidden = !stroke;
    const input=toolbar.querySelector<HTMLInputElement>('#surface-name')!;
    if (document.activeElement !== input) input.value=stroke?.label || `画笔 ${(selectedStroke ?? 0)+1}`;
    toolbar.querySelector<HTMLButtonElement>('#surface-undo')!.disabled=!strokeHistory.length;
    toolbar.querySelector<HTMLButtonElement>('#surface-redo')!.disabled=!strokeFuture.length;
    toolbar.querySelector<HTMLButtonElement>('#surface-close')!.hidden=true;
    toolbar.querySelector<HTMLButtonElement>('#surface-end')!.hidden=true;
    toolbar.querySelector<HTMLElement>('#surface-hint')!.textContent='全部场景画笔 · 可跨场景划线';
  } else if (source) {
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-surface-color]')) {
      const pressed=source.querySelector<HTMLButtonElement>(`[data-surface-color="${button.dataset.surfaceColor}"]`)?.getAttribute('aria-pressed')==='true';
      button.setAttribute('aria-pressed',String(pressed));
      if (pressed) {color=button.dataset.surfaceColor!;markup.setColor(color);}
    }
    for (const selector of ['#surface-undo','#surface-redo','#surface-close','#surface-end','#surface-delete']) {
      const from=source.querySelector<HTMLButtonElement>(selector), to=toolbar.querySelector<HTMLButtonElement>(selector);
      if (from && to) {to.disabled=from.disabled;to.hidden=from.hidden;if (selector==='#surface-close') to.textContent=from.textContent;}
    }
    const input=toolbar.querySelector<HTMLInputElement>('#surface-name')!, from=source.querySelector<HTMLInputElement>('#surface-name');
    if (from && document.activeElement!==input) input.value=from.value;
    toolbar.querySelector<HTMLElement>('.surface-selection')!.hidden=source.querySelector<HTMLElement>('.surface-selection')?.hidden ?? true;
    toolbar.querySelector<HTMLElement>('#surface-hint')!.textContent=source.querySelector<HTMLElement>('#surface-hint')?.textContent ?? '';
  }
}
function beginAnnotation(): void {
  if (!ready.has(active)) { notify('场景尚未就绪，无法标注'); return; }
  ensureToolbar(active);
  if (!toolbar) { notify('标注工具暂时不可用'); return; }
  annotationMode='point'; shell.classList.add('annotation-mode');
  toolbar.querySelector('.surface-actions')?.append(originalShare);
  sendScope(active);
  command(active,'annotate'); syncToolbar();
}

function sessionKey(id: string): string { return `blind.collection.${token}.${id}`; }
function notify(message: string): void {
  toast.textContent = message; toast.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2500);
}
function command(id: string, action: string, requestId?: number): void {
  frames.get(id)?.contentWindow?.postMessage({type:'blind:scene-command', id, command:action, requestId}, location.origin);
}
function mount(id: string): void {
  if (frames.has(id)) return;
  const card = cards.get(id)!;
  const frame = document.createElement('iframe');
  frame.className = 'collection-frame'; frame.title = `${overview.scenes.find(scene => scene.id === id)!.title} 场景`;
  frame.src = `${location.pathname}?scene=${encodeURIComponent(id)}&embedded=1`;
  card.querySelector('.collection-viewport')!.append(frame); frames.set(id, frame);
}
async function snapshot(id: string): Promise<SceneUpdate | null> {
  const frame = frames.get(id);
  if (!frame || !ready.has(id)) return readSaved(id);
  const requestId = ++snapshotSequence;
  return await new Promise<SceneUpdate | null>(resolve => {
    const timer = window.setTimeout(() => { window.removeEventListener('message', receive); resolve(readSaved(id)); }, 3500);
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'blind:scene-snapshot' || event.data.requestId !== requestId) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      resolve(event.data.update as SceneUpdate | null);
    };
    window.addEventListener('message', receive); command(id, 'snapshot', requestId);
  });
}
function readSaved(id: string): SceneUpdate | null {
  try { return JSON.parse(sessionStorage.getItem(sessionKey(id)) ?? 'null') as SceneUpdate | null; }
  catch { return null; }
}
async function unmount(id: string): Promise<void> {
  if (!frames.has(id)) return;
  await snapshot(id);
  frames.get(id)!.remove(); frames.delete(id); ready.delete(id);
}
function fitGrid(): number | null {
  const count = overview.scenes.length;
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const candidates = Array.from({length: count}, (_, i) => i + 1).filter(cols => {
    const rows = Math.ceil(count / cols);
    return (width - (cols - 1) * 8) / cols >= 480 && (height - (rows - 1) * 8) / rows >= 396;
  });
  return candidates.sort((a, b) => {
    const score = (cols: number) => {
      const rows = Math.ceil(count / cols);
      const paneWidth = (width - (cols - 1) * 8) / cols;
      const paneHeight = (height - (rows - 1) * 8) / rows - 36;
      return Math.min(paneWidth / paneHeight, paneHeight / paneWidth);
    };
    return score(b) - score(a);
  })[0] ?? null;
}
async function layout(): Promise<void> {
  const cols = fitGrid();
  const nextMode = cols ? 'split' : 'tabs';
  if (nextMode !== mode) {
    exitAnnotation();
    showPanelMode(null);
    for (const id of [...frames.keys()]) await unmount(id);
  }
  mode = nextMode;
  shell.classList.toggle('collection-split', mode === 'split'); shell.classList.toggle('collection-tabbed', mode === 'tabs');
  tabs.hidden = mode === 'split';
  stage.style.gridTemplateColumns = mode === 'split' ? `repeat(${cols}, minmax(0, 1fr))` : 'minmax(0, 1fr)';
  for (const scene of overview.scenes) {
    const visible = mode === 'split' || scene.id === active;
    cards.get(scene.id)!.hidden = !visible;
    if (visible) mount(scene.id); else await unmount(scene.id);
  }
  updateFocus();
  renderInkBadges();
}
function scheduleLayout(): void { layoutQueue = layoutQueue.then(layout).catch(error => notify(String(error))); }
function updateFocus(): void {
  for (const [id, card] of cards) {
    card.classList.toggle('active', id === active);
    card.querySelector('button')?.setAttribute('aria-pressed', String(id === active));
    tabs.querySelector<HTMLButtonElement>(`[data-scene="${id}"]`)?.setAttribute('aria-selected', String(id === active));
    if (ready.has(id)) command(id, id === active ? 'activate' : 'deactivate');
  }
}
function showPanelMode(mode: 'mesh' | 'render' | 'info' | null): void {
  for (const [selector, value] of [['.panel-trigger', 'mesh'], ['#render-trigger', 'render'], ['#scene-info-toggle', 'info']] as const) {
    const button = originalDock.querySelector<HTMLButtonElement>(selector);
    button?.classList.toggle('active', mode === value);
    button?.setAttribute('aria-expanded', String(mode === value));
  }
}
function focus(id: string): void {
  if (!cards.has(id) || id === active) return;
  active = id; shareLinks = undefined;
  if (annotationMode) { markup.finishActive(); markup.setEnabled(false); }
  showPanelMode(null);
  if (mode === 'tabs') scheduleLayout(); else updateFocus();
  if (annotationMode && ready.has(id)) {
    sendScope(id);
    command(id,'annotate'); sendSurface('mode',annotationMode);
    markup.setEnabled(annotationMode==='screen' && mode==='split'); syncToolbar();
  }
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || !overview || !overview.scenes.some(scene => scene.id === event.data?.id)) return;
  const id = event.data.id as string;
  if (event.source !== frames.get(id)?.contentWindow) return;
  if (event.data.type === 'blind:scene-ready') {
    ready.add(id); ensureToolbar(id); sendScope(id); command(id, id === active ? 'activate' : 'deactivate');
    if (id === active && annotationMode) {command(id,'annotate');sendSurface('mode',annotationMode);syncToolbar();}
  }
  if (event.data.type === 'blind:scene-focus') focus(id);
  if (event.data.type === 'blind:scene-tool-mode' && id === active) {
    if (event.data.annotation && !annotationMode && ready.has(id)) {
      ensureToolbar(id);
      const selected=frames.get(id)?.contentDocument?.querySelector<HTMLButtonElement>('#surface-toolbar [data-surface-mode][aria-pressed="true"]');
      annotationMode=(selected?.dataset.surfaceMode as AnnotationMode | undefined) || 'select';
      shell.classList.add('annotation-mode'); toolbar?.querySelector('.surface-actions')?.append(originalShare);
      markup.setEnabled(annotationMode==='screen' && mode==='split'); syncToolbar();
    } else if (!event.data.annotation && annotationMode) exitAnnotation();
  }
  if (event.data.type === 'blind:scene-annotation-state' && id === active) syncToolbar();
  if (event.data.type === 'blind:scene-view-change' && ready.has(id) && markup.hasStrokes) {
    markup.clear(); selectedStroke=undefined; strokeHistory.length=0; strokeFuture.length=0;
    notify('视角已改变，批注已隐藏');
  }
  if (event.data.type === 'blind:scene-panel' && id === active) showPanelMode(event.data.mode);
  if (event.data.type === 'blind:scene-error') notify(`${overview.scenes.find(scene => scene.id === id)?.title}：${event.data.message}`);
  if (event.data.type === 'blind:scene-shortcut' && id === active) void copyLink(event.data.kind as 'view' | 'image');
});

async function updates(): Promise<Record<string, SceneUpdate>> {
  const result: Record<string, SceneUpdate> = {};
  for (const scene of overview.scenes) {
    const update = frames.has(scene.id) ? await snapshot(scene.id) : readSaved(scene.id);
    if (update) result[scene.id] = update;
  }
  return result;
}
async function refreshLinks(origin?: string): Promise<ShareResponse> {
  markup.finishActive();
  const layout=mode==='tabs' && markup.hasStrokes && strokeLayout ? strokeLayout : currentLayout();
  const links = await shareCollection(token, active, await updates(), markup.exportStrokes(), layout, owner, origin);
  shareLinks = links; return links;
}
async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); notify('链接已复制'); }
  catch { window.prompt('复制链接', value); }
}
async function copyLink(kind: 'view' | 'image'): Promise<void> {
  const sequence = ++copySequence;
  const pending = refreshLinks(shareLinks?.origin).then(links => kind === 'view' ? links.viewer_url : links.image_url);
  let writeResult: Promise<boolean> | undefined;
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const item = new ClipboardItem({'text/plain': pending.then(value => new Blob([value], {type:'text/plain'}))});
      writeResult = navigator.clipboard.write([item]).then(() => true, () => false);
    } catch { /* Fall back to plain text copy. */ }
  }
  try {
    const value = await pending;
    if (sequence !== copySequence) return;
    let copied = writeResult ? await writeResult : false;
    if (!writeResult && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Show a manual copy prompt. */ }
    }
    if (copied) {
      if (sequence === copySequence) notify('链接已复制');
    } else if (sequence === copySequence) window.prompt('复制链接', value);
  } catch (error) {
    if (sequence === copySequence) notify(error instanceof Error ? error.message : '无法分享场景');
  }
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
    if (!value) continue;
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
    if (event.key === 'Escape') {event.preventDefault();sendSurface('done');exitAnnotation();return;}
    if (annotationMode === 'screen') {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();toolbar?.querySelector<HTMLButtonElement>(event.shiftKey?'#surface-redo':'#surface-undo')?.click();return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedStroke !== undefined) {
        event.preventDefault();toolbar?.querySelector<HTMLButtonElement>('#surface-delete')?.click();return;
      }
    }
  }
  const macOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const modifier = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.repeat || event.key.toLowerCase() !== 'c' || dialog.open) return;
  if (window.getSelection()?.toString() || event.composedPath().some(node => node instanceof HTMLElement &&
    (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"]')))) return;
  event.preventDefault();
  void copyLink(event.shiftKey ? 'view' : 'image');
});
for (const [selector, action] of [['#fit-view','fit'], ['.panel-trigger','details'], ['#render-trigger','render'], ['#brush-tool','annotate'], ['#scene-info-toggle','info']] as const) {
  originalDock.querySelector(selector)?.addEventListener('click', () => action==='annotate' ? beginAnnotation() : command(active, action));
}

try {
  overview = takeInitialScene<CollectionOverview>() ?? await loadCollection(token, owner);
  strokeLayout=overview.layout ?? undefined;
  markup.load(overview.strokes ?? []);
  if (!overview.scenes.some(scene => scene.id === active)) active = overview.active_scene_id;
  document.title = `${overview.title} · Blind`;
  stage.setAttribute('aria-label', `${overview.title} 多场景视图`);
  for (const scene of overview.scenes) {
    const card = document.createElement('section'); card.className = 'collection-card'; card.dataset.scene = scene.id;
    const header = document.createElement('button'); header.type = 'button'; header.className = 'collection-card-title'; header.textContent = scene.title;
    header.addEventListener('click', () => focus(scene.id));
    const viewport = document.createElement('div'); viewport.className = 'collection-viewport'; card.append(header, viewport); stage.append(card); cards.set(scene.id, card);
    const tab = document.createElement('button'); tab.type = 'button'; tab.dataset.scene = scene.id; tab.setAttribute('role','tab'); tab.textContent = scene.title;
    tab.addEventListener('click', () => focus(scene.id)); tabs.append(tab);
  }
  scheduleLayout(); new ResizeObserver(() => {scheduleLayout();renderInkBadges();}).observe(stage);
} catch (error) { notify(error instanceof Error ? error.message : '无法打开多场景'); }
