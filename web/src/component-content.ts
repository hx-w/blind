import { apiError } from './api.ts';
import type { Presentation, SceneEntity } from './scene-components';
import type { NativeContent } from './content-surface';
import { contentState, contentStateChanged, DOMReading, ImageReading, sourceIdentity, acceptsContentState } from './content-reading';
import type { ReadingTarget } from './content-reading';
import type {ContentAnchor} from './content-surface';
import { renderMarkdown, markdownReady } from './markdown';
import { graphTargets } from './graph';
import type {OperationHost} from './operations/core';
import {OperationError} from './operations/core';
import {servePortOperations} from './operations/transport';
import type {OperationActor} from './operations/core';

export interface SurfaceContent {
  element: HTMLElement;
  ready: Promise<void>;
  native?: NativeContent;
  present?(mode: Presentation): void;
  dispose(): void;
}
export interface ContentFactoryContext { operations?: OperationHost }
export type ContentFactory = (url: string, label: string, spec: SceneEntity, context?: ContentFactoryContext) => SurfaceContent;
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
function report(element: HTMLElement, ready: Promise<void>, preserveArticle = false): Promise<void> {
  void ready.catch(error => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : '资源暂时不可用';
    if (preserveArticle && element.querySelector('article')) {
      const status = document.createElement('p'); status.className = 'component-error'; status.textContent = message; element.append(status);
    } else { element.textContent = message; element.classList.add('component-error'); }
  });
  return ready;
}
export const textContent: ContentFactory = (url, _label, spec) => {
  const element = container(); const abort = new AbortController();
  const pre = document.createElement('pre'); pre.textContent = '正在读取文本…'; element.append(pre);
  const native = new DOMReading(element, spec);
  const ready = report(pre, bytes(url, abort.signal).then(async buffer => {
    const source = await sourceIdentity(buffer);
    abort.signal.throwIfAborted();
    const node = document.createTextNode(new TextDecoder().decode(buffer)); pre.replaceChildren(node);
    await document.fonts.ready;
    abort.signal.throwIfAborted();
    native.installText(source, pre, node);
  }));
  return {element, native, ready, dispose: () => { abort.abort(); native.dispose(); }};
};
export const markdownContent: ContentFactory = (url, _label, spec) => {
  const element = container(); element.classList.add('component-markdown'); element.tabIndex = 0;
  const abort = new AbortController();
  element.textContent = '正在读取 Markdown…';
  const native = new DOMReading(element, spec);
  const ready = report(element, bytes(url, abort.signal, 1024 * 1024).then(async buffer => {
    const source = await sourceIdentity(buffer);
    abort.signal.throwIfAborted();
    const article = renderMarkdown(new TextDecoder('utf-8', {fatal: true}).decode(buffer), abort.signal);
    element.replaceChildren(article);
    await Promise.all([markdownReady(article), ...[...article.querySelectorAll('img')].map(async image => {
      try { await image.decode(); }
      catch { image.replaceWith(document.createTextNode(image.alt || '图片无法解码')); }
    })]);
    await document.fonts.ready;
    abort.signal.throwIfAborted();
    const blocks = [...article.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,pre,li,td,th,summary,figure.markdown-diagram')];
    const targets: ReadingTarget[] = blocks.map((block, index) => ({id: `block:${index}`, element: block}));
    for (const target of targets) {
      const svg = target.element.matches('figure.markdown-diagram') ? target.element.querySelector('svg') : null;
      if (svg) target.visual = {svg, targets: graphTargets(svg, svg.querySelector('g.graph') ? 'dot' : 'mermaid').targets};
    }
    for (const [index, image] of [...article.querySelectorAll('img')].entries()) targets.push({id: `image:${index}`, element: image, visual: {image}});
    native.install(source, targets);
  }).catch(error => {
    if (!(error instanceof OversizedResourceError)) throw error;
    const message = document.createElement('p'); message.textContent = 'Markdown 文件超过 1 MiB，无法在预览中展开。';
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开原始文件';
    element.replaceChildren(message, link);
  }), true);
  return {element, native, ready, dispose: () => { abort.abort(); native.dispose(); }};
};
export const jsonContent: ContentFactory = (url, _label, spec) => {
  const element = container(); element.classList.add('component-json');
  const abort = new AbortController();
  const status = document.createElement('p'); status.className = 'json-status'; status.textContent = '正在读取 JSON…'; element.append(status);
  const native = new DOMReading(element, spec);
  const ready = report(element, bytes(url, abort.signal, 4 * 1024 * 1024).then(async buffer => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); }
    catch { throw new Error('JSON 格式无效或不是 UTF-8'); }
    const source = await sourceIdentity(buffer);
    abort.signal.throwIfAborted();
    const state = contentState(spec);
    const matching = state.reading?.source === source;
    let expanded = new Set<string>(matching && Array.isArray(state.expanded) ? state.expanded.filter(path => typeof path === 'string') : ['']);
    const tree = document.createElement('div'); tree.className = 'json-tree'; tree.setAttribute('role', 'tree');
    const targets: ReadingTarget[] = [];
    const branches = new Map<string, {details: HTMLDetailsElement; ensure(key: string, reveal: boolean): void; page(): void; loaded(): number; total: number}>();
    let installed = false, remaining = 5000;
    const pageSize = 100;
    const register = (target: ReadingTarget): void => { if (installed) native.add(target); else targets.push(target); };
    const add = (parent: HTMLElement, key: string | null, item: unknown, depth: number, path: string): void => {
      if (remaining-- <= 0 || depth > 32) {
        const cut = document.createElement('span'); cut.className = 'json-muted'; cut.textContent = '… 其余内容已折叠'; parent.append(cut); return;
      }
      const name = document.createElement('span'); name.className = 'json-key'; name.textContent = key === null ? '' : `${key}: `;
      if (item !== null && typeof item === 'object') {
        const array = Array.isArray(item);
        const keys = array ? undefined : Object.keys(item);
        const entries = array ? item.length : keys!.length;
        const details = document.createElement('details'); details.className = 'json-node'; details.open = expanded.has(path);
        const summary = document.createElement('summary'); summary.append(name);
        const shape = document.createElement('span'); shape.className = 'json-shape';
        shape.textContent = `${array ? '[' : '{'} ${entries > 5000 ? '5000+' : entries} ${array ? '项' : '键'} ${array ? ']' : '}'}`; summary.append(shape);
        details.append(summary);
        register({id: `json:${path}`, element: summary});
        const children = document.createElement('div'); children.className = 'json-children';
        let next = 0;
        let more: HTMLButtonElement | undefined;
        const fill = (): void => {
          more?.remove(); more = undefined;
          const end = Math.min(next + pageSize, entries);
          while (next < end && remaining > 0) {
            const childKey = array ? String(next) : keys![next];
            const child = array ? (item as unknown[])[next] : (item as Record<string, unknown>)[childKey];
            add(children, childKey, child, depth + 1, `${path}/${childKey.replace(/~/g, '~0').replace(/\//g, '~1')}`);
            next++;
          }
          if (next < entries && remaining > 0) {
            more = document.createElement('button'); more.type = 'button'; more.className = 'json-more'; more.textContent = `显示更多（剩余 ${entries - next} 项）`;
            more.addEventListener('click', () => native.json?.page(path)); children.append(more);
          } else if (next < entries) {
            const cut = document.createElement('span'); cut.className = 'json-muted'; cut.textContent = '… 其余内容已折叠'; children.append(cut);
          }
        };
        branches.set(path, {details, page: fill, loaded: () => next, total: entries, ensure(childKey, reveal) {
          if (reveal) details.open = true;
          const index = array ? Number(childKey) : keys!.indexOf(childKey);
          while (next <= index && next < entries && remaining > 0) fill();
          if (next === 0) fill();
        }});
        details.addEventListener('toggle', () => {
          const wasOpen = expanded.has(path);
          // Initial disclosure notifications and rollback notifications are not
          // user mutations; in particular, do not erase a visible rejection.
          if (details.open === wasOpen) return;
          try { native.json?.setExpanded(path, details.open); }
          catch (error) {
            details.open = wasOpen; status.hidden = false;
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        });
        details.append(children); parent.append(details);
        if (details.open) fill();
      } else {
        const row = document.createElement('div'); row.className = 'json-leaf'; row.append(name);
        const literal = document.createElement('span'); literal.className = `json-${item === null ? 'null' : typeof item}`;
        if (typeof item === 'string') {
          const truncated = item.length > 2048;
          literal.textContent = JSON.stringify(truncated ? item.slice(0, 2048) : item) + (truncated ? ` … (${item.length} 字符)` : '');
        } else literal.textContent = String(item);
        row.append(literal); parent.append(row);
        register({id: `json:${path}`, element: row});
      }
    };
    const ensurePath = (target: string, reveal = true, reading?: ContentAnchor): boolean => {
      if (!target.startsWith('json:')) return false;
      const path = target.slice(5), segments = path.split('/').slice(1);
      let parent = '';
      if (reveal) {
        const nextExpanded = new Set(expanded);
        for (const segment of segments) { nextExpanded.add(parent); parent += `/${segment}`; }
        if (nextExpanded.size !== expanded.size) {
          const nextState = {...state, expanded:[...nextExpanded]};
          // Check the old and new reading states before revealing lazy branches.
          if (!acceptsContentState(nextState, element) || reading && !acceptsContentState({...nextState, reading}, element)) return false;
          expanded = nextExpanded; state.expanded = nextState.expanded;
        }
      }
      parent = '';
      for (const segment of segments) {
        branches.get(parent)?.ensure(segment.replace(/~1/g, '/').replace(/~0/g, '~'), reveal);
        parent += `/${segment}`;
      }
      return true;
    };
    add(tree, null, value, 0, ''); status.hidden = true;
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); element.replaceChildren(status, tree);
    for (const path of [...expanded].sort((a, b) => a.length - b.length)) ensurePath(`json:${path}`, false);
    await document.fonts.ready;
    abort.signal.throwIfAborted();
    installed = true;
    native.install(source, targets, (target, anchor) => ensurePath(target, true, anchor));
    const resolveValue = (path: string): unknown => {
      let current = value;
      if (path !== '' && !path.startsWith('/')) throw new OperationError('INVALID_ARGUMENT', 'JSON path must be a JSON Pointer', {field: 'path'});
      for (const segment of path.split('/').slice(1)) {
        if (/~(?![01])/u.test(segment)) throw new OperationError('INVALID_ARGUMENT', 'Invalid JSON Pointer escape', {field: 'path'});
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new OperationError('INVALID_ARGUMENT', 'Unknown JSON path', {field: 'path', target: path});
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    };
    const accepts = native.acceptsAnchor.bind(native);
    native.acceptsAnchor = anchor => {
      if (accepts(anchor)) return true;
      if (anchor.source !== source || !anchor.target.startsWith('json:')) return false;
      try { resolveValue(anchor.target.slice(5)); return anchor.offset === 0; } catch { return false; }
    };
    native.json = {
      branches: () => [...branches].map(([path, branch]) => ({path, expanded: expanded.has(path), loaded: branch.loaded(), total: branch.total})),
      setExpanded(path, open) {
        const item = resolveValue(path);
        if (!item || typeof item !== 'object') throw new OperationError('UNSUPPORTED', 'JSON leaf cannot be expanded', {target: path});
        const next = new Set(expanded);
        if (open) next.add(path); else next.delete(path);
        if (!acceptsContentState({...state, expanded: [...next]}, element)) throw new OperationError('INVALID_ARGUMENT', 'Content state exceeds 64 KiB');
        ensurePath(`json:${path}`, false);
        const branch = branches.get(path);
        if (!branch) throw new OperationError('RESOURCE_UNAVAILABLE', 'JSON branch exceeds the preview limit', {target: path});
        expanded = next; state.expanded = [...next]; branch.details.open = open;
        if (open && !branch.loaded()) branch.page();
        contentStateChanged(element);
      },
      page(path) {
        resolveValue(path);
        const branch = branches.get(path);
        if (!branch) throw new OperationError('INVALID_ARGUMENT', 'Expand parent branches before paging', {target: path});
        if (branch.loaded() >= branch.total) throw new OperationError('CONFLICT', 'No more JSON entries', {target: path});
        if (remaining <= 0) throw new OperationError('RESOURCE_UNAVAILABLE', 'JSON preview has reached its materialization limit', {target: path});
        branch.page(); contentStateChanged(element);
      },
    };
  }).catch(error => {
    if (!(error instanceof OversizedResourceError)) throw error;
    const message = document.createElement('p'); message.className = 'json-status'; message.textContent = 'JSON 文件较大，无法在预览中展开。';
    const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开原始文件';
    element.replaceChildren(message, link);
  }));
  return {element, native, ready, dispose: () => { abort.abort(); native.dispose(); }};
};
export const imageContent: ContentFactory = (url, label, spec) => {
  const element = container(); const abort = new AbortController(); let blobUrl: string | undefined;
  const stage = document.createElement('div'); stage.className = 'native-image-stage';
  const image = document.createElement('img'); image.alt = label; image.draggable = false; stage.append(image); element.append(stage);
  const native = new ImageReading(element, stage, image, spec);
  const ready = report(element, bytes(url, abort.signal).then(async buffer => {
    const source = await sourceIdentity(buffer);
    abort.signal.throwIfAborted();
    blobUrl = URL.createObjectURL(new Blob([buffer])); image.src = blobUrl; await image.decode();
    abort.signal.throwIfAborted();
    native.install(source);
  }));
  return {element, native, ready, dispose: () => { abort.abort(); native.dispose(); if (blobUrl) URL.revokeObjectURL(blobUrl); }};
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
export const pluginContent: ContentFactory = (url, label, spec, context) => {
  const element = container(); const abort = new AbortController(); const iframe = document.createElement('iframe');
  iframe.title = label; iframe.sandbox.add('allow-scripts'); iframe.referrerPolicy = 'no-referrer';
  const exporting = new URLSearchParams(location.search).has('render');
  let mode: Presentation = 'spatial'; let port: MessagePort | undefined; let disposed = false;
  let disconnectOperations: (() => void) | undefined;
  const completion = Promise.withResolvers<void>();
  const complete = completion.resolve;
  const fail = completion.reject;
  const ready = report(element, completion.promise);
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
      disconnectOperations?.(); port?.close();
      const channel = new MessageChannel(); port = channel.port1;
      const actor: OperationActor = {kind: 'component', entityId: spec.id, grants: spec.renderer?.capabilities.operations ?? []};
      if (context?.operations) disconnectOperations = servePortOperations(context.operations, port, actor);
      port.onmessage = event => {
        if (event.data?.version !== 1) return;
        if (event.data.type === 'frame:open') openExternal(event.data.url);
        if (event.data.type === 'frame:close') closeExternal();
        if (event.data.type === 'frame:post' && external && externalOrigin) external.contentWindow?.postMessage(event.data.data,externalOrigin);
        if (event.data.type === 'state') {
          try {
            if (exporting) throw new OperationError('FORBIDDEN', 'Export component state is read-only');
            spec.state = validateComponentState(event.data.state);
            context?.operations?.notify('component', {entityId: spec.id});
            port?.postMessage({version: 1, type: 'state:result', ok: true});
          } catch (error) {
            port?.postMessage({version: 1, type: 'state:result', ok: false, error: {code: error instanceof OperationError ? error.code : 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'Invalid component state'}});
          }
        }
        if (event.data.type === 'ready') { clearTimeout(timeout); complete(); }
        if (event.data.type === 'error') {clearTimeout(timeout); fail(new Error(`${label}：${String(event.data.message ?? '渲染失败').slice(0,256)}`));}
      };
      const contentBuffer = buffer.slice(0);
      iframe.contentWindow?.postMessage({type: 'blind:init', version: 1, entityId: spec.id, label, state: spec.state, buffer: contentBuffer, presentation: mode, exporting, operations: context?.operations ? {version: 1, sceneId: context.operations.sceneId, catalog: context.operations.catalog(actor)} : undefined}, '*', [channel.port2, contentBuffer]);
    } catch (error) { fail(error instanceof Error ? error : new Error('组件加载失败')); }
  };
  iframe.src = url.replace(/attachments\/\d+(?=\?|$)/, `renderers/${encodeURIComponent(spec.id)}`); element.append(iframe);
  return {element, ready, present(presentation) {mode = presentation; if (mode === 'spatial') closeExternal(); port?.postMessage({type:'presentation',version:1,presentation});}, dispose() {disposed = true; disconnectOperations?.(); closeExternal(); window.removeEventListener('message',externalMessage); abort.abort(); clearTimeout(timeout); port?.close(); iframe.src = 'about:blank';}};
};
