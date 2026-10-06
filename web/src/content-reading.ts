import { sha256 } from '@noble/hashes/sha2.js';
import type { ContentAnchor, ContentState, NativeContent } from './content-surface';
import type { SceneEntity } from './scene-components';
import './content-reading.css';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validAnchor(value: unknown): value is ContentAnchor {
  if (!object(value)) return false;
  return typeof value.source === 'string' && value.source.length > 0 && typeof value.target === 'string' && value.target.length > 0 &&
    typeof value.offset === 'number' && Number.isFinite(value.offset) && value.offset >= 0 &&
    typeof value.x === 'number' && Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y) &&
    (value.viewport === undefined || Array.isArray(value.viewport) && value.viewport.length === 2 && value.viewport.every(n => typeof n === 'number' && Number.isFinite(n)));
}
function validMark(value: unknown): boolean {
  if (!object(value) || typeof value.id !== 'string' || !value.id.length || typeof value.label !== 'string' ||
    typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color) || (value.kind !== 'point' && value.kind !== 'line')) return false;
  const anchors = value.anchors;
  return Array.isArray(anchors) && anchors.length === (value.kind === 'point' ? 1 : 2) &&
    anchors.every(validAnchor) && anchors.every(anchor => anchor.source === anchors[0].source);
}
/** Reject malformed persisted native state before any reading or annotation consumer sees it. */
export function validateContentState(value: unknown): asserts value is ContentState {
  if (!object(value) ||
    value.presentation !== undefined && !['spatial', 'focus', 'fullscreen'].includes(value.presentation as string) ||
    value.reading !== undefined && !validAnchor(value.reading) ||
    value.selection !== undefined && typeof value.selection !== 'boolean' ||
    value.zoom !== undefined && !(typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom > 0) ||
    value.expanded !== undefined && !(Array.isArray(value.expanded) && value.expanded.every(id => typeof id === 'string')) ||
    value.layer !== undefined && typeof value.layer !== 'string' ||
    value.marks !== undefined && !(Array.isArray(value.marks) && value.marks.every(validMark))) {
    throw new Error('无效的原生内容状态');
  }
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > 65536) throw new Error('组件状态超过 64 KiB');
}
const stateErrors = new WeakMap<HTMLElement, HTMLElement>();
/** Preflight lazy geometry changes without modifying the last shareable state. */
export function acceptsContentState(next: ContentState, element: HTMLElement): boolean {
  try {
    validateContentState(next);
    const status = stateErrors.get(element); if (status) status.hidden = true;
    return true;
  } catch (error) {
    let status = stateErrors.get(element);
    if (!status) {
      status = document.createElement('p'); status.className = 'json-status';
      status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); stateErrors.set(element, status);
    }
    status.textContent = error instanceof Error ? error.message : String(error); status.hidden = false;
    if (status.parentElement !== element) element.append(status);
    return false;
  }
}
/** Commit only a complete shareable state; callers retain control of view notifications. */
export function updateContentState(state: ContentState, changes: Partial<ContentState>, element: HTMLElement): boolean {
  if (!acceptsContentState({...state, ...changes}, element)) return false;
  Object.assign(state, changes);
  return true;
}
const acceptedStates = new WeakSet<object>();
export function contentState(spec: SceneEntity): ContentState {
  if (spec.state === undefined || spec.state === null) spec.state = {};
  if (!acceptedStates.has(spec.state as object)) {
    validateContentState(spec.state);
    acceptedStates.add(spec.state);
  }
  return spec.state as ContentState;
}
export function contentStateChanged(element: HTMLElement): void {
  element.dispatchEvent(new CustomEvent('contentstatechange', {bubbles: true}));
}
export async function sourceIdentity(buffer: ArrayBuffer): Promise<string> {
  const digest = sha256(new Uint8Array(buffer));
  let identity = 'sha256:';
  for (const byte of digest) identity += byte.toString(16).padStart(2, '0');
  return identity;
}

