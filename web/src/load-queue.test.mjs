import assert from 'node:assert/strict';
import test from 'node:test';
import { LoadQueue } from './load-queue.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));

test('LoadQueue bounds separate admissions and starts queued work in order', async () => {
  const queue = new LoadQueue(4);
  const gates = Array.from({length: 7}, () => Promise.withResolvers());
  const started = [];
  let active = 0, peak = 0;
  const requests = gates.map((gate, index) => queue.enqueue(async () => {
    started.push(index); active++; peak = Math.max(peak, active);
    await gate.promise; active--; return index;
  }));
  await turn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve(); await turn();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[0].resolve(); await turn();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 4);
});

test('LoadQueue isolates failures and releases their slots', async () => {
  const queue = new LoadQueue(1);
  const failure = new Error('source unavailable');
  const failed = queue.enqueue(async () => { throw failure; });
  const recovered = queue.enqueue(async () => 42);
  await assert.rejects(failed, error => error === failure);
  assert.equal(await recovered, 42);
});

test('LoadQueue removes aborted waiting work without calling its loader', async () => {
  const queue = new LoadQueue(1), gate = Promise.withResolvers();
  const first = queue.enqueue(() => gate.promise);
  const controller = new AbortController(), reason = new Error('waiting cancelled');
  let called = false;
  const waiting = queue.enqueue(async () => { called = true; }, controller.signal);
  const rejected = assert.rejects(waiting, error => error === reason);
  controller.abort(reason); await rejected;
  const next = queue.enqueue(async () => 'next');
  gate.resolve(); await first;
  assert.equal(await next, 'next');
  assert.equal(called, false);
});

test('LoadQueue rejects running consumers immediately but retains the occupied slot', async () => {
  const queue = new LoadQueue(1), gate = Promise.withResolvers();
  const controller = new AbortController(), reason = new Error('runtime replaced');
  const running = queue.enqueue(() => gate.promise, controller.signal);
  const rejected = assert.rejects(running, error => error === reason);
  await turn(); controller.abort(reason); await rejected;
  let nextStarted = false;
  const next = queue.enqueue(async () => { nextStarted = true; return 7; });
  await turn(); assert.equal(nextStarted, false);
  gate.resolve(); assert.equal(await next, 7);
});

test('LoadQueue does not run already-aborted requests or requests aborted before their first turn', async () => {
  const queue = new LoadQueue(4), controller = new AbortController();
  const reason = new Error('disposed');
  let called = false;
  const pending = queue.enqueue(async () => { called = true; }, controller.signal);
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason); await rejected;
  await assert.rejects(queue.enqueue(async () => { called = true; }, controller.signal), error => error === reason);
  await turn(); assert.equal(called, false);
});

test('LoadQueue requires a finite positive integer boundary', () => {
  for (const concurrency of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new LoadQueue(concurrency), RangeError);
});
