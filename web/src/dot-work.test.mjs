import assert from 'node:assert/strict';
import test from 'node:test';
import {instance} from '@viz-js/viz';
import {checkDotWork} from './dot-work.ts';
import {renderDot} from './dot-render.ts';

const set = (prefix, count) => Array.from({length: count}, (_, index) => `${prefix}${index}`).join(' ');

test('DOT preflight retains Graphviz syntax, labels, clusters, ports and undirected edges', async () => {
  const viz = await instance();
  for (const source of [
    'digraph { a -> b }',
    'graph { a -- b -- c }',
    'strict digraph { subgraph cluster_outer { a; subgraph cluster_inner { b } } a -> b }',
    'digraph "quoted graph" { "a -> b" [label="{not nodes} ->"]; "a -> b" -> "quoted node" }',
    'digraph { a [label=<<TABLE><TR><TD PORT="port">it\'s &gt; text</TD></TR></TABLE>>]; a:port:e -> b }',
    'digraph { // a -> z\n a /* -> ignored */ -> b; label="hello" + " world" }',
    'digraph { "la" + "bel" = "graph"; a -> {b c} -> d }',
    'digraph { a,b -> c,d -> e,f }',
    'graph { graph [rankdir=LR]; node [shape=box]; edge [color=red]; -1.5 -- .5 }',
  ]) {
    const preflight = checkDotWork(source);
    const rendered = viz.renderJSON(source);
    const actualNodes = rendered.objects.length - rendered._subgraph_cnt;
    assert.ok(preflight.nodes >= actualNodes, `node work must bound Viz's ${actualNodes} nodes: ${source}`);
    assert.ok(preflight.edges >= (rendered.edges?.length ?? 0), `edge work must bound Viz's expanded edges: ${source}`);
  }
});

test('compact DOT Cartesian expansion is bounded before the Graphviz consumer', () => {
  assert.deepEqual(checkDotWork(`digraph { {${set('a',100)}} -> {${set('b',100)}} }`), {nodes:200,edges:10000});
  assert.throws(() => checkDotWork(`digraph { {${set('a',101)}} -> {${set('b',100)}} }`), /10000/);
  assert.throws(() => checkDotWork(`digraph { ${set('a',101).replaceAll(' ', ',')} -> ${set('b',100).replaceAll(' ', ',')} }`), /10000/);
  assert.throws(() => checkDotWork(`digraph { ${set('n',1001)} }`), /1000/);
  assert.throws(() => checkDotWork(`strict digraph { ${'a -> b;'.repeat(10001)} }`), /10000/);
  assert.deepEqual(checkDotWork('digraph { a -> {b c} -> {d e} }'), {nodes:5,edges:6});
  assert.throws(() => checkDotWork(`digraph { subgraph outer {subgraph inner {a0}} subgraph inner {${set('a',101)}} subgraph outer {} -> {${set('b',100)}} }`), /10000/);
});

test('subgraph IDs conservatively bound the installed Viz consumer across quoting forms', async () => {
  const viz = await instance();
  for (const [declared, reopened, endpoint] of [
    ['"s"', 's', '"s"'],
    ['"s" + "uffix"', 'suffix', '"su" + "ffix"'],
    [String.raw`"a\"b"`, String.raw`"a" + "\"b"`, String.raw`"a\"b"`],
    ['"s\\\nuffix"', 'suffix', '"suffix"'],
    ['<suffix>', 'suffix', '"suffix"'],
    ['<s> + "uffix"', 'suffix', '"su" + <ffix>'],
    ['""', '""', '""'],
    [String.raw`"a\\b"`, String.raw`"a" + "\\b"`, String.raw`"a\\b"`],
  ]) {
    // Small real layouts verify that canonicalization never undercounts Viz.
    // Conservatively merging distinct forms is allowed by the work boundary.
    const small = `digraph {subgraph ${declared} {a0 a1} subgraph ${reopened} {a2} subgraph ${endpoint} {} -> {b0 b1}}`;
    const rendered = viz.renderJSON(small), work = checkDotWork(small);
    assert.ok(work.edges >= rendered.edges.length, small);
    assert.ok(work.nodes >= rendered.objects.length - rendered._subgraph_cnt, small);
    const expanded = `digraph {subgraph ${declared} {${set('a',100)}} subgraph ${reopened} {a100} subgraph ${endpoint} {} -> {${set('b',100)}}}`;
    assert.throws(() => checkDotWork(expanded), /10000/, expanded);
  }
});

test('DOT queue disposes workers on success, cancellation, failures and deadline; limits queued input', async t => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  class ControlledWorker {
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(source) { this.source = source; }
    terminate() { this.terminated = true; }
    respond(data) { this.onmessage({data}); }
  }
  globalThis.Worker = ControlledWorker;
  t.mock.timers.enable({apis:['setTimeout']});
  try {
    const activeAbort = new AbortController();
    const waitingAbort = new AbortController();
    const active = renderDot('digraph {a}', activeAbort.signal);
    const waiting = renderDot('digraph {b}', waitingAbort.signal);
    const activeRejected = assert.rejects(active, {name:'AbortError'});
    const waitingRejected = assert.rejects(waiting, {name:'AbortError'});
    waitingAbort.abort();
    assert.equal(workers.length, 1, 'cancelled queued sources never start a worker');
    activeAbort.abort();
    await Promise.all([activeRejected, waitingRejected]);
    assert.ok(workers[0].terminated);

    const success = renderDot('digraph {a}');
    workers.at(-1).respond({svg:'<svg />'});
    await success;
    assert.ok(workers.at(-1).terminated);

    const failed = renderDot('invalid');
    const failure = assert.rejects(failed, /parse failed/);
    workers.at(-1).respond({error:'parse failed'});
    await failure;
    assert.ok(workers.at(-1).terminated);

    const crashed = renderDot('digraph {a}');
    const crash = assert.rejects(crashed, /线程失败/);
    workers.at(-1).onerror({preventDefault() {}});
    await crash;
    assert.ok(workers.at(-1).terminated);

    const malformed = renderDot('digraph {a}');
    const invalidResult = assert.rejects(malformed, /无效或过大/);
    workers.at(-1).respond({svg:'x'.repeat(8 * 1024 * 1024 + 1)});
    await invalidResult;
    assert.ok(workers.at(-1).terminated);

    const timedOut = renderDot('digraph {a}');
    const timeout = assert.rejects(timedOut, /20 秒/);
    t.mock.timers.tick(20000);
    await timeout;
    assert.ok(workers.at(-1).terminated);

    const abort = new AbortController();
    const batch = Array.from({length:9}, () => renderDot('digraph {a}', abort.signal));
    const rejected = batch.map(promise => assert.rejects(promise, {name:'AbortError'}));
    await assert.rejects(renderDot('digraph {a}'), /队列已满/);
    assert.equal(workers.filter(worker => !worker.terminated).length, 1);
    abort.abort();
    await Promise.all(rejected);
    assert.equal(workers.filter(worker => !worker.terminated).length, 0);
  } finally {
    globalThis.Worker = originalWorker;
    t.mock.timers.reset();
  }
});
