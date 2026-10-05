import { apiError } from './api.ts';
import type { ContentFactory } from './component-content.ts';
import type { ContentAnchor, NativeContent } from './content-surface.ts';
import { graphTargets, renderDiagram } from './graph.ts';
import { contentState, contentStateChanged, sourceIdentity, updateContentState } from './content-reading.ts';
import type { DiagramKind, GraphLayer, GraphTarget } from './graph.ts';
import { GraphDepth } from './graph-depth.ts';
import './diagram.css';

const LIMIT = 2 * 1024 * 1024;
const PADDING = 24;

async function diagramBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {signal, cache: 'no-store'});
  if (!response.ok) throw await apiError(response);
  if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('图表源文件超过 2 MiB');
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > LIMIT) throw new Error('图表源文件超过 2 MiB');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { await reader.cancel(); throw new Error('图表源文件超过 2 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** DOM/SVG remains a native surface in both spatial and expanded presentations. */
export const diagramContent: ContentFactory = (url, label, spec) => {
  const element = document.createElement('div');
  element.className = 'component-content component-diagram';
  const viewport = document.createElement('div');
  viewport.className = 'diagram-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', `${label}，方向键平移，加减键缩放，Home 适应窗口`);
  const canvas = document.createElement('div');
  canvas.className = 'diagram-canvas';
  canvas.textContent = '正在绘制图表…';
  viewport.append(canvas);
  element.append(viewport);
  const abort = new AbortController();
  const state = contentState(spec);
  let source = '', svg: SVGSVGElement | undefined;
  let viewBox = {x: 0, y: 0, width: 1, height: 1};
  let sourceBox = {...viewBox};
  let depth: GraphDepth | undefined;
  let scale = Number.isFinite(state.zoom) && state.zoom! > 0 ? Math.min(16, Math.max(0.1, state.zoom!)) : 1;
  let targets: GraphTarget[] = [], layers: GraphLayer[] = [];
  let disposed = false, initializing = true, frame = 0;
  let pendingRestore: ContentAnchor | undefined;

  const setSize = () => {
    if (!svg) return;
    svg.style.width = `${viewBox.width * scale}px`;
    svg.style.height = `${viewBox.height * scale}px`;
    canvas.style.width = `${viewBox.width * scale + PADDING * 2}px`;
    canvas.style.height = `${viewBox.height * scale + PADDING * 2}px`;
  };
  const point = (x: number, y: number) => ({
    x: (x + viewport.scrollLeft - PADDING) / (viewBox.width * scale),
    y: (y + viewport.scrollTop - PADDING) / (viewBox.height * scale),
  });
  const native: NativeContent = {
    scroll: viewport,
    capture() {
      if (!source) return;
      const x = Math.max(PADDING - viewport.scrollLeft, Math.min(viewport.clientWidth / 2, PADDING + viewBox.width * scale - viewport.scrollLeft));
      const y = Math.max(PADDING - viewport.scrollTop, Math.min(viewport.clientHeight / 2, PADDING + viewBox.height * scale - viewport.scrollTop));
      const center = native.hit(x, y);
      if (center) return center;
      const vx = viewBox.x + point(x, y).x * viewBox.width, vy = viewBox.y + point(x, y).y * viewBox.height;
      let closest: GraphTarget | undefined, distance = Infinity;
      for (const target of targets) {
        if (target.element.style.visibility === 'hidden') continue;
        const box = target.box;
        const score = (box.x + box.width / 2 - vx) ** 2 + (box.y + box.height / 2 - vy) ** 2;
        if (score < distance) { closest = target; distance = score; }
      }
      if (!closest) return;
      const box = closest.box;
      const origin = depth?.unproject(closest.id, {x: box.x + box.width / 2, y: box.y + box.height / 2})
        ?? {x: box.x + box.width / 2, y: box.y + box.height / 2, offset: 0};
      return {source, target: closest.id, offset: origin.offset ?? 0, x: (origin.x - sourceBox.x) / sourceBox.width, y: (origin.y - sourceBox.y) / sourceBox.height};
    },
    restore(anchor) {
      if (!source) { pendingRestore = anchor; return; }
      const position = native.locate(anchor);
      if (!position || !updateContentState(state, {reading: anchor}, element)) return;
      viewport.scrollLeft += position.x - viewport.clientWidth / 2;
      viewport.scrollTop += position.y - viewport.clientHeight / 2;
    },
    hit(x, y) {
      if (!source || !svg) return;
      const normalized = point(x, y);
      if (normalized.x < 0 || normalized.x > 1 || normalized.y < 0 || normalized.y > 1) return;
      const vx = viewBox.x + normalized.x * viewBox.width, vy = viewBox.y + normalized.y * viewBox.height;
      let target: GraphTarget | undefined;
      for (const candidate of targets) {
        const box = candidate.box;
        if (candidate.element.style.visibility === 'hidden' || vx < box.x || vx > box.x + box.width || vy < box.y || vy > box.y + box.height) continue;
        if (candidate.kind === 'edge') {
          const geometries = candidate.element instanceof SVGGeometryElement ? [candidate.element]
            : candidate.element.querySelectorAll<SVGGeometryElement>('path, polygon, polyline, ellipse, rect, circle');
          let onEdge = false;
          const rootMatrix = svg.getCTM();
          for (const geometry of geometries) {
            const matrix = geometry.getCTM();
            if (!matrix || !rootMatrix) continue;
            const local = new DOMPoint(vx, vy).matrixTransform(matrix.inverse().multiply(rootMatrix));
            if (geometry.isPointInStroke(local) || geometry.isPointInFill(local)) { onEdge = true; break; }
          }
          if (!onEdge) continue;
        }
        if (!target || (target.kind === 'group' && candidate.kind !== 'group')
          || ((target.kind === 'group') === (candidate.kind === 'group') && box.width * box.height < target.box.width * target.box.height)) target = candidate;
      }
      const origin = target && depth ? depth.unproject(target.id, {x: vx, y: vy}) : {x: vx, y: vy, offset: 0};
      const sx = (origin.x - sourceBox.x) / sourceBox.width, sy = (origin.y - sourceBox.y) / sourceBox.height;
      if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return;
      return {source, target: target?.id ?? 'vector', offset: origin.offset ?? 0, x: sx, y: sy};
    },
    locate(anchor) {
      if (!source || anchor.source !== source || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
      if (anchor.target !== 'vector' && !targets.some(target => target.id === anchor.target && target.element.style.visibility !== 'hidden')) return;
      const sourcePoint = {x: sourceBox.x + anchor.x * sourceBox.width, y: sourceBox.y + anchor.y * sourceBox.height};
      const position = depth?.project(anchor.target, sourcePoint, anchor.offset) ?? sourcePoint;
      return {x: PADDING + (position.x - viewBox.x) * scale - viewport.scrollLeft,
        y: PADDING + (position.y - viewBox.y) * scale - viewport.scrollTop};
    },
    setSelection(enabled) {
      if (!updateContentState(state, {selection: enabled}, element)) return;
      viewport.classList.toggle('diagram-selectable', enabled);
      if (!initializing) contentStateChanged(element);
    },
    zoom(factor) {
      if (!Number.isFinite(factor) || factor <= 0) return;
      const anchor = native.capture();
      const nextScale = Math.min(16, Math.max(0.1, scale * factor));
      if (!updateContentState(state, {zoom: nextScale}, element)) return;
      scale = nextScale;
      setSize();
      if (anchor) native.restore(anchor);
      updateContentState(state, {reading: native.capture()}, element);
      if (!initializing) contentStateChanged(element);
    },
    get layers() { return layers.length ? [{id: '', label: '完整图表'}, {id: 'depth', label: '语义深度'}, ...layers.map(({id, label}) => ({id, label}))] : undefined; },
    setLayer(id) {
      const layer = layers.find(layer => layer.id === id);
      if (id && !layer && !(id === 'depth' && depth)) return;
      const reading = initializing ? undefined : native.capture();
      if (!updateContentState(state, {layer: id}, element)) return;
      depth?.setEnabled(id === 'depth');
      viewBox = id === 'depth' && depth ? depth.bounds : sourceBox;
      setSize();
      for (const target of targets) {
        const visibility = !layer || layer.members.has(target.id) ? 'visible' : 'hidden';
        target.element.style.visibility = visibility;
        for (const related of target.related) related.style.visibility = visibility;
      }
      // During reopen, only install the layer geometry. The saved reading point
      // is restored afterwards, without capturing or publishing a temporary view.
      if (initializing) return;
      if (layer) {
        const group = targets.find(target => target.id === id);
        if (group) native.restore({source, target: id, offset: 0,
          x: (group.box.x + group.box.width / 2 - sourceBox.x) / sourceBox.width,
          y: (group.box.y + group.box.height / 2 - sourceBox.y) / sourceBox.height});
      } else if (reading) native.restore(reading);
      updateContentState(state, {reading: native.capture()}, element);
      contentStateChanged(element);
    },
  };
  native.setSelection(state.selection ?? false);
  const fit = () => {
    if (!svg || viewport.clientWidth <= PADDING * 2 || viewport.clientHeight <= PADDING * 2) return;
    const next = Math.min((viewport.clientWidth - PADDING * 2) / viewBox.width, (viewport.clientHeight - PADDING * 2) / viewBox.height);
    native.zoom!(next / scale);
  };
  viewport.addEventListener('scroll', () => {
    if (frame || !source || initializing) return;
    frame = requestAnimationFrame(() => { frame = 0; if (updateContentState(state, {reading: native.capture()}, element)) contentStateChanged(element); });
  }, {signal: abort.signal});
  viewport.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); native.zoom!(1.25); }
    else if (event.key === '-') { event.preventDefault(); native.zoom!(1 / 1.25); }
    else if (event.key === 'Home') { event.preventDefault(); fit(); }
  }, {signal: abort.signal});
  viewport.addEventListener('wheel', event => {
    if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault(); native.zoom!(Math.exp(-event.deltaY * 0.002));
  }, {passive: false, signal: abort.signal});
  const resize = new ResizeObserver(() => {
    if (!initializing && state.reading) native.restore(state.reading);
  });
  resize.observe(viewport);
  const kind: DiagramKind = spec.component === 'mermaid' ? 'mermaid' : 'dot';
  const ready = diagramBytes(url, abort.signal).then(async bytes => {
    const identity = await sourceIdentity(bytes);
    const rendered = await renderDiagram(kind, new TextDecoder('utf-8', {fatal: true}).decode(bytes), abort.signal);
    if (disposed) return;
    source = identity; svg = rendered;
    const box = svg.viewBox.baseVal;
    viewBox = {x: box.x, y: box.y, width: box.width, height: box.height};
    sourceBox = {...viewBox};
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
    canvas.replaceChildren(svg); setSize();
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (disposed) return;
    ({targets, layers} = graphTargets(svg, kind));
    if (layers.length) depth = new GraphDepth(svg, targets, layers, sourceBox);
    const initialReading = pendingRestore ?? state.reading;
    if (state.layer && native.layers?.some(layer => layer.id === state.layer)) native.setLayer!(state.layer);
    if (initialReading) native.restore(initialReading);
    else if (state.zoom === undefined) fit();
    // Browser scroll notifications from layer layout/restoration must drain while
    // initialization is still silent, rather than overwrite the persisted anchor.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    initializing = false;
  });
  void ready.catch(error => {
    if (disposed || abort.signal.aborted) return;
    canvas.classList.add('diagram-error');
    canvas.textContent = `图表无法绘制：${error instanceof Error ? error.message : String(error)}`;
  });
  return {element, ready, native, present: () => { if (state.reading) native.restore(state.reading); }, dispose() {
    disposed = true; abort.abort(); resize.disconnect(); cancelAnimationFrame(frame);
  }};
};