/** Four zero-size probes recover the CSS3D perspective mapping, not its bounding box. */
export class LocalCoordinates {
  private probes: HTMLElement[];
  constructor(private scroll: HTMLElement) {
    this.probes = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => {
      const probe = document.createElement('i');
      probe.className = 'content-coordinate-probe'; probe.style.left = `${x}%`; probe.style.top = `${y}%`;
      probe.setAttribute('aria-hidden', 'true'); scroll.append(probe); return probe;
    });
  }
  private matrix(): number[] | undefined {
    const [p0, p1, p2, p3] = this.probes.map(probe => probe.getBoundingClientRect());
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-9) return undefined;
    const g = (dx3 * dy2 - dx2 * dy3) / determinant;
    const h = (dx1 * dy3 - dx3 * dy1) / determinant;
    return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
      p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
  }
  client(x: number, y: number): {x: number; y: number} | undefined {
    const m = this.matrix(); if (!m) return undefined;
    const u = (x + this.scroll.scrollLeft) / this.scroll.clientWidth, v = (y + this.scroll.scrollTop) / this.scroll.clientHeight;
    const w = m[6] * u + m[7] * v + 1;
    return {x: (m[0] * u + m[1] * v + m[2]) / w, y: (m[3] * u + m[4] * v + m[5]) / w};
  }
  local(x: number, y: number): {x: number; y: number} | undefined {
    const m = this.matrix(); if (!m) return undefined;
    const a = m[0] - x * m[6], b = m[1] - x * m[7], c = x - m[2];
    const d = m[3] - y * m[6], e = m[4] - y * m[7], f = y - m[5];
    const determinant = a * e - b * d; if (Math.abs(determinant) < 1e-9) return undefined;
    return {x: this.scroll.clientWidth * (c * e - b * f) / determinant - this.scroll.scrollLeft,
      y: this.scroll.clientHeight * (a * f - c * d) / determinant - this.scroll.scrollTop};
  }
  dispose(): void { this.probes.forEach(probe => probe.remove()); }
}

