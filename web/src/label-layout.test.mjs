import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutLabel } from './label-layout.ts';

const silhouette = { x: 300, y: 250, width: 400, height: 300 };
const input = { width: 1000, height: 800, labelWidth: 120, labelHeight: 30, x: 499.99, y: 400, silhouette, silhouettes: [silhouette], occupied: [] };

test('small rotations across the screen center keep the label on its original side', () => {
  const first = layoutLabel(input);
  assert.ok(first.rect.x < input.x);
  let last = first.rect;
  for (const x of [500.01, 499.98, 500.02, 499.99]) {
    const next = layoutLabel({ ...input, x }, first.offset);
    assert.ok(Math.abs(next.rect.x - last.x) < 1, `small rotation jumped from ${last.x} to ${next.rect.x}`);
    assert.ok(next.rect.x < x, 'label switched sides');
    last = next.rect;
  }
});

test('initial placement avoids occupied space; retained placement follows its anchor and clamps to the viewport', () => {
  const first = layoutLabel({ ...input, occupied: [{ x: 0, y: 0, width: 300, height: 800 }] });
  assert.ok(first.rect.x > input.x, 'initial layout must use the available right side');
  const moved = layoutLabel({ ...input, x: 549.99, y: 440 }, first.offset);
  assert.equal(moved.rect.x - first.rect.x, 50);
  assert.equal(moved.rect.y - first.rect.y, 40);
  const edge = layoutLabel({ ...input, x: 990 }, first.offset);
  assert.ok(edge.rect.x + edge.rect.width <= input.width - 8);
  const restored = layoutLabel(input, first.offset);
  assert.deepEqual(restored.rect, first.rect);
});
