import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The API module uses constructor parameter properties, beyond Node's strip-only support.
function moduleUrl(file, imports = {}) {
  let js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext},
  }).outputText;
  js = js.replace(/^import ['"][^'"]+\.css['"];?\s*$/gm, '');
  for (const [name, url] of Object.entries(imports)) js = js.replaceAll(`'${name}'`, `'${url}'`);
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
}
const packageImports = Object.fromEntries(['dompurify', 'marked', 'mermaid', '@viz-js/viz', '@noble/hashes/sha2.js'].map(name => [name, import.meta.resolve(name)]));
const readingModule = moduleUrl('./content-reading.ts', packageImports);
const graphModule = moduleUrl('./graph.ts', {...packageImports,
  './dot-render.ts': new URL('./dot-render.ts', import.meta.url).href,
  './dot-work.ts': new URL('./dot-work.ts', import.meta.url).href,
});
const markdownModule = moduleUrl('./markdown.ts', {...packageImports, './graph.ts': graphModule});
const { htmlContent, jsonContent, validateComponentState } = await import(moduleUrl('./component-content.ts', {
  './api.ts': moduleUrl('./api.ts'), './content-reading': readingModule, './markdown': markdownModule, './graph': graphModule,
}));
const {contentState, DOMReading, validateContentState, updateContentState} = await import(readingModule);
const {ContentAnnotations} = await import(moduleUrl('./content-annotations.ts', {'./content-reading': readingModule}));

const nativeAnchor = {source:'sha256:revision', target:'line:0', offset:0, x:0, y:0};
function nativeMark(id, label = '复核') {
  return {id, label, color:'#ff6b5e', kind:'point', anchors:[{...nativeAnchor}]};
}

test('native state boundary preserves valid saved input and rejects malformed nested consumers', () => {
  const saved = {presentation:'focus', reading:{...nativeAnchor, viewport:[3,4]}, selection:false, zoom:2,
    expanded:['/items/150'], layer:'cluster', marks:[nativeMark('one')]};
  const spec = {state:JSON.parse(JSON.stringify(saved))};
  assert.deepEqual(contentState(spec), saved);
  assert.strictEqual(contentState(spec), spec.state, 'native consumers retain the same shared state object');
  for (const state of [
    [], 'opaque', {marks:{}}, {marks:[{}]}, {marks:[{...nativeMark('one'), anchors:null}]},
    {marks:[{...nativeMark('one'), color:'red'}]}, {marks:[{...nativeMark('one'), kind:'line'}]},
    {marks:[{...nativeMark('one'), anchors:[{...nativeAnchor, source:''}]}]},
    {reading:{...nativeAnchor, offset:-1}}, {reading:{...nativeAnchor, viewport:[0]}},
    {selection:'false'}, {zoom:0}, {expanded:[null]}, {presentation:'modal'},
  ]) {
    const input = {state};
    assert.throws(() => contentState(input), /原生内容状态/);
    assert.strictEqual(input.state, state, 'invalid input is not silently replaced');
  }
  assert.throws(() => validateContentState({expanded:['中'.repeat(22000)]}), /64 KiB/);
});

function nativeDOMFixture(t) {
  class Element extends EventTarget {
    constructor(tag = 'div') { super(); this.tagName = tag.toUpperCase(); }
    children = [];
    attributes = new Map();
    style = {};
    dataset = {};
    className = '';
    textContent = '';
    value = '';
    clientWidth = 300;
    clientHeight = 200;
    scrollLeft = 0;
    scrollTop = 0;
    offsetLeft = 0;
    offsetTop = 0;
    offsetHeight = 200;
    classList = {add() {}, remove() {}, toggle() {}, contains:() => false};
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    contains(node) { return this.children.includes(node); }
    getBoundingClientRect() {
      if (this.className === 'content-coordinate-probe') return {
        x:parseFloat(this.style.left) * this.parentElement.clientWidth / 100,
        y:parseFloat(this.style.top) * this.parentElement.clientHeight / 100,
      };
      return {x:0,y:0,width:this.clientWidth,height:this.clientHeight};
    }
    getClientRects() {
      for (let node = this; node.parentElement; node = node.parentElement) {
        const parent = node.parentElement;
        if (parent.tagName === 'DETAILS' && !parent.open && parent.children[0] !== node) return [];
      }
      return [this.getBoundingClientRect()];
    }
    focus() {}
  }
  const frames = new Map();
  let nextFrame = 0;
  const replacements = {
    document:{
      fonts:{ready:Promise.resolve()},
      createElement:tag => new Element(tag), createElementNS:(_ns, tag) => new Element(tag), getSelection:() => null,
      createTreeWalker:element => {
        const nodes = [];
        const visit = item => {
          if (item.textContent) nodes.push({data:item.textContent, length:item.textContent.length});
          for (const child of item.children) visit(child);
        };
        visit(element);
        let index = 0;
        return {nextNode:() => nodes[index++]};
      },
      createRange:() => {
        let node, offset;
        return {
          setStart(n, o) { node = n; offset = o; }, collapse() {},
          getClientRects:() => {
            const before = node.data.slice(0, offset);
            return [{x:(offset - before.lastIndexOf('\n') - 1) * 8,y:before.split('\n').length * 20 - 20,width:0,height:20}];
          },
        };
      },
    },
    ResizeObserver:class {observe() {} disconnect() {}},
    MutationObserver:class {observe() {} disconnect() {}},
    NodeFilter:{SHOW_TEXT:4},
    requestAnimationFrame:callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame:id => frames.delete(id),
    CustomEvent:class extends Event {constructor(type, options) {super(type, options);}},
    getComputedStyle:() => ({paddingTop:'0',paddingLeft:'0',lineHeight:'20px',getPropertyValue:() => '1'}),
  };
  const original = Object.fromEntries(Object.keys(replacements).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, replacements);
  const disposers = [];
  t.after(() => {
    try { while (disposers.length) disposers.pop()(); }
    finally { Object.assign(globalThis, original); }
  });
  const find = (element, predicate) => {
    if (predicate(element)) return element;
    for (const child of element.children) { const found = find(child, predicate); if (found) return found; }
  };
  return {Element, find, disposeWith:dispose => disposers.push(dispose), flushFrames() {
    const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0);
  }};
}

