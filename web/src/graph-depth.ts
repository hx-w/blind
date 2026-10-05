import type { GraphLayer, GraphTarget } from './graph.ts';

type Point = {x: number; y: number};
type Box = Point & {width: number; height: number};
interface PathGeometry {
  path: SVGPathElement;
  matrix: DOMMatrix;
  length: number;
}
interface Projection {
  target: GraphTarget;
  element: SVGGraphicsElement;
  related: SVGGraphicsElement[];
  source: Box;
  projected: Box;
  clone: SVGGraphicsElement;
  labels: SVGGraphicsElement[];
  edge?: {source: PathGeometry; projected: PathGeometry};
}
const NS = 'http://www.w3.org/2000/svg';

function pathPoint(geometry: PathGeometry, fraction: number): DOMPoint {
  const point = geometry.path.getPointAtLength(fraction * geometry.length);
  return new DOMPoint(point.x, point.y).matrixTransform(geometry.matrix);
}

function pathTangent(geometry: PathGeometry, fraction: number): Point {
  const a = pathPoint(geometry, Math.max(0, fraction - 0.0001));
  const b = pathPoint(geometry, Math.min(1, fraction + 0.0001));
  return {x: b.x - a.x, y: b.y - a.y};
}

/** Search in SVG-root coordinates, including nonuniform source path transforms. */
function pathFraction(geometry: PathGeometry, point: Point): number {
  const distance = (fraction: number) => {
    const candidate = pathPoint(geometry, fraction);
    return (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
  };
  const samples = 64;
  let best = 0, score = distance(0);
  for (let index = 1; index <= samples; index++) {
    const next = distance(index / samples);
    if (next < score) { best = index / samples; score = next; }
  }
  let left = Math.max(0, best - 1 / samples), right = Math.min(1, best + 1 / samples);
  for (let iteration = 0; iteration < 24; iteration++) {
    const a = left + (right - left) / 3, b = right - (right - left) / 3;
    if (distance(a) < distance(b)) right = b; else left = a;
  }
  const refined = (left + right) / 2;
  return distance(refined) < score ? refined : best;
}

function mapPathPoint(from: PathGeometry, to: PathGeometry, point: Point): Point {
  const fraction = pathFraction(from, point);
  const source = pathPoint(from, fraction), destination = pathPoint(to, fraction);
  const before = pathTangent(from, fraction), after = pathTangent(to, fraction);
  const angle = Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x);
  const dx = point.x - source.x, dy = point.y - source.y;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {x: destination.x + dx * cos - dy * sin, y: destination.y + dx * sin + dy * cos};
}

/** Orthographic semantic z projection: actual source groups, deterministic planes, real edges. */
export class GraphDepth {
  private scene: SVGGElement;
  private projections = new Map<string, Projection>();
  private enabled = false;
  readonly bounds: Box;

