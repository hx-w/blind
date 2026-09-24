import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

export type SectionSegment = { a: THREE.Vector3; b: THREE.Vector3 };

/** Intersect only the selected object's triangles. The source geometry is never changed. */
export function intersectSection(object: THREE.Object3D, worldPlane: THREE.Plane): SectionSegment[] {
  const segments: SectionSegment[] = [];
  object.updateWorldMatrix(true, true);
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const localPlane = worldPlane.clone().applyMatrix4(child.matrixWorld.clone().invert());
    const size = geometry.boundingBox?.getSize(new THREE.Vector3()).length() ?? 1;
    const tolerance = Math.max(size * 1e-8, 1e-9);
    const addTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
      const vertices = [a, b, c], distances = vertices.map(v => localPlane.distanceToPoint(v));
      const crossings: THREE.Vector3[] = [];
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3, da = distances[i], db = distances[j];
        if (Math.abs(da) <= tolerance && Math.abs(db) <= tolerance) continue;
        let point: THREE.Vector3 | undefined;
        if (Math.abs(da) <= tolerance) point = vertices[i].clone();
        else if (Math.abs(db) <= tolerance) point = vertices[j].clone();
        else if (da * db < 0) point = vertices[i].clone().lerp(vertices[j], da / (da - db));
        if (point && !crossings.some(existing => existing.distanceToSquared(point) <= tolerance * tolerance)) crossings.push(point);
      }
      if (crossings.length === 2 && crossings[0].distanceToSquared(crossings[1]) > tolerance * tolerance) {
        segments.push({a: crossings[0].applyMatrix4(child.matrixWorld), b: crossings[1].applyMatrix4(child.matrixWorld)});
      }
    };
    const tree = geometry.boundsTree as MeshBVH | undefined;
    if (tree) {
      tree.shapecast({
        intersectsBounds: box => localPlane.intersectsBox(box),
        intersectsTriangle: triangle => { addTriangle(triangle.a, triangle.b, triangle.c); },
      });
    } else {
      const indices = geometry.index;
      const triangleCount = (indices?.count ?? position.count) / 3;
      const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        for (let corner = 0; corner < 3; corner++) points[corner].fromBufferAttribute(position, indices?.getX(triangle * 3 + corner) ?? triangle * 3 + corner);
        addTriangle(points[0], points[1], points[2]);
      }
    }
  });
  return segments;
}

/** Reconstruct closed contour loops, including separate islands and holes. Open cuts stay unfilled. */
export function sectionCaps(segments: readonly SectionSegment[], origin: THREE.Vector3, normal: THREE.Vector3, axis: THREE.Vector3): THREE.BufferGeometry[] {
  if (!segments.length) return [];
  const points = segments.flatMap(({a, b}) => [a, b]);
  const span = new THREE.Box3().setFromPoints(points).getSize(new THREE.Vector3()).length();
  const tolerance = Math.max(span * 1e-5, 1e-7);
  const tangent = axis.clone().normalize(), vertical = normal.clone().normalize().cross(tangent).normalize();
  const nodes: {point: THREE.Vector3; planar: THREE.Vector2; edges: number[]}[] = [];
  const buckets = new Map<string, number[]>();
  const cell = (point: THREE.Vector3) => [Math.round(point.x / tolerance), Math.round(point.y / tolerance), Math.round(point.z / tolerance)];
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const nodeFor = (point: THREE.Vector3): number => {
    const [cx, cy, cz] = cell(point);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (let z = cz - 1; z <= cz + 1; z++)
      for (const candidate of buckets.get(key(x, y, z)) ?? [])
        if (nodes[candidate].point.distanceToSquared(point) <= tolerance * tolerance) return candidate;
    const index = nodes.length, relative = point.clone().sub(origin);
    nodes.push({point:point.clone(), planar:new THREE.Vector2(relative.dot(tangent), relative.dot(vertical)), edges:[]});
    const bucketKey = key(cx, cy, cz);
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey)!.push(index);
    return index;
  };
  const edges: [number, number][] = [], unique = new Set<string>();
  for (const {a, b} of segments) {
    const first = nodeFor(a), second = nodeFor(b);
    if (first === second) continue;
    const pair = first < second ? `${first}:${second}` : `${second}:${first}`;
    if (unique.has(pair)) continue;
    unique.add(pair);
    const index = edges.length; edges.push([first, second]);
    nodes[first].edges.push(index); nodes[second].edges.push(index);
  }
  const used = new Set<number>();
  const rings: THREE.Vector2[][] = [];
  for (let index = 0; index < edges.length; index++) {
    if (used.has(index)) continue;
    const [start, next] = edges[index];
    let current = next;
    const ring = [start, next]; used.add(index);
    while (current !== start && ring.length <= edges.length) {
      const candidates = nodes[current].edges.filter(edge => !used.has(edge));
      if (candidates.length !== 1) break;
      const edge = candidates[0], [a, b] = edges[edge];
      used.add(edge); current = a === current ? b : a; ring.push(current);
    }
    if (current === start && ring.length >= 4)
      rings.push(ring.slice(0, -1).map(node => nodes[node].planar.clone()));
  }
  const area = (ring: THREE.Vector2[]) => ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]; return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
  const inside = (point: THREE.Vector2, ring: THREE.Vector2[]) => {
    let contained = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) contained = !contained;
    }
    return contained;
  };
  const parents = rings.map((ring, i) => {
    let parent = -1, parentArea = Infinity;
    rings.forEach((candidate, j) => {
      const candidateArea = Math.abs(area(candidate));
      if (i !== j && candidateArea > Math.abs(area(ring)) && candidateArea < parentArea && inside(ring[0], candidate)) {
        parent = j; parentArea = candidateArea;
      }
    });
    return parent;
  });
  const depth = (index: number): number => parents[index] < 0 ? 0 : depth(parents[index]) + 1;
  const caps: THREE.BufferGeometry[] = [];
  rings.forEach((ring, index) => {
    if (depth(index) % 2) return;
    const shape = new THREE.Shape(ring);
    rings.forEach((hole, child) => { if (parents[child] === index && depth(child) % 2) shape.holes.push(new THREE.Path(hole)); });
    const geometry = new THREE.ShapeGeometry(shape);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let vertex = 0; vertex < position.count; vertex++) {
      const world = origin.clone().addScaledVector(tangent, position.getX(vertex)).addScaledVector(vertical, position.getY(vertex));
      position.setXYZ(vertex, world.x, world.y, world.z);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    caps.push(geometry);
  });
  return caps;
}