test('source line anchors never clamp or resolve beyond their selected line', t => {
  const {Element, disposeWith} = nativeDOMFixture(t);
  const scroll = new Element(), text = new Element(), node = {data:'a\nsecond\n', length:9};
  scroll.append(text);
  const spec = {state:{reading:{...nativeAnchor}}};
  const reading = new DOMReading(scroll, spec);
  disposeWith(() => reading.dispose());
  reading.installText(nativeAnchor.source, text, node);
  assert.ok(reading.locate({...nativeAnchor, offset:1}), 'the end of the first line is valid');
  assert.ok(reading.locate({...nativeAnchor, target:'line:1', offset:6}), 'the end of the second line is valid');
  const before = JSON.stringify(spec.state), top = scroll.scrollTop;
  for (const offset of [-1, .5, 2, 4, 100, NaN, Infinity]) {
    const invalid = {...nativeAnchor, offset};
    assert.equal(reading.locate(invalid), undefined);
    reading.restore(invalid);
    assert.equal(scroll.scrollTop, top);
    assert.equal(JSON.stringify(spec.state), before, 'invalid restoration preserves the last valid reading state');
  }
  assert.equal(reading.locate({...nativeAnchor, source:'sha256:other'}), undefined);
  assert.equal(reading.locate({...nativeAnchor, target:'line:99'}), undefined);
});

function annotationsFixture(t, state, nativeOverrides = {}) {
  const {Element, find, disposeWith} = nativeDOMFixture(t);
  const scroll = new Element(), body = new Element();
  body.append(scroll);
  let changes = 0;
  const native = {scroll, hit:() => ({...nativeAnchor}), locate:() => ({x:10,y:10}), restore() {}, setSelection() {}, ...nativeOverrides};
  const annotations = new ContentAnnotations(native, state, body, () => changes++);
  disposeWith(() => annotations.dispose());
  return {annotations, find, native, changes:() => changes};
}

test('saved marks restore lazy targets even when current geometry is absent, with adapter source checks', t => {
  const {Element, find, disposeWith} = nativeDOMFixture(t);
  const anchor = {...nativeAnchor, target:'/items/150'};
  const state = {reading:{...nativeAnchor, target:'/items/0'}, marks:[
    {...nativeMark('lazy'), anchors:[anchor]}, {...nativeMark('stale'), anchors:[{...anchor, source:'sha256:old'}]},
  ]};
  const scroll = new Element(), body = new Element(), root = new Element(), lazy = new Element();
  body.append(scroll); scroll.append(root);
  let materialized = false, resolutions = 0;
  const reading = new DOMReading(scroll, {state});
  reading.install(nativeAnchor.source, [{id:'/items/0', element:root, node:{data:'root',length:4}}], target => {
    if (target !== anchor.target) return;
    resolutions++;
    if (!materialized) { materialized = true; scroll.append(lazy); reading.add({id:target, element:lazy, node:{data:'150',length:3}}); }
  });
  const annotations = new ContentAnnotations(reading, state, body, () => {});
  disposeWith(() => { annotations.dispose(); reading.dispose(); });
  const buttons = find(annotations.tools, element => element.className === 'content-mark-list').children;
  assert.equal(buttons[0].dataset.locatable, 'false');
  buttons[0].onclick();
  assert.equal(materialized, true, 'the adapter gets a chance to reveal its lazy target');
  assert.deepEqual(state.reading, anchor);
  const attempts = resolutions;
  find(annotations.tools, element => element.className === 'content-mark-list').children[1].onclick();
  assert.equal(resolutions, attempts, 'another source revision is refused before materializing any target');
  assert.deepEqual(state.reading, anchor, 'another source revision never replaces the valid reading target');
});