export interface ReadingTarget {
  id: string;
  element: HTMLElement;
  /** A single node may contain many stable source lines. */
  node?: Text;
  start?: number;
  end?: number;
  visual?: {
    image?: HTMLImageElement;
    svg?: SVGSVGElement;
    targets?: readonly {id: string; kind: 'node' | 'edge' | 'group'; box: {x: number; y: number; width: number; height: number}}[];
  };
}
interface CaretDocument {
  caretPositionFromPoint?(x: number, y: number): {offsetNode: Node; offset: number} | null;
}
function textNodes(element: HTMLElement): Text[] {
  const nodes: Text[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

const SOURCE_LINE_STRIDE = 1024;
export class DOMReading implements NativeContent {
  readonly scroll: HTMLElement;
  json?: NativeContent['json'];
  private source = '';
  private targets: ReadingTarget[] = [];
  private byId = new Map<string, ReadingTarget>();
  private coordinates: LocalCoordinates;
  private observer: ResizeObserver;
  private frame = 0;
  private restoring = false;
  private disposed = false;
  private resolveTarget?: (id: string, anchor: ContentAnchor) => boolean | void;
  private lines?: {node: Text; element: HTMLElement; checkpoints: number[]; count: number};
  constructor(scroll: HTMLElement, private spec: SceneEntity) {
    this.scroll = scroll; scroll.tabIndex = 0; scroll.classList.add('native-reading');
    this.coordinates = new LocalCoordinates(scroll);
    this.setSelection(contentState(spec).selection === true);
    scroll.addEventListener('scroll', this.onScroll, {passive: true});
    this.observer = new ResizeObserver(() => {
      const anchor = contentState(spec).reading;
      if (anchor && anchor.source === this.source) this.restore(anchor);
    });
    this.observer.observe(scroll);
  }
  install(source: string, targets: ReadingTarget[], resolveTarget?: (id: string, anchor: ContentAnchor) => boolean | void): void {
    this.source = source; this.targets = targets; this.resolveTarget = resolveTarget;
    this.byId = new Map(targets.map(target => [target.id, target]));
    // replaceChildren may remove the probes while loading content.
    this.coordinates.dispose(); this.coordinates = new LocalCoordinates(this.scroll);
    const anchor = contentState(this.spec).reading;
    if (anchor?.source === source) this.restore(anchor);
    else this.save();
  }
  installText(source: string, element: HTMLElement, node: Text): void {
    // Sparse source-line checkpoints avoid millions of DOM nodes or anchor objects
    // for newline-heavy files that still fit the existing 64 MiB resource limit.
    const checkpoints = [0];
    let line = 0, start = 0;
    for (;;) {
      const next = node.data.indexOf('\n', start); if (next < 0) break;
      start = next + 1;
      if (++line % SOURCE_LINE_STRIDE === 0) checkpoints.push(start);
    }
    this.lines = {node, element, checkpoints, count: line + 1};
    this.install(source, [this.sourceLine(0)!]);
  }
  private sourceLine(line: number): ReadingTarget | undefined {
    const lines = this.lines;
    if (!lines || !Number.isInteger(line) || line < 0 || line >= lines.count) return undefined;
    let start = lines.checkpoints[Math.floor(line / SOURCE_LINE_STRIDE)];
    for (let index = 0; index < line % SOURCE_LINE_STRIDE; index++) start = lines.node.data.indexOf('\n', start) + 1;
    const end = lines.node.data.indexOf('\n', start);
    return {id: `line:${line}`, element: lines.element, node: lines.node, start, end: end < 0 ? lines.node.length : end};
  }
  add(target: ReadingTarget): void { this.targets.push(target); this.byId.set(target.id, target); }
  catalogTargets() {
    return this.targets.map(target => ({id: target.id, label: target.id,
      anchor: {source: this.source, target: target.id, offset: 0, x: 0, y: 0}}));
  }
  get targetRange(): {prefix: string; count: number} | undefined { return this.lines ? {prefix: 'line:', count: this.lines.count} : undefined; }
  acceptsAnchor(anchor: ContentAnchor): boolean {
    if (anchor.source !== this.source) return false;
    const target = this.lines && /^line:\d+$/.test(anchor.target) ? this.sourceLine(Number(anchor.target.slice(5))) : this.byId.get(anchor.target);
    if (target && !target.visual) {
      const length = target.node ? (target.end ?? target.node.length) - (target.start ?? 0) : textNodes(target.element).reduce((sum, node) => sum + node.length, 0);
      return Number.isInteger(anchor.offset) && anchor.offset >= 0 && anchor.offset <= length;
    }
    return !!this.locate(anchor);
  }
  private onScroll = (): void => {
    if (this.restoring || !this.source || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.save(); });
  };
  private save(): void {
    const anchor = this.capture();
    if (!anchor) return;
    const state = contentState(this.spec), previous = state.reading;
    if (!updateContentState(state, {reading:anchor}, this.scroll)) return;
    if (!previous || previous.source !== anchor.source || previous.target !== anchor.target || previous.offset !== anchor.offset ||
      previous.x !== anchor.x || previous.y !== anchor.y) contentStateChanged(this.scroll);
  }
  private point(target: ReadingTarget, offset: number): {x: number; y: number} | undefined {
    if (!Number.isInteger(offset) || offset < 0 || !target.element.getClientRects().length) return undefined;
    const nodes = target.node ? [target.node] : textNodes(target.element);
    const length = target.node ? (target.end ?? target.node.length) - (target.start ?? 0) : nodes.reduce((sum, node) => sum + node.length, 0);
    if (offset > length) return undefined;
    let remaining = offset + (target.start ?? 0);
    const range = document.createRange();
    for (const node of nodes) {
      if (remaining <= node.length) { range.setStart(node, remaining); break; }
      remaining -= node.length;
    }
    if (nodes.length) {
      range.collapse(true);
      const rect = range.getClientRects()[0];
      if (rect && rect.height) return this.coordinates.local(rect.x + rect.width / 2, rect.y + rect.height / 2);
    }
    const rect = target.element.getBoundingClientRect();
    return this.coordinates.local(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }
  private caret(x: number, y: number): {node: Node; offset: number} | undefined {
    const client = this.coordinates.client(x, y); if (!client) return undefined;
    const selecting = this.scroll.classList.contains('native-selecting');
    // Caret APIs in WebKit can exclude user-select:none content. This synchronous
    // geometry query must not turn read/drag mode into persistent selection mode.
    if (!selecting) this.scroll.classList.add('native-selecting');
    try {
      const caret = (document as CaretDocument).caretPositionFromPoint?.(client.x, client.y);
      if (caret) return {node: caret.offsetNode, offset: caret.offset};
      const range = document.caretRangeFromPoint?.(client.x, client.y);
      return range ? {node: range.startContainer, offset: range.startOffset} : undefined;
    } finally { if (!selecting) this.scroll.classList.remove('native-selecting'); }
  }
  private visualBox(target: ReadingTarget): {x: number; y: number; width: number; height: number} | undefined {
    const visual = target.visual; if (!visual) return;
    let x = 0, y = 0, parent: HTMLElement | null = target.element;
    while (parent && parent !== this.scroll) { x += parent.offsetLeft; y += parent.offsetTop; parent = parent.offsetParent as HTMLElement | null; }
    for (parent = target.element; parent && parent !== this.scroll; parent = parent.parentElement) {
      x -= parent.scrollLeft; y -= parent.scrollTop;
    }
    x -= this.scroll.scrollLeft; y -= this.scroll.scrollTop;
    if (visual.svg) {
      const style = getComputedStyle(target.element);
      x += target.element.clientLeft + parseFloat(style.paddingLeft);
      y += target.element.clientTop + parseFloat(style.paddingTop);
      return {x, y, width: visual.svg.clientWidth, height: visual.svg.clientHeight};
    }
    return visual.image ? {x, y, width: visual.image.clientWidth, height: visual.image.clientHeight} : undefined;
  }
  hit(x: number, y: number): ContentAnchor | undefined {
    if (!this.source) return undefined;
    for (const target of this.targets) {
      const box = this.visualBox(target); if (!box || !box.width || !box.height) continue;
      const nx = (x - box.x) / box.width, ny = (y - box.y) / box.height;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      const vector = target.visual!.svg?.viewBox.baseVal;
      const vx = vector ? vector.x + nx * vector.width : 0, vy = vector ? vector.y + ny * vector.height : 0;
      const semantic = target.visual!.targets?.filter(candidate => vx >= candidate.box.x && vx <= candidate.box.x + candidate.box.width && vy >= candidate.box.y && vy <= candidate.box.y + candidate.box.height)
        .sort((a, b) => Number(a.kind === 'group') - Number(b.kind === 'group') || a.box.width * a.box.height - b.box.width * b.box.height)[0];
      return {source: this.source, target: `${target.id}/${semantic?.id ?? (vector ? 'vector' : 'image')}`, offset: 0, x: nx, y: ny};
    }
    const caret = this.caret(x, y);
    if (caret && this.scroll.contains(caret.node)) {
      if (this.lines && caret.node === this.lines.node) {
        const {checkpoints, node} = this.lines;
        let low = 0, high = checkpoints.length - 1;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (checkpoints[middle] <= caret.offset) low = middle; else high = middle - 1;
        }
        let line = low * SOURCE_LINE_STRIDE, start = checkpoints[low];
        for (;;) {
          const next = node.data.indexOf('\n', start);
          if (next < 0 || next >= caret.offset) break;
          start = next + 1; line++;
        }
        return {source: this.source, target: `line:${line}`, offset: caret.offset - start, x: 0, y: 0};
      }
      for (let index = this.targets.length - 1; index >= 0; index--) {
        const target = this.targets[index];
        if (target.node) {
          if (caret.node !== target.node || caret.offset < (target.start ?? 0) || caret.offset > (target.end ?? target.node.length)) continue;
          return {source: this.source, target: target.id, offset: caret.offset - (target.start ?? 0), x: 0, y: 0};
        }
        if (!target.element.contains(caret.node)) continue;
        let offset = 0;
        for (const node of textNodes(target.element)) {
          if (node === caret.node) return {source: this.source, target: target.id, offset: offset + caret.offset, x: 0, y: 0};
          offset += node.length;
        }
      }
    }
    let closest: ReadingTarget | undefined, distance = Infinity;
    for (const target of this.targets) {
      const point = this.point(target, 0); if (!point) continue;
      const next = Math.abs(point.y - y) + Math.abs(point.x - x) * .01;
      if (next < distance) { distance = next; closest = target; }
    }
    return closest ? {source: this.source, target: closest.id, offset: 0, x: 0, y: 0} : undefined;
  }
  capture(): ContentAnchor | undefined {
    if (!this.source || !this.scroll.clientHeight) return undefined;
    // Range geometry works even when the spatial surface is clipped by the screen.
    // Browser caret hit-testing cannot recover source targets outside the viewport.
    const y = Math.min(8, this.scroll.clientHeight / 2);
    let x = Math.min(24, this.scroll.clientWidth / 2);
    let active: ReadingTarget | undefined;
    for (let index = this.targets.length - 1; index >= 0; index--) {
      const element = this.targets[index].element;
      if (!element.offsetHeight) continue;
      let left = 0, top = 0, parent: HTMLElement | null = element;
      while (parent && parent !== this.scroll) {
        left += parent.offsetLeft; top += parent.offsetTop;
        parent = parent.offsetParent as HTMLElement | null;
      }
      top -= this.scroll.scrollTop; left -= this.scroll.scrollLeft;
      if (top <= y && top + element.offsetHeight > y) {
        x = Math.min(this.scroll.clientWidth - 1, Math.max(1, left + (parseFloat(getComputedStyle(element).paddingLeft) || 0) + 4));
        active = this.targets[index];
        break;
      }
    }
    let anchor: ContentAnchor | undefined;
    if (this.lines) {
      const style = getComputedStyle(this.lines.element);
      const lineHeight = parseFloat(style.lineHeight);
      const line = Math.max(0, Math.min(this.lines.count - 1, Math.floor((this.scroll.scrollTop - this.lines.element.offsetTop - parseFloat(style.paddingTop) + y) / lineHeight)));
      active = this.sourceLine(line);
    }
    if (active && !active.visual) {
      const length = active.node ? (active.end ?? active.node.length) - (active.start ?? 0) : textNodes(active.element).reduce((size, node) => size + node.length, 0);
      const lineHeight = parseFloat(getComputedStyle(active.element).lineHeight) || 20;
      const probeY = this.lines ? this.point(active, 0)?.y ?? y : y;
      let low = 0, high = length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2), position = this.point(active, middle);
        if (!position) break;
        if (position.y < probeY - lineHeight / 2 || position.y <= probeY + lineHeight / 2 && position.x < x) low = middle + 1;
        else high = middle;
      }
      anchor = {source: this.source, target: active.id, offset: low, x: 0, y: 0};
    } else anchor = this.hit(x, y);
    if (!anchor) return undefined;
    const point = this.locate(anchor); if (!point) return undefined;
    return this.targets.some(target => target.visual && anchor.target.startsWith(`${target.id}/`))
      ? {...anchor, viewport: [point.x, point.y]} : {...anchor, x: point.x, y: point.y};
  }
  restore(anchor: ContentAnchor): void {
    if (!this.source || anchor.source !== this.source || this.disposed) return;
    const state = contentState(this.spec);
    if (!acceptsContentState({...state, reading:anchor}, this.scroll) || this.resolveTarget?.(anchor.target, anchor) === false) return;
    const point = this.locate(anchor); if (!point) return;
    this.restoring = true;
    this.scroll.scrollTop += point.y - (anchor.viewport?.[1] ?? anchor.y);
    this.scroll.scrollLeft += point.x - (anchor.viewport?.[0] ?? anchor.x);
    state.reading = anchor;
    contentStateChanged(this.scroll);
    requestAnimationFrame(() => { this.restoring = false; });
  }
  locate(anchor: ContentAnchor): {x: number; y: number} | undefined {
    if (anchor.source !== this.source) return undefined;
    const visual = this.targets.find(target => target.visual && anchor.target.startsWith(`${target.id}/`));
    if (visual) {
      const semantic = anchor.target.slice(visual.id.length + 1);
      if (semantic !== 'image' && semantic !== 'vector' && !visual.visual!.targets?.some(target => target.id === semantic)) return;
      const box = this.visualBox(visual);
      return box ? {x: box.x + anchor.x * box.width, y: box.y + anchor.y * box.height} : undefined;
    }
    const target = this.lines && /^line:\d+$/.test(anchor.target) ? this.sourceLine(Number(anchor.target.slice(5))) : this.byId.get(anchor.target);
    return target ? this.point(target, anchor.offset) : undefined;
  }
  setSelection(enabled: boolean): void {
    const state = contentState(this.spec);
    if (!updateContentState(state, {selection:enabled}, this.scroll)) return;
    this.scroll.classList.toggle('native-selecting', enabled);
    if (!enabled && this.scroll.contains(document.getSelection()?.anchorNode ?? null)) document.getSelection()?.removeAllRanges();
    contentStateChanged(this.scroll);
  }
  dispose(): void {
    this.disposed = true; this.observer.disconnect(); this.scroll.removeEventListener('scroll', this.onScroll);
    cancelAnimationFrame(this.frame); this.coordinates.dispose();
  }
}

