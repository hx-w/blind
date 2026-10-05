import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
import {renderDot} from './dot-render.ts';
import {DIAGRAM_MAX_OUTPUT} from './dot-work.ts';

export type DiagramKind = 'mermaid' | 'dot';
const MAX_SOURCE = 2 * 1024 * 1024;
let mermaidInitialized = false;
let serial = 0;
let mermaidQueue = Promise.resolve();

function safeCss(value: string): boolean {
  // Escapes/comments can hide resource-bearing CSS tokens. Renderer CSS needs neither.
  return !/\\|\/\*|@(?:import|font-face|namespace)|expression\s*\(|(?:https?:|data:|javascript:|\/\/)/i.test(value)
    && Array.from(value.matchAll(/url\s*\(([^)]*)\)/gi)).every(match => /^\s*['"]?#[\w:.-]+['"]?\s*$/.test(match[1]));
}

/** SVG is inert: local paint references only, no links, HTML, scripts or image resources. */
export function sanitizeDiagram(svgSource: string): SVGSVGElement {
  if (new TextEncoder().encode(svgSource).byteLength > DIAGRAM_MAX_OUTPUT) throw new Error('图表 SVG 超过 8 MiB');
  const clean = DOMPurify.sanitize(svgSource, {
    USE_PROFILES: {svg: true, svgFilters: true},
    FORBID_TAGS: ['script', 'foreignObject', 'image', 'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['target', 'tabindex'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-id'],
  });
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('图表未生成有效 SVG');
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith('on') || name === 'src' || name === 'srcset'
        || (name === 'href' && !/^#[\w:.-]+$/.test(attribute.value))
        || ((name === 'style' || /url\s*\(/i.test(attribute.value)) && !safeCss(attribute.value))) {
        element.removeAttributeNode(attribute);
      }
    }
    if (element.localName === 'style' && !safeCss(element.textContent ?? '')) element.remove();
  }
  for (const link of svg.querySelectorAll('a')) link.replaceWith(...link.childNodes);
  svg.removeAttribute('style');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  // Mermaid/Graphviz both emit a viewBox. Refuse malformed dimensions rather than inventing a graph.
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
    throw new Error('图表没有有效的矢量尺寸');
  }
  return window.document.importNode(svg, true) as unknown as SVGSVGElement;
}

export async function renderDiagram(kind: DiagramKind, source: string, signal?: AbortSignal): Promise<SVGSVGElement> {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE) throw new Error('图表源文件超过 2 MiB');
  signal?.throwIfAborted();
  if (kind === 'dot') return sanitizeDiagram(await renderDot(source, signal));
  await document.fonts.ready;
  signal?.throwIfAborted();
  // Image nodes are inserted by Mermaid before its SVG is returned. Never allow that transient
  // rendering DOM to start a resource request, even though the final SVG is sanitized as well.
  if (/\bimg['"]?\s*:/i.test(source) || /<\s*(?:img|image)\b/i.test(source)) throw new Error('图表不支持外部图片资源');
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      maxTextSize: MAX_SOURCE, maxEdges: 10000, htmlLabels: false,
      flowchart: {htmlLabels: false}, theme: 'neutral', fontFamily: 'sans-serif',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
        'htmlLabels', 'flowchart', 'theme', 'themeCSS', 'themeVariables', 'fontFamily'],
    });
    mermaidInitialized = true;
  }
  if (/url\s*\(|@import/i.test(source) || /^\s*(?:classDef|style)\b.*\\/im.test(source)) {
    throw new Error('图表样式不支持资源引用');
  }
  const previous = mermaidQueue;
  let release!: () => void;
  mermaidQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  if (signal?.aborted) { release(); signal.throwIfAborted(); }
  const mount = document.createElement('div');
  mount.className = 'diagram-render-mount';
  mount.setAttribute('aria-hidden', 'true');
  document.body.append(mount);
  try {
    // Sequence actor properties can encode icon URLs as JSON escapes. Inspect the parsed DB,
    // not just source spelling, before Mermaid is allowed to create its temporary image DOM.
    const parsed = await mermaid.mermaidAPI.getDiagramFromText(source);
    const db = parsed.db as {
      getActors?: () => Map<string, {properties?: {icon?: string}}>;
      getVertices?: () => Map<string, {img?: string; styles?: string[]}>;
      getClasses?: () => Map<string, {styles?: string[]}> | Record<string, {styles?: string[]}>;
      getEdges?: () => {style?: string[]}[] & {defaultStyle?: string[]};
      getData?: () => {nodes?: {img?: string}[]};
    };
    for (const actor of db.getActors?.().values() ?? []) {
      if (actor.properties?.icon && !actor.properties.icon.trim().startsWith('@')) throw new Error('图表不支持外部图片资源');
    }
    for (const vertex of db.getVertices?.().values() ?? []) {
      if (vertex.img) throw new Error('图表不支持外部图片资源');
      if (vertex.styles?.some(style => !safeCss(style))) throw new Error('图表样式不支持资源引用');
    }
    const classes = db.getClasses?.();
    for (const definition of classes instanceof Map ? classes.values() : Object.values(classes ?? {})) {
      if (definition.styles?.some(style => !safeCss(style))) throw new Error('图表样式不支持资源引用');
    }
    const edges = db.getEdges?.();
    if (edges?.defaultStyle?.some(style => !safeCss(style)) || edges?.some(edge => edge.style?.some(style => !safeCss(style)))) {
      throw new Error('图表样式不支持资源引用');
    }
    if (parsed.type === 'kanban' && db.getData?.().nodes?.some(node => node.img)) throw new Error('图表不支持外部图片资源');
    const result = await mermaid.render(`blind-graph-${++serial}`, source, mount);
    return sanitizeDiagram(result.svg);
  } finally { mount.remove(); release(); }
}

