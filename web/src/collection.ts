import './collection.css';
import {loadCollection, shareCollection, type CollectionOverview, type SceneUpdate, type ShareResponse} from './api';

const token = location.pathname.match(/\/(?:s|v)\/([^/]+)$/)?.[1] ?? '';
if (!token) throw new Error('Missing collection token');
const hashOwner = new URLSearchParams(location.hash.slice(1)).get('owner');
if (hashOwner) {
  sessionStorage.setItem(`blind.owner.${token}`, hashOwner);
  history.replaceState(null, '', location.pathname + location.search);
}
const owner = hashOwner ?? sessionStorage.getItem(`blind.owner.${token}`) ?? undefined;
const originalDock = document.querySelector('.review-dock')!.cloneNode(true) as HTMLElement;
const originalShare = originalDock.querySelector<HTMLButtonElement>('#share-view')!;
originalShare.setAttribute('aria-label', '分享全部场景');
const shell = document.createElement('div'); shell.className = 'app-shell collection-shell';
const tabs = document.createElement('nav'); tabs.className = 'collection-tabs'; tabs.setAttribute('aria-label', '场景');
const stage = document.createElement('main'); stage.className = 'collection-stage'; stage.setAttribute('aria-label', '多场景视图');
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
    shell.classList.remove('annotation-mode');
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
  shell.classList.remove('annotation-mode');
  showPanelMode(null);
  if (mode === 'tabs') scheduleLayout(); else updateFocus();
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || !overview || !overview.scenes.some(scene => scene.id === event.data?.id)) return;
  const id = event.data.id as string;
  if (event.source !== frames.get(id)?.contentWindow) return;
  if (event.data.type === 'blind:scene-ready') { ready.add(id); command(id, id === active ? 'activate' : 'deactivate'); }
  if (event.data.type === 'blind:scene-focus') focus(id);
  if (event.data.type === 'blind:scene-tool-mode' && id === active) shell.classList.toggle('annotation-mode', !!event.data.annotation);
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
  const links = await shareCollection(token, active, await updates(), owner, origin);
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
  const macOS = /Macintosh|Mac OS X/.test(navigator.userAgent);
  const modifier = macOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.repeat || event.key.toLowerCase() !== 'c' || dialog.open) return;
  if (window.getSelection()?.toString() || event.composedPath().some(node => node instanceof HTMLElement &&
    (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"]')))) return;
  event.preventDefault();
  void copyLink(event.shiftKey ? 'view' : 'image');
});
for (const [selector, action] of [['#fit-view','fit'], ['.panel-trigger','details'], ['#render-trigger','render'], ['#brush-tool','annotate'], ['#scene-info-toggle','info']] as const) {
  originalDock.querySelector(selector)?.addEventListener('click', () => command(active, action));
}

try {
  overview = await loadCollection(token, owner);
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
  scheduleLayout(); new ResizeObserver(scheduleLayout).observe(stage);
} catch (error) { notify(error instanceof Error ? error.message : '无法打开多场景'); }
