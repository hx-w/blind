import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { intersectSection, sectionCaps } from './section-geometry.ts';

test('a section intersects only the supplied mesh and retains the complete contour', () => {
  const selected = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const other = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  other.position.set(12, 0, 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const segments = intersectSection(selected, plane);
  assert.ok(segments.length >= 8);
  for (const {a, b} of segments) for (const point of [a, b]) {
    assert.ok(Math.abs(point.y) < 1e-7);
    assert.ok(Math.abs(point.x) <= 1 + 1e-7 && Math.abs(point.z) <= 1 + 1e-7);
  }
  assert.ok(intersectSection(other, plane).every(({a}) => a.x > 10));
  selected.geometry.dispose(); other.geometry.dispose();
});

test('a closed contour produces a filled plane with the expected area', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const origin = new THREE.Vector3(), normal = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(1, 0, 0);
  const caps = sectionCaps(intersectSection(mesh, new THREE.Plane(normal, 0)), origin, normal, axis);
  assert.equal(caps.length, 1);
  const geometry = caps[0], position = geometry.getAttribute('position');
  let area = 0;
  const index = geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    a.fromBufferAttribute(position, index?.getX(i) ?? i);
    b.fromBufferAttribute(position, index?.getX(i+1) ?? i+1);
    c.fromBufferAttribute(position, index?.getX(i+2) ?? i+2);
    area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  assert.ok(Math.abs(area - 4) < 1e-5, `cap area ${area}`);
  caps.forEach(cap => cap.dispose()); mesh.geometry.dispose();
});
