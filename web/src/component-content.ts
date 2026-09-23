import { apiError } from './api.ts';
import type { Presentation, SceneComponent } from './scene-components';

export interface SurfaceContent {
  element: HTMLElement;
  ready: Promise<void>;
  present?(mode: Presentation): void;
  dispose(): void;
}
export type ContentFactory = (url: string, label: string, spec: SceneComponent) => SurfaceContent;
function container(): HTMLDivElement { const e = document.createElement('div'); e.className = 'component-content'; return e; }
class OversizedResourceError extends Error {}
async function bytes(url: string, signal: AbortSignal, maxBytes = 64 * 1024 * 1024): Promise<ArrayBuffer> {
  const response = await fetch(url, {signal, cache: 'no-store'});
  if (!response.ok) throw await apiError(response);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new OversizedResourceError(`资源超过 ${maxBytes / 1024 / 1024} MiB`);
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new OversizedResourceError(`资源超过 ${maxBytes / 1024 / 1024} MiB`);
    return buffer;
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new OversizedResourceError(`资源超过 ${maxBytes / 1024 / 1024} MiB`);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer.buffer;
}
function report(element: HTMLElement, ready: Promise<void>): Promise<void> {
  void ready.catch(error => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    element.textContent = error instanceof Error ? error.message : '资源暂时不可用'; element.classList.add('component-error');
  });
  return ready;
}
export const textContent: ContentFactory = (url) => {
  const element = container(); const abort = new AbortController();
  const pre = document.createElement('pre'); pre.tabIndex = 0; pre.textContent = '正在读取文本…'; element.append(pre);
  const ready = report(pre, bytes(url, abort.signal).then(buffer => { pre.textContent = new TextDecoder().decode(buffer); }));
  return {element, ready, dispose: () => abort.abort()};
};
export const jsonContent: ContentFactory = (url) => {
  const element = container(); element.classList.add('component-json');
  const abort = new AbortController();
  const status = document.createElement('p'); status.className = 'json-status'; status.textContent = '正在读取 JSON…'; element.append(status);
  const ready = report(element, bytes(url, abort.signal, 4 * 1024 * 1024).then(buffer => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); }
    catch { throw new Error('JSON 格式无效或不是 UTF-8'); }
    const tree = document.createElement('div'); tree.className = 'json-tree'; tree.setAttribute('role', 'tree');
    let remaining = 5000;
    const add = (parent: HTMLElement, key: string | null, item: unknown, depth: number): void => {
      if (remaining-- <= 0 || depth > 32) {
        const cut = document.createElement('span'); cut.className = 'json-muted'; cut.textContent = '… 其余内容已折叠'; parent.append(cut); return;
      }
      const keyNode = () => {
        const name = document.createElement('span'); name.className = 'json-key'; name.textContent = key === null ? '' : `${key}: `; return name;
      };
      if (item !== null && typeof item === 'object') {
        const array = Array.isArray(item);
        const entries = array ? item.length : countKeys(item);
        const details = document.createElement('details'); details.className = 'json-node'; details.open = depth < 2;
        const summary = document.createElement('summary'); summary.append(keyNode());
        const shape = document.createElement('span'); shape.className = 'json-shape';
        shape.textContent = `${array ? '[' : '{'} ${entries > 5000 ? '5000+' : entries} ${array ? '项' : '键'} ${array ? ']' : '}'}`; summary.append(shape);
        details.append(summary);
        const children = document.createElement('div'); children.className = 'json-children';
        if (array) {
          for (let index = 0; index < item.length; index++) {
            if (remaining <= 0) { add(children, null, undefined, depth + 1); break; }
            add(children, String(index), item[index], depth + 1);
          }
        } else {
          for (const childKey in item) {
            if (!Object.hasOwn(item, childKey)) continue;
            if (remaining <= 0) { add(children, null, undefined, depth + 1); break; }
            add(children, childKey, (item as Record<string, unknown>)[childKey], depth + 1);
          }
        }
        details.append(children); parent.append(details);
      } else {
        const row = document.createElement('div'); row.className = 'json-leaf'; row.append(keyNode());
        const literal = document.createElement('span'); literal.className = `json-${item === null ? 'null' : typeof item}`;
        if (typeof item === 'string') {
          const truncated = item.length > 2048;
          literal.textContent = JSON.stringify(truncated ? item.slice(0, 2048) : item) + (truncated ? ` … (${item.length} 字符)` : '');
        } else literal.textContent = String(item);
        row.append(literal); parent.append(row);
      }
    };
    const countKeys = (item: object): number => {
      let count = 0;
      for (const key in item) if (Object.hasOwn(item, key) && ++count > 5000) break;
      return count;
    };
    add(tree, null, value, 0); element.replaceChildren(tree);
  }).catch(error => {
    if (!(error instanceof OversizedResourceError)) throw error;
    const message = document.createElement('p'); message.className = 'json-status'; message.textContent = 'JSON 文件较大，无法在预览中展开。';
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开原始文件';
    element.replaceChildren(message, link);
  }));
  return {element, ready, dispose: () => abort.abort()};
};
export const imageContent: ContentFactory = (url, label) => {
  const element = container(); const abort = new AbortController(); let blobUrl: string | undefined;
  const image = document.createElement('img'); image.alt = label; image.draggable = false; element.append(image);
  const ready = report(element, bytes(url, abort.signal).then(async buffer => { blobUrl = URL.createObjectURL(new Blob([buffer])); image.src = blobUrl; await image.decode(); }));
  return {element, ready, dispose: () => { abort.abort(); if (blobUrl) URL.revokeObjectURL(blobUrl); }};
};
export const htmlContent: ContentFactory = (url, label) => {
  const element = container(); const iframe = document.createElement('iframe'); const abort = new AbortController();
  iframe.title = label; iframe.sandbox.add('allow-scripts'); iframe.referrerPolicy = 'no-referrer';
  const address = new URL(url, document.baseURI); address.searchParams.set('embed', '1');
  const verify = async () => {
    const response = await fetch(address.href, {method: 'HEAD', signal: abort.signal, cache: 'no-store'});
    if (!response.ok) throw await apiError(response);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) throw new Error(`${label}：HTML 响应无效`);
  };
  // A frame's load event also fires for HTTP errors. Verify the revision-checked
  // endpoint before navigating and again after loading, while retaining its CSP.
  const ready = report(element, (async () => {
    const timeout = window.setTimeout(() => abort.abort(new Error(`${label}：HTML 加载超时`)), 45000);
    try {
      await verify();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(abort.signal.reason);
        abort.signal.addEventListener('abort', cancel, {once: true});
        iframe.onload = () => { abort.signal.removeEventListener('abort', cancel); resolve(); };
        iframe.onerror = () => { abort.signal.removeEventListener('abort', cancel); reject(new Error(`${label}：HTML 加载失败`)); };
        iframe.src = address.href; element.append(iframe);
      });
      await verify();
    } finally { clearTimeout(timeout); iframe.onload = null; iframe.onerror = null; }
  })());
  return {element, ready, dispose: () => { abort.abort(); iframe.src = 'about:blank'; }};
};
/** Match the persisted JSON and UTF-8 byte limit used by the server. */
export function validateComponentState(state: unknown): unknown {
  const json = JSON.stringify(state);
  if (json === undefined || new TextEncoder().encode(json).byteLength > 65536) throw new Error('组件状态超过 64 KiB 或无法序列化');
  return JSON.parse(json);
}
/** Opaque-origin iframe and a private MessagePort; renderer code never runs in the Viewer. */
export const pluginContent: ContentFactory = (url, label, spec) => {
  const element = container(); const abort = new AbortController(); const iframe = document.createElement('iframe');
  iframe.title = label; iframe.sandbox.add('allow-scripts'); iframe.referrerPolicy = 'no-referrer';
  let mode: Presentation = 'spatial'; let port: MessagePort | undefined; let disposed = false;
  let complete!: () => void; let fail!: (error: Error) => void;
  const ready = report(element, new Promise<void>((resolve, reject) => {complete = resolve; fail = reject;}));
  const timeout = window.setTimeout(() => fail(new Error(`${label}：组件加载超时`)), 45000);
  let external: HTMLIFrameElement | undefined; let externalOrigin: string | undefined;
  const closeExternal = () => {external?.remove(); external = undefined; externalOrigin = undefined; iframe.style.visibility = ''; port?.postMessage({version:1,type:'frame:closed'});};
  const externalMessage = (event: MessageEvent) => {
    if (external && event.source === external.contentWindow && event.origin === externalOrigin) port?.postMessage({version:1,type:'frame:message',data:event.data});
  };
  window.addEventListener('message',externalMessage);
  const openExternal = (address: unknown) => {
    try {
      if (typeof address !== 'string') throw new Error('Invalid frame URL');
      const target = new URL(address);
      if (target.protocol !== 'https:' || target.username || target.password || target.origin === location.origin || !spec.renderer?.frame_origins?.includes(target.origin)) throw new Error('External frame origin is not declared by this plugin');
      if (mode === 'spatial' || new URLSearchParams(location.search).has('render')) return;
      closeExternal(); externalOrigin = target.origin; external = document.createElement('iframe');
      // This cross-origin page keeps its own origin/storage. It cannot access the parent.
      external.sandbox.add('allow-scripts','allow-same-origin','allow-downloads'); external.referrerPolicy = 'no-referrer'; external.title = label;
      external.className = 'component-external-frame'; external.src = target.href;
      external.onload = () => port?.postMessage({version:1,type:'frame:loaded'});
      element.append(external);
    } catch (error) {port?.postMessage({version:1,type:'frame:error',message:error instanceof Error ? error.message : 'External frame failed'});}
  };
  const data = bytes(url, abort.signal); void data.catch(error => fail(error));
  iframe.onload = async () => {
    try {
      const buffer = await data; if (disposed) return;
      port?.close(); const channel = new MessageChannel(); port = channel.port1;
      port.onmessage = event => {
        if (event.data?.version !== 1) return;
        if (event.data.type === 'frame:open') openExternal(event.data.url);
        if (event.data.type === 'frame:close') closeExternal();
        if (event.data.type === 'frame:post' && external && externalOrigin) external.contentWindow?.postMessage(event.data.data,externalOrigin);
        if (event.data.type === 'state') {
          try { spec.state = validateComponentState(event.data.state); }
          catch { /* Keep the last valid state so one renderer cannot break sharing. */ }
        }
        if (event.data.type === 'ready') { clearTimeout(timeout); complete(); }
        if (event.data.type === 'error') {clearTimeout(timeout); fail(new Error(`${label}：${String(event.data.message ?? '渲染失败').slice(0,256)}`));}
      };
      iframe.contentWindow?.postMessage({type: 'blind:init', version: 1, label, state:spec.state, buffer: buffer.slice(0), presentation: mode, exporting: new URLSearchParams(location.search).has('render')}, '*', [channel.port2]);
    } catch (error) { fail(error instanceof Error ? error : new Error('组件加载失败')); }
  };
  iframe.src = url.replace(/attachments\/\d+$/, `renderers/${encodeURIComponent(spec.id)}`); element.append(iframe);
  return {element, ready, present(presentation) {mode = presentation; if (mode === 'spatial') closeExternal(); port?.postMessage({type:'presentation',version:1,presentation});}, dispose() {disposed = true; closeExternal(); window.removeEventListener('message',externalMessage); abort.abort(); clearTimeout(timeout); port?.close(); iframe.src = 'about:blank';}};
};
