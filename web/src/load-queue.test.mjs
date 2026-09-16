import assert from 'node:assert/strict';
import test from 'node:test';
import { mapConcurrent } from './load-queue.ts';

test('mapConcurrent bounds work and preserves input order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([5, 4, 3, 2, 1, 0], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [10, 8, 6, 4, 2, 0]);
  assert.equal(peak, 3);
});