test('native mark creation, edits and history reject oversized UTF-8 state without losing shareable marks', t => {
  const state = {marks:[]};
  const {annotations, find, changes} = annotationsFixture(t, state);
  const label = find(annotations.tools, element => element.getAttribute('aria-label') === '标注名称');
  const status = find(annotations.tools, element => element.getAttribute('role') === 'status');
  label.value = '中'.repeat(160);
  while (changes() < 200 && !status.textContent.includes('64 KiB')) { annotations.begin(10,10); annotations.end(); }
  assert.match(status.textContent, /64 KiB/);
  const saved = JSON.stringify(state), count = state.marks.length;
  assert.ok(count > 0 && count < 200);
  assert.ok(Buffer.byteLength(saved) <= 65536);
  assert.equal(changes(), count, 'a rejected mark neither publishes state nor enters history');
  find(annotations.tools, element => element.textContent === '撤销').onclick();
  assert.equal(state.marks.length, count - 1);
  find(annotations.tools, element => element.textContent === '重做').onclick();
  assert.equal(JSON.stringify(state), saved);
  find(annotations.tools, element => element.className === 'content-mark-list').children.at(-1).onclick();
  label.value = '中'.repeat(22000);
  label.dispatchEvent(new Event('change'));
  assert.match(status.textContent, /64 KiB/);
  assert.equal(JSON.stringify(state), saved, 'an oversized edit preserves the previous mark');
  find(annotations.tools, element => element.textContent === '撤销').onclick();
  const undone = JSON.stringify(state);
  state.expanded = ['x'.repeat(65536 - Buffer.byteLength(JSON.stringify({...state, expanded:['']})))];
  assert.doesNotThrow(() => validateContentState(state), 'the current state still fits before redo');
  find(annotations.tools, element => element.textContent === '重做').onclick();
  assert.match(status.textContent, /64 KiB/);
  assert.equal(JSON.stringify({...state, expanded:undefined}), undone, 'a rejected redo does not pop its history entry');
  delete state.expanded;
  find(annotations.tools, element => element.textContent === '重做').onclick();
  assert.equal(JSON.stringify(state), saved, 'redo remains available after the external state shrinks');
});

test('DOM reading restoration and scroll capture reject oversized source pointers before persistence or lazy resolution', t => {
  const {Element, find, flushFrames, disposeWith} = nativeDOMFixture(t);
  const scroll = new Element(), short = new Element(), long = new Element();
  scroll.append(short, long);
  const anchor = {...nativeAnchor, target:'json:/short'};
  const oversized = {...anchor, target:`json:/${'x'.repeat(65536)}`};
  const state = {reading:anchor};
  const reading = new DOMReading(scroll, {state});
  let resolutions = 0;
  reading.install(nativeAnchor.source, [
    {id:anchor.target, element:short, node:{data:'short',length:5}},
    {id:oversized.target, element:long, node:{data:'long',length:4}},
  ], () => { resolutions++; });
  disposeWith(() => reading.dispose());
  flushFrames();
  assert.ok(reading.locate(oversized), 'the oversized source pointer is a real locatable target');
  const saved = JSON.stringify(state), top = scroll.scrollTop, attempts = resolutions;
  reading.restore(oversized);
  assert.equal(resolutions, attempts, 'reject the reading budget before any lazy resolver can change expansion state');
  assert.equal(JSON.stringify(state), saved);
  assert.equal(scroll.scrollTop, top);
  assert.match(find(scroll, element => element.getAttribute('role') === 'status').textContent, /64 KiB/);
  scroll.dispatchEvent(new Event('scroll')); flushFrames();
  assert.equal(JSON.stringify(state), saved, 'ordinary scroll capture cannot persist an oversized pointer either');
  assert.doesNotThrow(() => validateContentState(state));
});

