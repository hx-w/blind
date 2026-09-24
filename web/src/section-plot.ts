export type PlanePoint = [number, number];
export interface PlaneSegment { a: PlanePoint; b: PlanePoint }
export interface ContourHit { point: PlanePoint; index: number }
export interface OppositeHit { point: PlanePoint; distance: number }
export interface ContourGraph {
  segments: readonly PlaneSegment[];
  nodes: readonly [number, number][];
  incident: ReadonlyMap<number, number[]>;
  lengths: readonly number[];
  span: number;
  componentSpan: readonly number[];
}

/** Fit all selected Mesh contours, including those far from the anchor Mesh. */
export function fitContours(segments: readonly PlaneSegment[], fallbackRadius: number): { radius: number; pan: PlanePoint } {
  if (!segments.length) return {radius: fallbackRadius, pan: [0, 0]};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const segment of segments) for (const point of [segment.a, segment.b]) {
    minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
    minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
  }
  return {
    radius: Math.max((maxX - minX) / 2, (maxY - minY) / 2, fallbackRadius * .01, 1e-8) * 1.12,
    pan: [(minX + maxX) / 2, (minY + maxY) / 2],
  };
}

/** The pick tolerance is expressed in pixels by the caller, then converted to plane units. */
export function snapContour(point: PlanePoint, segments: readonly PlaneSegment[], maxDistance: number): ContourHit {
  let closest = point, index = -1;
  let distanceSquared = maxDistance * maxDistance;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const dx = segment.b[0] - segment.a[0], dy = segment.b[1] - segment.a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - segment.a[0]) * dx + (point[1] - segment.a[1]) * dy) / lengthSquared)) : 0;
    const candidate: PlanePoint = [segment.a[0] + t * dx, segment.a[1] + t * dy];
    const candidateDistance = (candidate[0] - point[0]) ** 2 + (candidate[1] - point[1]) ** 2;
    if (candidateDistance <= distanceSquared) { closest = candidate; distanceSquared = candidateDistance; index = i; }
  }
  return {point: closest, index};
}

/** Weld unordered triangle intersections into contour connectivity once per slice. */
export function buildContourGraph(segments: readonly PlaneSegment[]): ContourGraph {
  if (!segments.length) return {segments, nodes:[], incident:new Map(), lengths:[], span:0, componentSpan:[]};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const segment of segments) for (const [x,y] of [segment.a,segment.b]) {
    minX = Math.min(minX,x); maxX = Math.max(maxX,x); minY = Math.min(minY,y); maxY = Math.max(maxY,y);
  }
  const span = Math.hypot(maxX-minX,maxY-minY);
  const tolerance = Math.max(span * 1e-8, 1e-9), toleranceSquared = tolerance * tolerance;
  const buckets = new Map<string, number[]>(), positions: PlanePoint[] = [];
  const key = (x: number,y: number) => `${x},${y}`;
  const nodeFor = (point: PlanePoint): number => {
    const cx = Math.round(point[0] / tolerance), cy = Math.round(point[1] / tolerance);
    for (let x=cx-1;x<=cx+1;x++) for (let y=cy-1;y<=cy+1;y++)
      for (const node of buckets.get(key(x,y)) ?? []) {
        const position = positions[node];
        if ((position[0]-point[0])**2 + (position[1]-point[1])**2 <= toleranceSquared) return node;
      }
    const index = positions.length; positions.push(point);
    const bucket = key(cx,cy); if (!buckets.has(bucket)) buckets.set(bucket,[]);
    buckets.get(bucket)!.push(index); return index;
  };
  const nodes: [number,number][] = [], incident = new Map<number,number[]>(), lengths: number[] = [];
  segments.forEach((segment,index) => {
    const a = nodeFor(segment.a), b = nodeFor(segment.b);
    nodes.push([a,b]);
    const length = Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);
    lengths.push(length);
    for (const node of new Set([a,b])) {
      const adjacent = incident.get(node) ?? []; adjacent.push(index); incident.set(node,adjacent);
    }
  });
  const componentSpan = Array<number>(segments.length).fill(0), visited = new Set<number>();
  for (let index=0;index<segments.length;index++) {
    if (visited.has(index)) continue;
    const pending = [index], members: number[] = [];
    let componentMinX = Infinity, componentMaxX = -Infinity, componentMinY = Infinity, componentMaxY = -Infinity;
    visited.add(index);
    while (pending.length) {
      const segmentIndex = pending.pop()!;
      members.push(segmentIndex);
      for (const [x,y] of [segments[segmentIndex].a,segments[segmentIndex].b]) {
        componentMinX = Math.min(componentMinX,x); componentMaxX = Math.max(componentMaxX,x);
        componentMinY = Math.min(componentMinY,y); componentMaxY = Math.max(componentMaxY,y);
      }
      for (const node of nodes[segmentIndex]) for (const neighbor of incident.get(node) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor); pending.push(neighbor);
      }
    }
    const size = Math.hypot(componentMaxX-componentMinX,componentMaxY-componentMinY);
    for (const member of members) componentSpan[member] = size;
  }
  return {segments,nodes,incident,lengths,span,componentSpan};
}