/** Image anchors are normalized against the decoded original, independent of zoom. */
export class ImageReading implements NativeContent {
  readonly scroll: HTMLElement;
  private source = '';
  private scale = 1;
  private observer: ResizeObserver;
  private frame = 0;
  private restoring = false;
  private disposed = false;
  constructor(scroll: HTMLElement, private stage: HTMLElement, private image: HTMLImageElement, private spec: SceneEntity) {
    this.scroll = scroll; scroll.tabIndex = 0; scroll.classList.add('native-reading', 'native-image');
    contentState(spec);
    this.observer = new ResizeObserver(() => {
      if (!this.source) return;
      const anchor = contentState(spec).reading;
      this.layout();
      if (anchor?.source === this.source) this.restore(anchor);
    });
    this.observer.observe(scroll);
    scroll.addEventListener('scroll', this.onScroll, {passive: true});
  }
  install(source: string): void {
    this.source = source;
    const state = contentState(this.spec);
    const matching = state.reading?.source === source;
    const saved = matching && typeof state.zoom === 'number' && Number.isFinite(state.zoom) ? state.zoom : undefined;
    this.scale = saved === undefined ? Math.min(32, (this.scroll.clientWidth || this.image.naturalWidth) / this.image.naturalWidth,
      (this.scroll.clientHeight || this.image.naturalHeight) / this.image.naturalHeight) : Math.min(32, Math.max(.01, saved));
    updateContentState(state, {zoom: this.scale}, this.scroll);
    this.layout();
    if (state.reading?.source === source) this.restore(state.reading);
    else this.save();
  }
  catalogTargets() { return this.source ? [{id: 'image', label: this.image.alt, anchor: {source: this.source, target: 'image', offset: 0, x: 0, y: 0}}] : []; }
  acceptsAnchor(anchor: ContentAnchor): boolean { return anchor.source === this.source && anchor.target === 'image' && anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1; }
  fit(): void {
    if (!this.source) return;
    this.zoom(Math.min(this.scroll.clientWidth / this.image.naturalWidth, this.scroll.clientHeight / this.image.naturalHeight) / this.scale);
  }
  private layout(): void {
    const width = this.image.naturalWidth * this.scale, height = this.image.naturalHeight * this.scale;
    this.stage.style.width = `${Math.max(width, this.scroll.clientWidth)}px`;
    this.stage.style.height = `${Math.max(height, this.scroll.clientHeight)}px`;
    this.image.style.width = `${width}px`; this.image.style.height = `${height}px`;
    this.image.style.left = `${Math.max(0, (this.scroll.clientWidth - width) / 2)}px`;
    this.image.style.top = `${Math.max(0, (this.scroll.clientHeight - height) / 2)}px`;
  }
  private onScroll = (): void => {
    if (this.restoring || !this.source || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.save(); });
  };
  private save(): void {
    const anchor = this.capture();
    if (!anchor) return;
    const state = contentState(this.spec), previous = state.reading;
    if (!updateContentState(state, {reading: anchor}, this.scroll)) return;
    if (!previous || previous.source !== anchor.source || previous.x !== anchor.x || previous.y !== anchor.y) contentStateChanged(this.scroll);
  }
  hit(x: number, y: number): ContentAnchor | undefined {
    if (!this.source) return undefined;
    const width = this.image.naturalWidth * this.scale, height = this.image.naturalHeight * this.scale;
    const px = (x + this.scroll.scrollLeft - this.image.offsetLeft) / width;
    const py = (y + this.scroll.scrollTop - this.image.offsetTop) / height;
    if (px < 0 || px > 1 || py < 0 || py > 1) return undefined;
    return {source: this.source, target: 'image', offset: 0, x: px, y: py};
  }
  capture(): ContentAnchor | undefined {
    return this.hit(Math.max(0, this.image.offsetLeft - this.scroll.scrollLeft),
      Math.max(0, this.image.offsetTop - this.scroll.scrollTop));
  }
  locate(anchor: ContentAnchor): {x: number; y: number} | undefined {
    if (anchor.source !== this.source || anchor.target !== 'image') return undefined;
    return {x: this.image.offsetLeft + anchor.x * this.image.naturalWidth * this.scale - this.scroll.scrollLeft,
      y: this.image.offsetTop + anchor.y * this.image.naturalHeight * this.scale - this.scroll.scrollTop};
  }
  restore(anchor: ContentAnchor): void {
    if (this.disposed) return;
    const point = this.locate(anchor); if (!point) return;
    if (!updateContentState(contentState(this.spec), {reading: anchor}, this.scroll)) return;
    this.restoring = true;
    this.scroll.scrollLeft += point.x;
    this.scroll.scrollTop += point.y;
    contentStateChanged(this.scroll);
    requestAnimationFrame(() => { this.restoring = false; });
  }
  zoom(factor: number): void {
    if (!this.source || !Number.isFinite(factor) || factor <= 0) return;
    const center = this.hit(this.scroll.clientWidth / 2, this.scroll.clientHeight / 2);
    const scale = Math.min(32, Math.max(.01, this.scale * factor));
    if (!updateContentState(contentState(this.spec), {zoom: scale}, this.scroll)) return;
    this.scale = scale;
    contentStateChanged(this.scroll);
    this.layout();
    if (center) {
      const point = this.locate(center);
      if (point) {
        this.restoring = true;
        this.scroll.scrollLeft += point.x - this.scroll.clientWidth / 2;
        this.scroll.scrollTop += point.y - this.scroll.clientHeight / 2;
        requestAnimationFrame(() => { this.restoring = false; });
      }
    }
    this.save();
  }
  setSelection(enabled: boolean): void {
    if (!updateContentState(contentState(this.spec), {selection: enabled}, this.scroll)) return;
    contentStateChanged(this.scroll);
  }
  dispose(): void {
    this.disposed = true; this.observer.disconnect(); cancelAnimationFrame(this.frame);
    this.scroll.removeEventListener('scroll', this.onScroll);
  }
}
