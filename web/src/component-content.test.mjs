import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The API module uses constructor parameter properties, beyond Node's strip-only support.
function moduleUrl(file, imports = {}) {
  let js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
  }).outputText;
  for (const [name, url] of Object.entries(imports)) js = js.replaceAll(`'${name}'`, `'${url}'`);
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
}
const { htmlContent, validateComponentState } = await import(moduleUrl('./component-content.ts', {'./api.ts': moduleUrl('./api.ts')}));

test('plugin state uses the persisted UTF-8 byte limit', () => {
  assert.equal(validateComponentState('x'.repeat(65534)).length, 65534);
  assert.throws(() => validateComponentState('x'.repeat(65535)), /64 KiB/);
  assert.throws(() => validateComponentState({text: '中'.repeat(22000)}), /64 KiB/);
  assert.deepEqual(validateComponentState({text: '中'.repeat(20000)}), {text: '中'.repeat(20000)});
  assert.throws(() => validateComponentState(1n));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateComponentState(cyclic));
});

async function htmlFixture(t, statuses, frameFails = false) {
  const requests = [];
  class Element {
    children = [];
    classList = {add() {}};
    sandbox = new Set();
    append(child) {
      this.children.push(child);
      queueMicrotask(() => frameFails ? child.onerror?.() : child.onload?.());
    }
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({url, options});
    const status = statuses.shift();
    assert.ok(status, 'unexpected verification request');
    return new Response(null, {status, headers: {'content-type': status === 200 ? 'text/html; charset=utf-8' : 'application/json'}});
  });
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = {baseURI: 'http://localhost/blind/', createElement: () => new Element()};
  globalThis.window = {setTimeout};
  t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
  const content = htmlContent('api/v1/scenes/example/attachments/0', 'Report', {});
  t.after(() => content.dispose());
  return {content, requests};
}

test('HTML readiness rejects unavailable sources before frame navigation', async t => {
  const {content, requests} = await htmlFixture(t, [410]);
  await assert.rejects(content.ready, error => error.status === 410);
  assert.equal(content.element.children.length, 0);
  assert.equal(requests.length, 1);
});

test('HTML readiness rechecks source status after frame loading', async t => {
  const {content, requests} = await htmlFixture(t, [200, 503]);
  await assert.rejects(content.ready, error => error.status === 503);
  assert.equal(requests.length, 2);
});

test('HTML readiness preserves the sandboxed endpoint and resolves after verification', async t => {
  const {content, requests} = await htmlFixture(t, [200, 200]);
  await content.ready;
  assert.equal(content.element.children[0].src, 'http://localhost/blind/api/v1/scenes/example/attachments/0?embed=1');
  assert.deepEqual([...content.element.children[0].sandbox], ['allow-scripts']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({options}) => options.method === 'HEAD' && options.cache === 'no-store'));
});

test('HTML readiness rejects a frame navigation error', async t => {
  const {content} = await htmlFixture(t, [200], true);
  await assert.rejects(content.ready, /HTML 加载失败/);
});