  constructor(private svg: SVGSVGElement, targets: GraphTarget[], layers: GraphLayer[], private flat: Box) {
    this.scene = document.createElementNS(NS, 'g');
    this.scene.classList.add('diagram-semantic-depth');
    this.scene.setAttribute('aria-label', '语义深度');
    this.scene.style.display = 'none';
    svg.append(this.scene);
    const root = svg.getCTM()!;
    const inverse = root.inverse();
    const groups = targets.filter(target => target.kind === 'group');
    // Parent planes precede children. Stable source-renderer order separates sibling planes.
    const ordered: GraphTarget[] = [];
    const remaining = [...groups];
    while (remaining.length) {
      const index = remaining.findIndex(group => !remaining.some(parent => parent !== group && this.contains(parent.box, group.box)));
      ordered.push(...remaining.splice(index < 0 ? 0 : index, 1));
    }
    const offsets = new Map<string, Point>();
    for (let index = 0; index < ordered.length; index++) offsets.set(ordered[index].id, {x: (index + 1) * 96, y: -(index + 1) * 64});
    const layerById = new Map(layers.map(layer => [layer.id, layer]));
    const targetOffsets = new Map(offsets);
    const byArea = [...groups].sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
    for (const group of byArea) {
      for (const id of layerById.get(group.id)?.members ?? []) {
        if (!targetOffsets.has(id)) targetOffsets.set(id, offsets.get(group.id)!);
      }
    }
    const flatOffset = {x: 0, y: 0};
    const cloneAt = (element: SVGGraphicsElement, offset: Point): SVGGraphicsElement => {
      const clone = element.cloneNode(true) as SVGGraphicsElement;
      // Definitions remain in the source SVG. Clones must not duplicate DOM IDs or nested targets.
      clone.removeAttribute('id');
      for (const nested of clone.querySelectorAll('[data-graph-target]')) nested.remove();
      for (const identified of clone.querySelectorAll('[id]')) identified.removeAttribute('id');
      const matrix = inverse.multiply(element.getCTM()!);
      clone.setAttribute('transform', `translate(${offset.x} ${offset.y}) matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
      clone.style.visibility = 'visible';
      return clone;
    };
    const nodes = targets.filter(target => target.kind === 'node');
    const nearest = (point: Point): GraphTarget | undefined => {
      let best: GraphTarget | undefined, distance = Infinity;
      for (const node of nodes) {
        const box = node.box;
        const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.width);
        const dy = Math.max(box.y - point.y, 0, point.y - box.y - box.height);
        const center = Math.hypot(point.x - box.x - box.width / 2, point.y - box.y - box.height / 2);
        const score = dx * dx + dy * dy + center * 0.00001;
        if (score < distance) { best = node; distance = score; }
      }
      return best;
    };
    const orderedTargets = [...ordered, ...targets.filter(target => target.kind === 'edge'), ...nodes];
    for (const target of orderedTargets) {
      let offset = targetOffsets.get(target.id) ?? flatOffset;
      let clone = cloneAt(target.element, offset);
      let projected = {...target.box, x: target.box.x + offset.x, y: target.box.y + offset.y};
      let edge: Projection['edge'];
      if (target.kind === 'group') {
        const plane = document.createElementNS(NS, 'path');
        const b = target.box;
        plane.setAttribute('d', `M ${b.x} ${b.y} L ${b.x + offset.x} ${b.y + offset.y} L ${b.x + b.width + offset.x} ${b.y + offset.y} L ${b.x + b.width} ${b.y} Z`);
        plane.setAttribute('fill', '#e8ebef'); plane.setAttribute('fill-opacity', '0.55');
        plane.setAttribute('stroke', '#9aa3af'); plane.setAttribute('stroke-width', '0.75');
        plane.setAttribute('pointer-events', 'none');
        this.scene.append(plane);
        clone.setAttribute('data-semantic-depth', String(ordered.indexOf(target) + 1));
      }
      if (target.kind === 'edge') {
        const path = target.element instanceof SVGPathElement ? target.element : target.element.querySelector<SVGPathElement>('path');
        if (path) {
          const matrix = inverse.multiply(path.getCTM()!);
          const source: PathGeometry = {path, matrix, length: path.getTotalLength()};
          const start = path.getPointAtLength(0).matrixTransform(matrix);
          const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
          const from = nearest(start), to = nearest(end);
          const first = from ? targetOffsets.get(from.id) ?? flatOffset : offset;
          const last = to ? targetOffsets.get(to.id) ?? flatOffset : offset;
          offset = {x: (first.x + last.x) / 2, y: (first.y + last.y) / 2};
          if (first.x !== last.x || first.y !== last.y) {
            const group = document.createElementNS(NS, 'g');
            group.dataset.graphTarget = target.id;
            const connector = path.cloneNode(true) as SVGPathElement;
            connector.removeAttribute('id'); connector.removeAttribute('transform');
            const a = {x: start.x + first.x, y: start.y + first.y}, b = {x: end.x + last.x, y: end.y + last.y};
            const dx = b.x - a.x, dy = b.y - a.y;
            connector.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx / 3} ${a.y}, ${b.x - dx / 3} ${b.y}, ${b.x} ${b.y}`);
            connector.style.fill = 'none';
            group.append(connector);
            edge = {source, projected: {path: connector, matrix: new DOMMatrix(), length: connector.getTotalLength()}};
            projected = {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(dx) || 1, height: Math.abs(dy) || 1};
            // DOT represents labels and arrowheads as separate SVG primitives.
            for (const decoration of target.element.querySelectorAll<SVGGraphicsElement>('polygon, text')) {
              const box = decoration.getBBox(), transform = inverse.multiply(decoration.getCTM()!);
              const center = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(transform);
              let decorationMatrix: DOMMatrix;
              if (decoration.localName === 'text') {
                decorationMatrix = new DOMMatrix().translate(offset.x, offset.y).multiply(transform);
              } else {
                const atStart = Math.hypot(center.x - start.x, center.y - start.y) < Math.hypot(center.x - end.x, center.y - end.y);
                const fraction = atStart ? 0 : 1;
                const origin = atStart ? start : end, destination = atStart ? a : b;
                const before = pathTangent(source, fraction), after = pathTangent(edge.projected, fraction);
                const angle = (Math.atan2(after.y, after.x) - Math.atan2(before.y, before.x)) * 180 / Math.PI;
                // Rotate around the path endpoint, not the polygon center: DOT's gap and
                // attachment vector must turn with the tangent at both ends of the edge.
                decorationMatrix = new DOMMatrix().translate(destination.x, destination.y).rotate(angle)
                  .translate(-origin.x, -origin.y).multiply(transform);
              }
              const decorationClone = cloneAt(decoration, {x: 0, y: 0});
              const m = decorationMatrix;
              decorationClone.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
              group.append(decorationClone);
              const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
                .map(([x, y]) => new DOMPoint(x, y).matrixTransform(decorationMatrix));
              for (const corner of corners) {
                const {x, y} = corner;
                const right = Math.max(projected.x + projected.width, x), bottom = Math.max(projected.y + projected.height, y);
                projected.x = Math.min(projected.x, x); projected.y = Math.min(projected.y, y);
                projected.width = right - projected.x; projected.height = bottom - projected.y;
              }
            }
            clone = group;
          } else {
            clone = cloneAt(target.element, first);
            projected = {...target.box, x: target.box.x + first.x, y: target.box.y + first.y};
            edge = {source, projected: {path, matrix: new DOMMatrix().translate(first.x, first.y).multiply(matrix), length: source.length}};
          }
        }
      }
      const labels = target.related.map(label => cloneAt(label, offset));
      this.scene.append(clone, ...labels);
      this.projections.set(target.id, {target, element: target.element, related: target.related, source: {...target.box}, projected, clone, labels, edge});
    }
    let x = flat.x, y = flat.y, right = flat.x + flat.width, bottom = flat.y + flat.height;
    for (const projection of this.projections.values()) {
      const box = projection.projected;
      x = Math.min(x, box.x); y = Math.min(y, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
    }
    this.bounds = {x: x - 12, y: y - 12, width: right - x + 24, height: bottom - y + 24};
  }

  private contains(parent: Box, child: Box): boolean {
    return parent.width * parent.height > child.width * child.height
      && child.x >= parent.x - 1 && child.y >= parent.y - 1
      && child.x + child.width <= parent.x + parent.width + 1 && child.y + child.height <= parent.y + parent.height + 1;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.scene.style.display = enabled ? '' : 'none';
    for (const projection of this.projections.values()) {
      projection.element.style.visibility = enabled ? 'hidden' : 'visible';
      for (const label of projection.related) label.style.visibility = enabled ? 'hidden' : 'visible';
      projection.target.element = enabled ? projection.clone : projection.element;
      projection.target.related = enabled ? projection.labels : projection.related;
      projection.target.box = enabled ? projection.projected : projection.source;
    }
    const box = enabled ? this.bounds : this.flat;
    this.svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  }

  project(id: string, point: Point, offset: number): Point {
    const projection = this.enabled ? this.projections.get(id) : undefined;
    if (!projection) return point;
    if (projection.edge) return mapPathPoint(projection.edge.source, projection.edge.projected, point);
    const a = projection.source, b = projection.projected;
    return {x: b.x + (a.width ? (point.x - a.x) / a.width : offset) * b.width,
      y: b.y + (a.height ? (point.y - a.y) / a.height : offset) * b.height};
  }

  unproject(id: string, point: Point): Point & {offset?: number} {
    const projection = this.enabled ? this.projections.get(id) : undefined;
    if (!projection) return point;
    if (projection.edge) return {...mapPathPoint(projection.edge.projected, projection.edge.source, point), offset: 0};
    const a = projection.projected, b = projection.source;
    return {x: b.x + (a.width ? (point.x - a.x) / a.width : 0.5) * b.width,
      y: b.y + (a.height ? (point.y - a.y) / a.height : 0.5) * b.height,
      offset: !b.width && a.width ? (point.x - a.x) / a.width : !b.height && a.height ? (point.y - a.y) / a.height : 0};
  }
}