test('JSON disclosure and saved lazy-mark navigation budget the whole state and leave rejected disclosures closed', async t => {
  const {find, flushFrames, disposeWith} = nativeDOMFixture(t);
  const key = index => `${String(index).padStart(3,'0')}${'x'.repeat(997)}`;
  const arrayKey = `array${'x'.repeat(995)}`;
  const value = Object.fromEntries(Array.from({length:70}, (_, index) => [key(index), {}]));
  value[arrayKey] = Array.from({length:160}, (_, index) => index);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(value)));
  const spec = {};
  const content = jsonContent('/json', 'budget.json', spec);
  disposeWith(() => content.dispose());
  await content.ready; flushFrames();
  const state = contentState(spec);
  const root = find(content.element, element => element.className === 'json-node');
  const children = root.children.find(element => element.className === 'json-children');
  const branches = children.children.filter(element => element.className === 'json-node');
  const array = branches.at(-1);
  const lazy = {...nativeMark('lazy', 'Saved entry 150'), anchors:[{
    ...nativeAnchor, source:state.reading.source, target:`json:/${arrayKey}/150`,
  }]};
  state.marks = [lazy];
  assert.doesNotThrow(() => validateContentState(state));
  let rejected = 0, accepted = [];
  for (const details of branches.slice(0,-1)) {
    const before = JSON.stringify(state);
    details.open = true; details.dispatchEvent(new Event('toggle'));
    if (!details.open) {
      rejected++;
      assert.equal(JSON.stringify(state), before, 'a rejected expansion leaves the complete previous state unchanged');
      assert.match(find(content.element, element => element.getAttribute('role') === 'status' && !element.hidden).textContent, /64 KiB/);
      details.dispatchEvent(new Event('toggle'));
      assert.ok(find(content.element, element => element.getAttribute('role') === 'status' && !element.hidden), 'rollback notification must not hide the rejection');
    } else accepted.push(details);
    assert.doesNotThrow(() => validateContentState(state));
  }
  assert.ok(rejected > 0 && accepted.length > 0, 'normal disclosures reach and visibly enforce the persisted limit');
  assert.equal(array.open, false);
  assert.equal(content.native.locate(lazy.anchors[0]), undefined, 'entry 150 has not been materialized');
  const annotations = new ContentAnnotations(content.native, state, content.element, () => {});
  disposeWith(() => annotations.dispose());
  const saved = JSON.stringify(state), top = content.native.scroll.scrollTop;
  find(annotations.tools, element => element.className === 'content-mark-list').children[0].onclick();
  assert.equal(JSON.stringify(state), saved, 'a rejected saved-mark restore cannot partially persist expansion or reading');
  assert.equal(array.open, false);
  assert.equal(content.native.scroll.scrollTop, top);
  assert.equal(content.native.locate(lazy.anchors[0]), undefined);
  assert.match(find(content.element, element => element.getAttribute('role') === 'status' && !element.hidden).textContent, /64 KiB/);
  for (const details of accepted.slice(-5)) { details.open = false; details.dispatchEvent(new Event('toggle')); }
  find(annotations.tools, element => element.className === 'content-mark-list').children[0].onclick();
  assert.ok(content.native.locate(lazy.anchors[0]), 'after freeing budget, saved navigation reveals the paginated entry');
  assert.equal(array.open, true);
  assert.deepEqual(state.reading, lazy.anchors[0]);
  assert.doesNotThrow(() => validateContentState(state));
});

test('native view mutation guard preserves full states and reports presentation or selection growth', t => {
  const {Element, find} = nativeDOMFixture(t), element = new Element();
  const state = {presentation:'focus', expanded:['']};
  state.expanded[0] = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(state)));
  assert.doesNotThrow(() => validateContentState(state));
  const saved = JSON.stringify(state);
  for (const change of [{presentation:'fullscreen'}, {selection:true}, {layer:'cluster'}]) {
    assert.equal(updateContentState(state, change, element), false);
    assert.equal(JSON.stringify(state), saved);
    assert.match(find(element, item => item.getAttribute('role') === 'status').textContent, /64 KiB/);
  }
  state.expanded[0] = state.expanded[0].slice(100);
  assert.equal(updateContentState(state, {presentation:'fullscreen', selection:true}, element), true);
  assert.equal(state.presentation, 'fullscreen');
  assert.equal(state.selection, true);
  assert.equal(find(element, item => item.getAttribute('role') === 'status').hidden, true);
  assert.doesNotThrow(() => validateContentState(state));
});

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
  const {content} = await htmlFixture(t, [410]);
  await assert.rejects(content.ready, error => error.status === 410);
  assert.equal(content.element.children.length, 0);
});

test('HTML readiness rechecks source status after frame loading', async t => {
  const {content} = await htmlFixture(t, [200, 503]);
  await assert.rejects(content.ready, error => error.status === 503);
});

test('HTML readiness preserves the sandboxed endpoint and resolves after verification', async t => {
  const {content, requests} = await htmlFixture(t, [200, 200]);
  await content.ready;
  assert.equal(content.element.children[0].src, 'http://localhost/blind/api/v1/scenes/example/attachments/0?embed=1');
  assert.deepEqual([...content.element.children[0].sandbox], ['allow-scripts']);
  assert.ok(requests.every(({options}) => options.method === 'HEAD' && options.cache === 'no-store'));
});

test('HTML readiness rejects a frame navigation error', async t => {
  const {content} = await htmlFixture(t, [200], true);
  await assert.rejects(content.ready, /HTML 加载失败/);
});