/** AutoCrown's contour-arc exclusion and tangential rejection, scaled to a unitless Mesh. */
export function oppositeContour(graph: ContourGraph, from: PlanePoint, fromSegment: number): OppositeHit | null {
  const {segments,nodes,incident,lengths,span,componentSpan} = graph;
  if (fromSegment < 0 || fromSegment >= segments.length || span <= 0) return null;
  const localSpan = componentSpan[fromSegment] || span;
  const excludeArc = Math.max(lengths[fromSegment] * 3, localSpan * .015);
  // A single broad round contour has no meaningful opposing wall nearby.
  const maxDistanceSquared = (localSpan * .33) ** 2;
  const excluded = new Set<number>([fromSegment]), seen = new Map<number,number>();
  const queue: Array<[number,number]> = [];
  const [n0,n1] = nodes[fromSegment], first = segments[fromSegment];
  for (const [node,end] of [[n0,first.a],[n1,first.b]] as const) {
    const arc = Math.hypot(end[0]-from[0],end[1]-from[1]);
    if (arc <= excludeArc && (seen.get(node) ?? Infinity) > arc) {seen.set(node,arc);queue.push([node,arc]);}
  }
  for (let head=0;head<queue.length;head++) {
    const [node,arc] = queue[head];
    for (const index of incident.get(node) ?? []) {
      excluded.add(index);
      const nextArc = arc + lengths[index]; if (nextArc > excludeArc) continue;
      const [a,b] = nodes[index], other = a===node?b:a;
      if ((seen.get(other) ?? Infinity) <= nextArc) continue;
      seen.set(other,nextArc); queue.push([other,nextArc]);
    }
  }
  const tangentLength = lengths[fromSegment] || 1;
  const tx = (first.b[0]-first.a[0])/tangentLength, ty = (first.b[1]-first.a[1])/tangentLength;
  let best: OppositeHit | null = null, bestSquared = maxDistanceSquared;
  for (let index=0;index<segments.length;index++) {
    if (excluded.has(index)) continue;
    const segment = segments[index];
    const dx = segment.b[0]-segment.a[0], dy = segment.b[1]-segment.a[1];
    const lengthSquared = dx*dx+dy*dy;
    const t = lengthSquared ? Math.max(0,Math.min(1,((from[0]-segment.a[0])*dx+(from[1]-segment.a[1])*dy)/lengthSquared)) : 0;
    const point: PlanePoint = [segment.a[0]+dx*t,segment.a[1]+dy*t];
    const vx = point[0]-from[0], vy = point[1]-from[1], distanceSquared = vx*vx+vy*vy;
    if (!(distanceSquared > 0 && distanceSquared < bestSquared)) continue;
    const distance = Math.sqrt(distanceSquared);
    if (Math.abs((vx*tx+vy*ty)/distance) > Math.SQRT1_2) continue;
    bestSquared = distanceSquared; best = {point,distance};
  }
  return best;
}