export interface GraphTarget {
  id: string;
  label: string;
  element: SVGGraphicsElement;
  related: SVGGraphicsElement[];
  box: {x: number; y: number; width: number; height: number};
  kind: 'node' | 'edge' | 'group';
}
export interface GraphLayer { id: string; label: string; members: Set<string> }

/** Derive membership from actual renderer groups, never synthetic depth or arbitrary partitions. */
export function graphTargets(svg: SVGSVGElement, kind: DiagramKind): {targets: GraphTarget[]; layers: GraphLayer[]} {
  const targets: GraphTarget[] = [];
  const counts = new Map<string, number>();
  const edgeLabels = new Map<string, SVGGraphicsElement[]>();
  if (kind === 'mermaid') {
    for (const label of svg.querySelectorAll<SVGGraphicsElement>('g.edgeLabel')) {
      const id = label.querySelector('[data-id]')?.getAttribute('data-id');
      if (!id) continue;
      const labels = edgeLabels.get(id);
      if (labels) labels.push(label);
      else edgeLabels.set(id, [label]);
    }
  }
  const rootMatrix = svg.getCTM();
  if (!rootMatrix) return {targets, layers: []};
  const inverse = rootMatrix.inverse();
  const add = (element: SVGGraphicsElement, type: GraphTarget['kind']) => {
    const title = element.querySelector(':scope > title')?.textContent?.trim();
    let semantic = title || element.getAttribute('data-id') || element.id;
    if (kind === 'mermaid') {
      if (semantic.startsWith(`${svg.id}-`)) semantic = semantic.slice(svg.id.length + 1);
      if (type === 'node') semantic = semantic.replace(/^flowchart-(.*)-\d+$/, '$1');
    }
    if (!semantic) return;
    const key = `${type}:${semantic}`;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    const id = count ? `${key}:${count}` : key;
    const matrix = element.getCTM();
    if (!matrix) return;
    const bounds = element.getBBox();
    const transform = inverse.multiply(matrix);
    const points = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
      [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]
      .map(([x, y]) => new DOMPoint(x, y).matrixTransform(transform));
    const x = Math.min(...points.map(point => point.x)), y = Math.min(...points.map(point => point.y));
    const width = Math.max(...points.map(point => point.x)) - x, height = Math.max(...points.map(point => point.y)) - y;
    const label = title || element.querySelector('text, .nodeLabel, .cluster-label')?.textContent?.trim() || semantic;
    element.dataset.graphTarget = id;
    const related = kind === 'mermaid' && type === 'edge' ? edgeLabels.get(semantic) ?? [] : [];
    targets.push({id, label, element, related, box: {x, y, width, height}, kind: type});
  };
  const nodes = kind === 'dot' ? 'g.node' : 'g.node, g.actor, g.task';
  const edges = kind === 'dot' ? 'g.edge' : 'g.edgePath, path.flowchart-link, path.relation';
  for (const node of svg.querySelectorAll<SVGGraphicsElement>(nodes)) add(node, 'node');
  for (const edge of svg.querySelectorAll<SVGGraphicsElement>(edges)) add(edge, 'edge');
  for (const group of svg.querySelectorAll<SVGGraphicsElement>('g.cluster')) add(group, 'group');
  const layers = targets.filter(target => target.kind === 'group').map(group => {
    const {x, y, width, height} = group.box;
    const members = new Set(targets.filter(target => {
      if (target.kind === 'group') return target.id === group.id;
      const box = target.box;
      if (target.kind === 'edge') return box.x >= x - 1 && box.y >= y - 1 && box.x + box.width <= x + width + 1 && box.y + box.height <= y + height + 1;
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      return cx >= x && cx <= x + width && cy >= y && cy <= y + height;
    }).map(target => target.id));
    return {id: group.id, label: group.label, members};
  });
  return {targets, layers};
}
