import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const dist = new URL('../dist/', import.meta.url);
const html = (await readFile(new URL('index.html', dist), 'utf8')).replace('<head>', '<head><base href="/">');
const geometry = await readFile(new URL('../../tests/fixtures/tetra.ply', import.meta.url));
const source = Array.from({length: 600}, (_, index) => `source line ${index + 1}: immutable source reading and board framing are independent.`).join('\n');
const notes = '# Review notes\n\nA fixed panel stays in screen space.\n\n' + Array.from({length: 80}, (_, index) => `- Review item ${index + 1}`).join('\n');
const state = {
  selected: 0, viewport: {mode: 'auto'}, shading: 'flat', render_mode: 'matte',
  light: {azimuth: 45, elevation: 20, intensity: 1}, projection: 'perspective',
  background: 'dark', axes: false, frame: {width: 1200, height: 800}, camera: null,
  strokes: [], annotations: [], section: null,
};
const board = {
  title: 'Public board operation regression', owner: false, meshes: [], label_groups: [],
  state: {...structuredClone(state), viewport: {mode: 'auto', board: {center: [70, 0], scale: 4}}},
  entities: [
    {id: 'document', component: 'text', source: {kind: 'attachment', index: 0}, placement: 'world', label: 'Reading source', group: null, position: [0, 0, 0], size: [110, 70], visible: true, opacity: 1},
    {id: 'notes', component: 'markdown', source: {kind: 'attachment', index: 1}, placement: 'world', label: 'Review notes', group: null, position: [150, 0, 0], size: [110, 70], visible: true, opacity: 1},
  ],
  attachments: [
    {id: 'source-text', label: 'Reading source', byte_size: Buffer.byteLength(source), url: '/source/document', unavailable: null},
    {id: 'source-notes', label: 'Review notes', byte_size: Buffer.byteLength(notes), url: '/source/notes', unavailable: null},
  ],
};
const spatial = {
  title: 'Public spatial operation regression', owner: false, label_groups: [{text: 'Reference group', meshes: [0]}],
  meshes: [{name: 'Reference geometry', format: 'ply', revision: 'fixture', byte_size: geometry.length, color: '#ffc857', opacity: 1, visible: true, quality: 'raw', source_url: '/mesh/reference'}],
  entities: [{id: 'geometry', component: 'mesh', source: {kind: 'mesh', index: 0}, placement: 'world', label: 'Reference geometry', group: null, position: [0, 0, 0], size: null, visible: true, opacity: 1}],
  state: {...structuredClone(state), camera: {position: [3, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 34, zoom: 1, orthographic_height: 2}},
};
const spatialDocument = {
  ...structuredClone(board), title: 'Spatial document placement regression',
  state: {...structuredClone(state), viewport: {mode: 'spatial'},
    camera: {position: [0, 0, 2400], target: [0, 0, 0], up: [0, 1, 0], fov: 34, zoom: 1, orthographic_height: 1600}},
  entities: board.entities.map(entity => ({...structuredClone(entity),
    ...(entity.id === 'document' ? {size: [1600, 1000]} : {placement: 'panel'})})),
};
const demand = {
  ...structuredClone(spatial), title: 'Demand-driven geometry',
  meshes: Array.from({length: 6}, (_, index) => ({...structuredClone(spatial.meshes[0]),
    name: `Geometry ${index}`, visible: index === 0 || index === 5, opacity: index === 5 ? 0 : 1, source_url: `/mesh/demand/${index}`})),
  entities: [
    ...Array.from({length: 6}, (_, index) => ({...structuredClone(spatial.entities[0]),
      id: `geometry-${index}`, label: `Geometry ${index}`, source: {kind: 'mesh', index}, visible: index === 0 || index === 5, opacity: index === 5 ? 0 : 1})),
    {...structuredClone(board.entities[1]), id: 'notes', source: {kind: 'attachment', index: 0}, placement: 'panel'},
  ],
  attachments: [{...structuredClone(board.attachments[1]), url: '/source/notes'}],
};
const scenes = new Map([['board', board], ['spatial', spatial], ['spatial-document', spatialDocument], ['demand', demand]]);
const sourceRequests = [];
const geometryRequests = [];
const geometryGates = new Map();
const geometryFailures = new Set();
let activeGeometry = 0, peakGeometry = 0;
let requestedGeometry;
let browser, server, origin, shareSequence = 0;

before(async () => {
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const scenePath = path.match(/^\/api\/v1\/scenes\/([^/]+)(\/share)?$/);
      if (scenePath) {
        const original = scenes.get(scenePath[1]);
        if (!original) {response.writeHead(404); response.end(); return;}
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'POST' && scenePath[2]) {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const update = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const saved = structuredClone(original);
          saved.state = update.state;
          saved.meshes.forEach((mesh, index) => Object.assign(mesh, update.meshes[index]));
          for (const entity of saved.entities) {
            const next = update.entities.find(candidate => candidate.id === entity.id);
            if (next) Object.assign(entity, next);
          }
          const token = `shared-${++shareSequence}`; scenes.set(token, saved);
          response.end(JSON.stringify({viewer_url: `${origin}/s/${token}`, image_url: `${origin}/i/${token}.png`, origin, hosts: []}));
        } else if (request.method === 'GET' && !scenePath[2]) response.end(JSON.stringify(original));
        else {response.statusCode = 405; response.end();}
      } else if (path.startsWith('/source/')) {
        sourceRequests.push({path, method: request.method});
        if (request.method !== 'GET') {response.writeHead(405); response.end(); return;}
        response.setHeader('Content-Type', path.endsWith('/notes') ? 'text/markdown' : 'text/plain');
        response.end(path.endsWith('/notes') ? notes : source);
      } else if (path.startsWith('/mesh/demand/')) {
        geometryRequests.push(path);
        activeGeometry++; peakGeometry = Math.max(peakGeometry, activeGeometry);
        requestedGeometry?.(path);
        await geometryGates.get(path)?.promise;
        if (geometryFailures.has(path)) {
          response.writeHead(503, {'Content-Type': 'application/json'});
          response.end(JSON.stringify({error: 'Geometry source unavailable'}));
        } else {
          response.setHeader('Content-Type', 'application/ply'); response.end(geometry);
        }
        activeGeometry--;
      } else if (path === '/mesh/reference') {
        response.setHeader('Content-Type', 'application/ply'); response.end(geometry);
      } else if (path.startsWith('/assets/') && !path.includes('..')) {
        response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/javascript');
        response.end(await readFile(new URL(path.slice(1), dist)));
      } else {response.setHeader('Content-Type', 'text/html'); response.end(html);}
    } catch (error) {response.statusCode = 500; response.end(String(error));}
  });
  const listening = Promise.withResolvers();
  server.listen(0, '127.0.0.1', listening.resolve); server.once('error', listening.reject);
  await listening.promise; server.off('error', listening.reject);
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless: true, executablePath: process.env.BLIND_TEST_CHROMIUM || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
});
after(async () => {
  await browser?.close();
  if (server?.listening) {
    const closed = Promise.withResolvers(); server.close(error => error ? closed.reject(error) : closed.resolve()); await closed.promise;
  }
});

async function openScene(token) {
  const page = await browser.newPage({viewport: {width: 1200, height: 800}, deviceScaleFactor: 1, reducedMotion: 'no-preference'});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.operationEvents = []; window.gpuContexts = [];
    window.abortedGeometry = [];
    const originalFetch = window.fetch;
    window.fetch = function(input, options) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/mesh/demand/')) options?.signal?.addEventListener('abort', () => window.abortedGeometry.push(url), {once: true});
      return originalFetch.call(this, input, options);
    };
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl' || type === 'webgpu') window.gpuContexts.push(type);
      return original.call(this, type, ...args);
    };
  });
  await page.goto(`${origin}/s/${token}`);
  await page.locator('#loading-state').waitFor({state: 'hidden'});
  assert.equal(await page.locator('#invalid-state').isVisible(), false);
  await page.waitForFunction(() => window.blind?.catalog().some(operation => operation.name === 'view:get' && operation.available));
  await page.evaluate(() => {window.blind.subscribe(event => window.operationEvents.push(event));});
  if (scenes.get(token).entities.some(entity => entity.id === 'document')) {
    await page.evaluate(async () => {
      const completion = Promise.withResolvers();
      const unsubscribe = window.blind.subscribe(event => {if (event.domain === 'content') void check();});
      const timeout = setTimeout(() => completion.reject(new Error('Native document did not settle')), 30000);
      async function check() {
        const result = await window.blind.execute('content:get', {id: 'document'});
        if (!result.ok) completion.reject(new Error(JSON.stringify(result.error)));
        else if (result.value.unavailable) completion.reject(new Error(result.value.unavailable));
        else if (result.value.ready) completion.resolve();
      }
      try {await check(); await completion.promise;}
      finally {clearTimeout(timeout); unsubscribe();}
    });
  }
  await rendered(page);
  return {page, errors};
}
async function operation(page, name, params = {}) {
  const result = await page.evaluate(({name, params}) => window.blind.execute(name, params), {name, params});
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value;
}
async function failure(page, name, params, code) {
  const result = await page.evaluate(({name, params}) => window.blind.execute(name, params), {name, params});
  assert.equal(result.ok, false); assert.equal(result.error.code, code);
  return result.error;
}
async function rendered(page) {
  await page.evaluate(() => {
    const completion = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(completion.resolve)); return completion.promise;
  });
}
function approximately(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function sameCamera(actual, expected) {
  for (const key of ['position', 'target', 'up']) for (let index = 0; index < 3; index++) approximately(actual[key][index], expected[key][index]);
  for (const key of ['fov', 'zoom', 'orthographic_height']) approximately(actual[key], expected[key]);
}
const documentSurface = '.scene-surface:has(.component-handle[title="Reading source"])';
const notesSurface = '.scene-surface:has(.component-handle[title="Review notes"])';

test('board discovery and structured validation never initialize a GPU or partially apply scene:show', async () => {
  const {page, errors} = await openScene('board');
  try {
    const catalog = await page.evaluate(() => window.blind.catalog());
    for (const name of ['entity:list', 'scene:show', 'view:get', 'view:pan', 'content:get', 'annotation:create-screen', 'share:create']) {
      const descriptor = catalog.find(operation => operation.name === name);
      assert.ok(descriptor, name); assert.ok(descriptor.inputSchema); assert.ok(descriptor.outputSchema); assert.equal(descriptor.available, true);
    }
    assert.equal(catalog.find(operation => operation.name === 'view:get').readOnly, true);
    for (const name of ['view:rotate', 'view:canonical', 'annotation:pick', 'section:get']) assert.equal(catalog.find(operation => operation.name === name).available, false);
    const initialView = await operation(page, 'view:get'); assert.equal(initialView.kind, 'board');
    await failure(page, 'not-an-operation', {}, 'UNKNOWN_OPERATION');
    await failure(page, 'view:zoom', {factor: 0}, 'INVALID_ARGUMENT');
    await failure(page, 'view:get', {unexpected: true}, 'INVALID_ARGUMENT');
    await failure(page, 'view:rotate', {axis: [0, 1, 0], angle: 1}, 'UNSUPPORTED');
    await failure(page, 'view:settings', {background: 'light', axes: true}, 'UNSUPPORTED');
    assert.deepEqual(await operation(page, 'view:get'), initialView, 'unsupported settings cannot partially apply background or framing');
    const before = await operation(page, 'scene:snapshot');
    await page.evaluate(() => {window.operationEvents = [];});
    await failure(page, 'scene:show', {ids: ['document', 'missing'], opacity: .25, fit: true}, 'UNKNOWN_ENTITY');
    await failure(page, 'scene:show', {ids: ['document', 'document'], opacity: .25, fit: true}, 'INVALID_ARGUMENT');
    assert.deepEqual(await operation(page, 'scene:snapshot'), before);
    assert.equal(await page.evaluate(() => window.operationEvents.some(event => event.domain === 'entity')), false);
    const shown = await operation(page, 'scene:show', {ids: ['document'], opacity: .5, fit: false});
    assert.equal(shown.find(entity => entity.id === 'document').opacity, .5);
    assert.equal(shown.find(entity => entity.id === 'notes').visible, false);
    const events = await page.evaluate(() => window.operationEvents.filter(event => event.domain === 'entity'));
    assert.equal(events.length, 1, 'an atomic scene transition publishes one committed entity event');
    assert.equal(events[0].data.entities.find(entity => entity.id === 'document').opacity, .5);
    assert.equal(events[0].data.entities.find(entity => entity.id === 'notes').visible, false);
    await operation(page, 'entity:set-style', {id: 'document', opacity: 0});
    const camera = (await operation(page, 'view:get')).camera;
    const emptyFit = await operation(page, 'view:fit', {animate: false});
    assert.equal(emptyFit.status, 'committed'); assert.deepEqual(emptyFit.view.camera, camera);
    assert.deepEqual(await page.evaluate(() => window.gpuContexts), []);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('pinned DOM stays fixed while board API, title drag and pointer zoom move only world framing', async () => {
  const {page, errors} = await openScene('board');
  try {
    await page.evaluate(selector => {
      window.originalNotes = document.querySelector(`${selector} .component-content`);
    }, notesSurface);
    await operation(page, 'entity:set-placement', {id: 'notes', placement: 'panel'});
    await operation(page, 'view:set', {kind: 'board', center: [0, 0], scale: 4});
    await rendered(page);
    assert.equal(await page.evaluate(() => window.originalNotes.isConnected && !!window.originalNotes.closest('.component-fixed-panels')), true);
    await operation(page, 'ui:scene-list', {open: true});
    const fixedPanel = await page.locator('.component-fixed-panels').boundingBox();
    for (const selector of ['.scene-panels', '.topbar']) if (await page.locator(selector).isVisible()) {
      const chrome = await page.locator(selector).boundingBox();
      assert.ok(chrome.x + chrome.width <= fixedPanel.x + .1, `${selector} must not occlude fixed panel controls`);
    }
    await operation(page, 'ui:scene-list', {open: false});
    const world = await page.locator(documentSurface).boundingBox();
    const panel = await page.locator(notesSurface).boundingBox();
    const layout = await page.locator(`${documentSurface} .component-content`).evaluate(element => ({width: element.offsetWidth, height: element.offsetHeight}));
    await operation(page, 'view:pan', {delta: [90, 35]}); await rendered(page);
    const moved = await page.locator(documentSurface).boundingBox();
    const pinned = await page.locator(notesSurface).boundingBox();
    approximately(moved.x - world.x, 90, .1); approximately(moved.y - world.y, 35, .1);
    approximately(pinned.x, panel.x, .1); approximately(pinned.y, panel.y, .1);
    const beforeDrag = await operation(page, 'view:get');
    const title = page.locator(`${documentSurface} .component-handle`);
    const handle = await title.boundingBox();
    await page.mouse.move(handle.x + handle.width * .2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width * .2 + 60, handle.y + handle.height / 2 + 20, {steps: 6}); await page.mouse.up();
    const afterDrag = await operation(page, 'view:get');
    approximately(afterDrag.camera.center[0], beforeDrag.camera.center[0] - 60 / beforeDrag.camera.scale);
    approximately(afterDrag.camera.center[1], beforeDrag.camera.center[1] + 20 / beforeDrag.camera.scale);
    await rendered(page);
    const sourceBeforeZoom = await page.locator(documentSurface).boundingBox();
    const beforeZoom = await title.boundingBox();
    await page.mouse.move(beforeZoom.x + beforeZoom.width * .2, beforeZoom.y + beforeZoom.height / 2); await page.mouse.wheel(0, -100);
    await rendered(page);
    const zoomed = await page.locator(documentSurface).boundingBox();
    const zoomCamera = await operation(page, 'view:get');
    assert.ok(zoomCamera.camera.scale > afterDrag.camera.scale, 'title wheel changes the actual board scale');
    const factor = zoomCamera.camera.scale / afterDrag.camera.scale;
    const anchor = {x: beforeZoom.x + beforeZoom.width * .2, y: beforeZoom.y + beforeZoom.height / 2};
    approximately(zoomed.x + (anchor.x - sourceBeforeZoom.x) * factor, anchor.x, .2);
    approximately(zoomed.y + (anchor.y - sourceBeforeZoom.y) * factor, anchor.y, .2);
    assert.deepEqual(await page.locator(`${documentSurface} .component-content`).evaluate(element => ({width: element.offsetWidth, height: element.offsetHeight})), layout, 'viewport zoom does not reflow native source dimensions');
    const afterZoomPanel = await page.locator(notesSurface).boundingBox();
    approximately(afterZoomPanel.x, panel.x, .1); approximately(afterZoomPanel.y, panel.y, .1);
    assert.equal(await page.evaluate(() => window.originalNotes.isConnected), true);
    await operation(page, 'entity:set-placement', {id: 'notes', placement: 'world'}); await rendered(page);
    assert.equal(await page.evaluate(() => window.originalNotes.isConnected && !window.originalNotes.closest('.component-fixed-panels')), true);
    assert.deepEqual(await page.evaluate(() => window.gpuContexts), []);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('sidebar edge resizing reserves real viewport space without resizing sources or navigating the camera', async () => {
  const {page, errors} = await openScene('board');
  try {
    await operation(page, 'entity:set-placement', {id: 'notes', placement: 'panel'});
    await operation(page, 'ui:scene-list', {open: true});
    const camera = (await operation(page, 'view:get')).camera;
    const entity = await operation(page, 'entity:get', {id: 'document'});
    const world = await page.locator(documentSurface).boundingBox();
    const sourceLayout = await page.locator(`${documentSurface} .component-content`).evaluate(element => ({width: element.offsetWidth, height: element.offsetHeight}));
    const edge = page.getByRole('separator', {name: '调整固定面板宽度'});
    const panel = page.locator('.component-fixed-panels');
    const initial = await panel.boundingBox(), handle = await edge.boundingBox();
    await edge.evaluate(element => element.addEventListener('pointerdown', event => {window.resizePointer = event.pointerId;}, {once: true}));
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    assert.equal(await edge.evaluate(element => element.hasPointerCapture(window.resizePointer)), true);
    await page.mouse.move(handle.x + handle.width / 2 - 140, handle.y + handle.height / 2, {steps: 6}); await page.mouse.up();
    await rendered(page);
    approximately((await panel.boundingBox()).width, initial.width + 140, 1);
    await edge.press('ArrowLeft');
    await edge.press('Shift+ArrowRight');
    await rendered(page);
    approximately((await panel.boundingBox()).width, initial.width + 110, 1);
    approximately(Number(await edge.getAttribute('aria-valuenow')), (await panel.boundingBox()).width, 1);
    const touchEdge = await edge.boundingBox();
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: touchEdge.x + touchEdge.width / 2, y: 300}]});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: touchEdge.x + touchEdge.width / 2 - 80, y: 300}]});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []}); await touch.detach();
    await rendered(page);
    const resized = await panel.boundingBox();
    approximately(resized.width, initial.width + 190, 1);
    const movedWorld = await page.locator(documentSurface).boundingBox();
    approximately(movedWorld.width, world.width, .1);
    approximately(movedWorld.x - world.x, -(resized.width - initial.width) / 2, .1);
    assert.deepEqual((await operation(page, 'view:get')).camera, camera);
    assert.deepEqual(await operation(page, 'entity:get', {id: 'document'}), entity);
    assert.deepEqual(await page.locator(`${documentSurface} .component-content`).evaluate(element => ({width: element.offsetWidth, height: element.offsetHeight})), sourceLayout);
    for (const selector of ['.scene-panels', '.topbar']) if (await page.locator(selector).isVisible()) {
      const chrome = await page.locator(selector).boundingBox();
      assert.ok(chrome.x + chrome.width <= resized.x + .1, `${selector} remains outside the resized sidebar`);
    }
    const beforeReading = (await operation(page, 'content:get', {id: 'notes'})).state.reading;
    const body = await page.locator(`${notesSurface} .component-content`).boundingBox();
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2); await page.mouse.wheel(0, 240);
    await rendered(page);
    assert.notEqual((await operation(page, 'content:get', {id: 'notes'})).state.reading.target, beforeReading.target, 'the resized panel still reads native source content');
    assert.deepEqual((await operation(page, 'view:get')).camera, camera);
    await operation(page, 'entity:set-style', {id: 'notes', visible: false});
    assert.equal(await edge.isVisible(), false);
    await operation(page, 'entity:set-style', {id: 'notes', visible: true}); await rendered(page);
    approximately((await panel.boundingBox()).width, resized.width, .1);
    await operation(page, 'content:present', {id: 'notes', presentation: 'fullscreen'});
    await page.setViewportSize({width: 700, height: 800});
    await operation(page, 'content:present', {id: 'notes', presentation: 'spatial'});
    await rendered(page);
    assert.ok((await panel.boundingBox()).width <= 380, 'expanded content returns to the safely clamped sidebar');
    await page.setViewportSize({width: 1200, height: 800}); await rendered(page);
    approximately((await panel.boundingBox()).width, resized.width, .1);
    await edge.press('Home'); await rendered(page);
    approximately((await panel.boundingBox()).width, Number(await edge.getAttribute('aria-valuemin')), 1);
    await edge.press('End'); await rendered(page);
    approximately((await panel.boundingBox()).width, Number(await edge.getAttribute('aria-valuemax')), 1);
    await page.setViewportSize({width: 700, height: 800}); await rendered(page);
    const narrowPanel = await panel.boundingBox(), root = await page.locator('#canvas-root').boundingBox();
    assert.ok(root.width - narrowPanel.width >= 320, 'viewport shrink retains usable world space');
    assert.deepEqual((await operation(page, 'entity:get', {id: 'document'})).size, entity.size);
    assert.deepEqual((await operation(page, 'view:get')).camera, camera);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('board and spatial panel cycles preserve projected native text, same DOM, reading and marks without refitting', async () => {
  for (const token of ['board', 'spatial-document']) {
    const {page, errors} = await openScene(token);
    try {
      await operation(page, 'ui:scene-list', {open: false});
      await operation(page, 'entity:set-placement', {id: 'notes', placement: 'panel'});
      await page.evaluate(selector => {window.originalContent = document.querySelector(`${selector} .component-content`);}, documentSurface);
      await operation(page, 'content:scroll', {id: 'document', x: 0, y: 1200});
      const reading = (await operation(page, 'content:get', {id: 'document'})).state.reading;
      const marked = await operation(page, 'content:annotation-create', {id: 'document', kind: 'point', label: 'Placement reading mark', color: '#ff6b5e', anchors: [reading]});
      await operation(page, 'content:annotation-open', {id: 'document', open: false});
      const entity = await operation(page, 'entity:get', {id: 'document'});
      for (const projection of token === 'board' ? ['board'] : ['perspective', 'orthographic']) {
        if (projection !== 'board') await operation(page, 'view:settings', {projection});
        await rendered(page);
        const camera = (await operation(page, 'view:get')).camera;
        const measure = () => page.locator(documentSurface).evaluate(element => {
          const content = element.querySelector('.component-content'), rect = element.getBoundingClientRect();
          const text = document.createTreeWalker(content.querySelector('pre'), NodeFilter.SHOW_TEXT).nextNode();
          const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(24, text.length));
          const glyph = range.getBoundingClientRect();
          return {x: rect.x, y: rect.y, width: rect.width, height: rect.height, glyphWidth: glyph.width, glyphHeight: glyph.height,
            nativeWidth: content.offsetWidth, nativeHeight: content.offsetHeight};
        });
        const before = await measure();
        for (const presentation of ['spatial', 'fullscreen', 'focus']) {
          if (presentation !== 'spatial') await operation(page, 'content:present', {id: 'document', presentation});
          await operation(page, 'entity:set-placement', {id: 'document', placement: 'panel'});
          if (presentation !== 'spatial') {
            assert.equal(await page.evaluate(() => !!window.originalContent.closest('dialog[open]')), true, 'placement changes do not dismiss expanded content');
            await operation(page, 'content:present', {id: 'document', presentation: 'spatial'});
          }
          assert.equal(await page.evaluate(() => !!window.originalContent.closest('.component-fixed-panels')), true);
          await operation(page, 'entity:set-placement', {id: 'document', placement: 'world'}); await rendered(page);
          const after = await measure();
          for (const key of ['x', 'y', 'width', 'height', 'glyphWidth', 'glyphHeight']) approximately(after[key], before[key], .5);
          assert.equal(after.nativeWidth, before.nativeWidth); assert.equal(after.nativeHeight, before.nativeHeight);
          assert.equal(await page.evaluate(selector => document.querySelector(`${selector} .component-content`) === window.originalContent, documentSurface), true);
          const restored = await operation(page, 'content:get', {id: 'document'});
          assert.equal(restored.state.reading.source, reading.source); assert.equal(restored.state.reading.target, reading.target);
          assert.deepEqual(restored.state.marks, marked.state.marks);
          const returned = await operation(page, 'entity:get', {id: 'document'});
          assert.deepEqual(returned.position, entity.position); assert.deepEqual(returned.size, entity.size);
          assert.deepEqual((await operation(page, 'view:get')).camera, camera);
        }
      }
      assert.deepEqual(errors, []);
    } finally {await page.close();}
  }
});

test('source reading and same-DOM presentations survive an immutable board share and saved camera restore', async () => {
  const {page, errors} = await openScene('board');
  let reopened;
  try {
    await page.locator(`${documentSurface} .component-content pre`).filter({hasText: 'source line 600:'}).waitFor();
    await page.evaluate(selector => {window.originalContent = document.querySelector(`${selector} .component-content`);}, documentSurface);
    await operation(page, 'content:scroll', {id: 'document', x: 0, y: 1200});
    const reading = (await operation(page, 'content:get', {id: 'document'})).state.reading;
    assert.ok(reading.source); assert.ok(reading.target);
    assert.notEqual(reading.target, 'line:0', 'a completed native scroll cannot be overwritten by initial reading restoration');
    await operation(page, 'content:present', {id: 'document', presentation: 'fullscreen'}); await rendered(page);
    assert.equal(await page.evaluate(() => window.originalContent.isConnected && !!window.originalContent.closest('dialog[open]')), true);
    await operation(page, 'content:present', {id: 'document', presentation: 'spatial'}); await rendered(page);
    assert.equal(await page.evaluate(selector => document.querySelector(`${selector} .component-content`) === window.originalContent, documentSurface), true);
    await operation(page, 'content:scroll', {id: 'document', x: 0, y: 0});
    await operation(page, 'content:set-reading', {id: 'document', anchor: reading}); await rendered(page);
    const restored = (await operation(page, 'content:get', {id: 'document'})).state.reading;
    assert.equal(restored.source, reading.source); assert.equal(restored.target, reading.target);
    await failure(page, 'content:set-reading', {id: 'notes', anchor: reading}, 'INVALID_ARGUMENT');
    const framing = {center: [11, -7], scale: 3};
    const [stroke, links] = await page.evaluate(async framing => {
      const execute = async (name, params = {}) => {
        const result = await window.blind.execute(name, params);
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value;
      };
      await execute('entity:set-placement', {id: 'notes', placement: 'panel'});
      await execute('view:set', {kind: 'board', ...framing});
      const stroke = await execute('annotation:create-screen', {label: 'Saved board mark', color: '#ff6b5e', aspect: 1.5, points: [[.2, .2], [.4, .3]]});
      return [stroke, await execute('share:create')];
    }, framing);
    const token = new URL(links.viewer_url).pathname.split('/').at(-1);
    const savedResponse = await fetch(`${origin}/api/v1/scenes/${token}`); assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual(saved.state.viewport.board, framing); assert.equal(saved.state.camera, null);
    assert.equal(saved.entities.find(entity => entity.id === 'notes').placement, 'panel');
    assert.equal(saved.entities.find(entity => entity.id === 'document').state.reading.target, reading.target);
    assert.equal(saved.state.strokes[0].id, stroke.id);
    await rendered(page);
    assert.equal((await operation(page, 'annotation:list', {kind: 'screen'})).screen[0]?.id, stroke.id, 'completed placement and framing cannot invalidate newly created ink in a later frame');
    const opened = await openScene(token); reopened = opened.page;
    assert.deepEqual((await operation(reopened, 'view:get')).camera, framing);
    const reopenedContent = await operation(reopened, 'content:get', {id: 'document'});
    assert.equal(reopenedContent.state.reading.source, reading.source); assert.equal(reopenedContent.state.reading.target, reading.target);
    assert.equal((await operation(reopened, 'entity:get', {id: 'notes'})).placement, 'panel');
    assert.equal((await operation(reopened, 'annotation:list', {kind: 'screen'})).screen[0].id, stroke.id);
    assert.deepEqual(await reopened.evaluate(() => window.gpuContexts), []); assert.deepEqual(opened.errors, []);
    assert.equal(await (await fetch(`${origin}/source/document`)).text(), source, 'presentation, reading and sharing never edit source bytes');
    assert.ok(sourceRequests.every(request => request.method === 'GET'));
    assert.deepEqual(errors, []);
  } finally {await reopened?.close(); await page.close();}
});

test('explicit native scroll supersedes presentation restoration and replacing presented content keeps the new dialog open', async () => {
  const {page, errors} = await openScene('board');
  try {
    await page.locator(`${notesSurface} .component-content`).filter({hasText: 'Review item 80'}).waitFor();
    await operation(page, 'content:scroll', {id: 'document', x: 0, y: 800});
    const previous = (await operation(page, 'content:get', {id: 'document'})).state.reading;
    const interrupted = await page.evaluate(async () => {
      const measure = () => document.querySelector('.component-dialog .component-content').scrollTop;
      const presentation = window.blind.execute('content:present', {id: 'document', presentation: 'fullscreen'});
      const scroll = await window.blind.execute('content:scroll', {id: 'document', x: 0, y: 2400});
      const top = measure();
      const completed = await presentation;
      return {scroll, completed, top};
    });
    assert.equal(interrupted.scroll.ok, true, JSON.stringify(interrupted.scroll.error));
    assert.equal(interrupted.completed.ok, true, JSON.stringify(interrupted.completed.error));
    assert.notEqual(interrupted.scroll.value.state.reading.target, previous.target);
    assert.equal(interrupted.completed.value.state.reading.target, interrupted.scroll.value.state.reading.target,
      'settlement must not restore the superseded reading anchor');
    approximately(interrupted.top, 2400, 1);
    await operation(page, 'content:present', {id: 'notes', presentation: 'focus'});
    await rendered(page);
    assert.equal((await operation(page, 'content:get', {id: 'document'})).presentation, 'spatial');
    assert.equal((await operation(page, 'content:get', {id: 'notes'})).presentation, 'focus');
    assert.equal(await page.locator('.component-dialog[open] .component-content').filter({hasText: 'Review item 80'}).count(), 1,
      'replacing A with B must not let an A close event dismiss B');
    const reopened = await page.evaluate(async () => {
      const close = window.blind.execute('content:present', {id: 'notes', presentation: 'spatial'});
      const open = window.blind.execute('content:present', {id: 'document', presentation: 'focus'});
      return Promise.all([close, open]);
    });
    assert.ok(reopened.every(result => result.ok), JSON.stringify(reopened));
    await rendered(page);
    assert.equal((await operation(page, 'content:get', {id: 'document'})).presentation, 'focus');
    assert.equal(await page.locator('.component-dialog[open] .component-content pre').filter({hasText: 'source line 600:'}).count(), 1,
      'a queued close notification from a completed prior presentation must not close a reopened dialog');
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('showing a section closes the scene list through its owner state', async () => {
  const {page, errors} = await openScene('spatial');
  try {
    await operation(page, 'ui:scene-list', {open: true, tab: 'elements'});
    assert.equal(await page.locator('#scene-tree').isVisible(), true);
    const section = await operation(page, 'section:set-plane', {
      entityId: 'geometry', revision: 'fixture', origin: [0, 0, 0], normal: [0, 0, 1], axis: [1, 0, 0], radius: 2,
    });
    assert.equal(section.active, true);
    assert.equal((await operation(page, 'ui:scene-list-get')).open, false);
    assert.equal(await page.locator('#scene-tree').isVisible(), false);
    assert.equal(await page.locator('#scene-tree-toggle').getAttribute('aria-expanded'), 'false');
    assert.ok(await page.evaluate(() => window.operationEvents.some(event => event.domain === 'scene-list' && event.data?.sceneList?.open === false)));
    await page.locator('#scene-tree-toggle').click();
    assert.equal((await operation(page, 'ui:scene-list-get')).open, true);
    assert.equal(await page.locator('#scene-tree').isVisible(), true, 'the first toggle after section opening must reopen, not close stale owner state');
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('screen annotation IDs survive edits and undo, while camera navigation invalidates view-scoped ink and history', async () => {
  const {page, errors} = await openScene('board');
  try {
    const stroke = await operation(page, 'annotation:create-screen', {label: 'Review', color: '#ff6b5e', aspect: 1.5, points: [[.2, .2], [.4, .3]]});
    assert.equal(typeof stroke.id, 'string'); assert.ok(stroke.id.length > 0);
    const edited = await operation(page, 'annotation:edit-screen', {id: stroke.id, label: 'Reviewed', color: '#5fb4ff'});
    assert.equal(edited.id, stroke.id);
    await operation(page, 'annotation:undo');
    assert.deepEqual((await operation(page, 'annotation:list', {kind: 'screen'})).screen, [stroke]);
    await operation(page, 'annotation:redo');
    assert.deepEqual((await operation(page, 'annotation:list', {kind: 'screen'})).screen, [edited]);
    await operation(page, 'annotation:remove', {kind: 'screen', id: stroke.id});
    assert.deepEqual((await operation(page, 'annotation:list', {kind: 'screen'})).screen, []);
    await operation(page, 'annotation:undo');
    assert.equal((await operation(page, 'annotation:list', {kind: 'screen'})).screen[0].id, stroke.id);
    await page.evaluate(() => {window.operationEvents = [];});
    const changed = await operation(page, 'view:pan', {delta: [30, 10]});
    assert.equal(changed.status, 'committed');
    assert.deepEqual((await operation(page, 'annotation:list', {kind: 'screen'})).screen, []);
    const toolbar = await operation(page, 'annotation:get'); assert.equal(toolbar.canUndo, false); assert.equal(toolbar.canRedo, false);
    const events = await page.evaluate(() => window.operationEvents.filter(event => event.domain === 'view'));
    assert.equal(events.length, 1); assert.deepEqual(events[0].data, changed.view);
    await failure(page, 'annotation:set-tool', {mode: 'point'}, 'UNSUPPORTED');
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('spatial camera operations commit real poses and native observation controls use the same settings and Fit path', async () => {
  const {page, errors} = await openScene('spatial');
  try {
    const initial = await operation(page, 'view:get'); assert.equal(initial.kind, 'spatial');
    assert.ok(await page.evaluate(() => window.gpuContexts.length > 0));
    const camera = {position: [4, 2, 6], target: [.1, .2, .1], up: [0, 1, 0], fov: 42, zoom: 1, orthographic_height: 4};
    const set = await operation(page, 'view:set', {kind: 'spatial', camera});
    assert.equal(set.status, 'committed'); assert.deepEqual(set.view.camera.position, camera.position); assert.deepEqual(set.view.camera.target, camera.target);
    assert.deepEqual(await operation(page, 'view:get'), set.view);
    const rotated = await operation(page, 'view:rotate', {axis: [0, 1, 0], angle: Math.PI / 2});
    assert.deepEqual(rotated.view.camera.target, camera.target);
    approximately(rotated.view.camera.position[0] - camera.target[0], camera.position[2] - camera.target[2]);
    approximately(rotated.view.camera.position[1] - camera.target[1], camera.position[1] - camera.target[1]);
    approximately(rotated.view.camera.position[2] - camera.target[2], -(camera.position[0] - camera.target[0]));
    await failure(page, 'view:rotate', {axis: [0, 0, 0], angle: 1}, 'INVALID_ARGUMENT');
    await failure(page, 'view:set', {kind: 'board', center: [0, 0], scale: 1}, 'UNSUPPORTED');
    await operation(page, 'view:settings', {shading: 'wire'});
    assert.equal(await page.locator('[data-shading="wire"]').getAttribute('class').then(value => value.includes('active')), true);
    await operation(page, 'ui:observe', {open: true, category: 'shading'});
    await page.locator('[data-shading="smooth"]').click();
    assert.equal((await operation(page, 'view:get')).settings.shading, 'smooth');
    await operation(page, 'view:settings', {projection: 'orthographic'});
    await operation(page, 'ui:observe', {open: true, category: 'projection'});
    await page.locator('[data-projection="perspective"]').click();
    assert.equal((await operation(page, 'view:get')).settings.projection, 'perspective');
    await operation(page, 'ui:observe', {open: true, category: 'scene'});
    const settings = (await operation(page, 'view:get')).settings;
    await page.locator('label:has(#axes-toggle)').click();
    assert.equal((await operation(page, 'view:get')).settings.axes, !settings.axes);
    await page.locator('label:has(#light-toggle)').click();
    assert.equal((await operation(page, 'view:get')).settings.background, settings.background === 'dark' ? 'light' : 'dark');
    await operation(page, 'ui:observe', {open: false, category: null});
    const focused = await operation(page, 'entity:focus', {ids: ['geometry']});
    await operation(page, 'view:pan', {delta: [50, 20]});
    await rendered(page); await page.evaluate(() => {window.operationEvents = [];});
    await page.locator('.mesh-group-label').click();
    await page.waitForFunction(() => window.operationEvents.some(event => event.domain === 'view'));
    sameCamera((await operation(page, 'view:get')).camera, focused.view.camera);
    const expected = await operation(page, 'view:fit', {animate: false});
    await page.evaluate(() => {window.operationEvents = [];});
    await page.locator('#fit-view').click();
    await page.waitForFunction(() => window.operationEvents.some(event => event.domain === 'view'));
    sameCamera((await operation(page, 'view:get')).camera, expected.view.camera);
    const interrupted = await page.evaluate(async () => {
      await window.blind.execute('view:pan', {delta: [100, 30]});
      const pending = window.blind.execute('view:fit', {animate: true});
      const frame = Promise.withResolvers(); requestAnimationFrame(frame.resolve); await frame.promise;
      const pan = await window.blind.execute('view:pan', {delta: [20, 10]});
      return {fit: await pending, pan};
    });
    assert.equal(interrupted.fit.ok, true); assert.equal(interrupted.fit.value.status, 'interrupted');
    assert.equal(interrupted.pan.ok, true); assert.equal(interrupted.pan.value.status, 'committed');
    sameCamera((await operation(page, 'view:get')).camera, interrupted.pan.value.view.camera);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
});

test('geometry demand never blocks host UI; transitions reuse loads and preserve the latest selection and camera', async () => {
  geometryRequests.length = 0;
  const first = Promise.withResolvers(); geometryGates.set('/mesh/demand/0', first);
  const second = Promise.withResolvers(); geometryGates.set('/mesh/demand/1', second);
  let page;
  try {
    ({page} = await openScene('demand'));
    await page.locator('.component-fixed-panels .component-content').getByText('A fixed panel stays in screen space.').waitFor();
    const initial = await operation(page, 'entity:list');
    assert.equal(initial.find(entity => entity.id === 'geometry-0').loadState, 'loading');
    assert.equal(initial.find(entity => entity.id === 'geometry-1').loadState, 'unloaded');
    assert.deepEqual(geometryRequests, ['/mesh/demand/0'], 'hidden resources must not be fetched');
    const camera = (await operation(page, 'view:get')).camera;
    first.resolve();
    await page.waitForFunction(async () => {
      const result = await window.blind.execute('entity:get', {id: 'geometry-0'});
      return result.ok && result.value.loadState === 'ready';
    });
    sameCamera((await operation(page, 'view:get')).camera, camera);
    await page.evaluate(() => {
      window.pendingDemand = window.blind.execute('scene:show', {ids: ['geometry-1', 'notes'], fit: true});
    });
    await page.waitForFunction(async () => {
      const result = await window.blind.execute('entity:get', {id: 'geometry-1'});
      return result.ok && result.value.loadState === 'loading';
    });
    await operation(page, 'scene:show', {ids: ['geometry-0', 'notes']});
    const selectedCamera = (await operation(page, 'view:get')).camera;
    second.resolve();
    const obsolete = await page.evaluate(() => window.pendingDemand);
    assert.equal(obsolete.ok, true, JSON.stringify(obsolete.error));
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-1'})).visible, false);
    sameCamera((await operation(page, 'view:get')).camera, selectedCamera);
    await operation(page, 'scene:show', {ids: ['geometry-1', 'notes']});
    assert.equal(geometryRequests.filter(path => path === '/mesh/demand/1').length, 1);
    await operation(page, 'entity:set-style', {id: 'geometry-2', visible: false, opacity: 0});
    assert.equal(geometryRequests.includes('/mesh/demand/2'), false);
    const shared = await operation(page, 'share:create');
    const saved = scenes.get(new URL(shared.viewer_url).pathname.split('/').at(-1));
    assert.equal(saved.meshes.length, 6);
    assert.equal(saved.meshes[1].visible, true);
    assert.equal(saved.meshes[2].visible, false);
    assert.equal(saved.meshes[2].source_url, '/mesh/demand/2');
    geometryFailures.add('/mesh/demand/3');
    await failure(page, 'scene:show', {ids: ['geometry-3', 'notes']}, 'RESOURCE_UNAVAILABLE');
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-3'})).loadState, 'error');
    assert.equal((await operation(page, 'content:get', {id: 'notes'})).ready, true);
    geometryFailures.delete('/mesh/demand/3');
    await operation(page, 'entity:set-quality', {id: 'geometry-3', quality: 'raw'});
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-3'})).loadState, 'ready');
    const mark = await operation(page, 'annotation:create-surface', {
      entityId: 'geometry-4', revision: 'fixture', kind: 'point', label: 'Pinned source sample',
      color: '#ff6b5e', visible: true, closed: false, points: [[0, 0, 0]], normals: [[0, 0, 1]], controls: [0],
    });
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-4'})).loadState, 'ready');
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-4'})).visible, false);
    assert.equal(geometryRequests.filter(path => path === '/mesh/demand/4').length, 1);
    await failure(page, 'entity:set-quality', {id: 'geometry-4', quality: 'lod'}, 'CONFLICT');
    const annotated = await operation(page, 'share:create');
    const annotatedScene = scenes.get(new URL(annotated.viewer_url).pathname.split('/').at(-1));
    assert.equal(annotatedScene.state.annotations[0].id, mark.id);
    assert.equal(annotatedScene.meshes[4].quality, 'raw');
    const {page: reopened} = await openScene(new URL(annotated.viewer_url).pathname.split('/').at(-1));
    try {
      assert.equal((await operation(reopened, 'entity:get', {id: 'geometry-4'})).loadState, 'unloaded');
      const listed = (await operation(reopened, 'annotation:list', {kind: 'surface'})).surface[0];
      assert.equal(listed.entityId, 'geometry-4', 'saved annotation identity must not depend on resident geometry');
      const coordinates = await operation(reopened, 'annotation:coordinates', {kind: 'surface', id: mark.id});
      assert.equal(coordinates.entityId, 'geometry-4'); assert.deepEqual(coordinates.points, mark.points);
    } finally {await reopened.close();}
  } finally {
    first.resolve(); second.resolve(); geometryGates.clear(); geometryFailures.clear(); await page?.close();
  }
});

test('render completion demands visible geometry only and rejects visible source errors', async () => {
  geometryRequests.length = 0;
  geometryFailures.add('/mesh/demand/5');
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/s/demand?render`);
    await page.waitForFunction(() => document.documentElement.dataset.renderStatus === 'ready');
    assert.deepEqual(geometryRequests, ['/mesh/demand/0']);
    await page.screenshot();
    const broken = structuredClone(demand); broken.meshes[0].source_url = '/mesh/demand/5';
    scenes.set('demand-broken', broken);
    await page.goto(`${origin}/s/demand-broken?render`);
    await page.waitForFunction(() => document.documentElement.dataset.renderStatus === 'error');
    assert.match(await page.locator('html').getAttribute('data-render-error'), /geometry|Geometry/);
  } finally {geometryFailures.clear(); scenes.delete('demand-broken'); await page.close();}
});

test('simultaneous initial, visibility and quality demands share one four-request queue', async () => {
  geometryRequests.length = 0; peakGeometry = 0;
  const gates = Array.from({length: 6}, () => Promise.withResolvers());
  gates.forEach((gate, index) => geometryGates.set(`/mesh/demand/${index}`, gate));
  const fourRequested = Promise.withResolvers();
  requestedGeometry = () => {if (geometryRequests.length === 4) fourRequested.resolve();};
  let page, requestTimeout;
  try {
    ({page} = await openScene('demand'));
    await page.evaluate(() => {
      window.allDemand = window.blind.execute('scene:show', {ids: ['geometry-0', 'geometry-1', 'geometry-2', 'geometry-3', 'geometry-4', 'geometry-5', 'notes']});
      window.sameDemand = window.blind.execute('entity:set-quality', {id: 'geometry-0', quality: 'raw'});
    });
    await Promise.race([fourRequested.promise, new Promise((_, reject) => {
      requestTimeout = setTimeout(() => reject(new Error('Four geometry requests did not start')), 30000);
    })]);
    clearTimeout(requestTimeout);
    assert.equal(activeGeometry, 4);
    gates.slice(0, 4).forEach(gate => gate.resolve());
    gates.slice(4).forEach(gate => gate.resolve());
    const results = await page.evaluate(() => Promise.all([window.allDemand, window.sameDemand]));
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(peakGeometry, 4);
    assert.equal(geometryRequests.length, 6);
    assert.equal(new Set(geometryRequests).size, 6);
  } finally {
    clearTimeout(requestTimeout);
    requestedGeometry = undefined; gates.forEach(gate => gate.resolve()); geometryGates.clear(); await page?.close();
  }
});

test('a superseded quality request cannot install stale geometry or change source identity', async () => {
  geometryRequests.length = 0;
  const raw = Promise.withResolvers(); geometryGates.set('/mesh/demand/4', raw);
  let page;
  try {
    ({page} = await openScene('demand'));
    await page.evaluate(() => {window.oldQuality = window.blind.execute('entity:set-quality', {id: 'geometry-4', quality: 'raw'});});
    await page.waitForFunction(async () => {
      const result = await window.blind.execute('entity:get', {id: 'geometry-4'});
      return result.ok && result.value.loadState === 'loading';
    });
    const latest = await operation(page, 'entity:set-quality', {id: 'geometry-4', quality: 'lod'});
    assert.equal(latest.quality, 'lod'); assert.equal(latest.loadState, 'ready');
    const old = await page.evaluate(() => window.oldQuality);
    assert.equal(old.ok, false); assert.equal(old.error.code, 'CANCELLED');
    raw.resolve();
    const shared = await operation(page, 'share:create');
    const saved = scenes.get(new URL(shared.viewer_url).pathname.split('/').at(-1));
    assert.equal(saved.meshes[4].quality, 'lod');
    assert.equal(saved.meshes[4].source_url, '/mesh/demand/4');
    assert.equal(saved.meshes[4].revision, 'fixture');
    await operation(page, 'entity:set-quality', {id: 'geometry-4', quality: 'lod'});
    assert.equal(geometryRequests.filter(path => path === '/mesh/demand/4/lod').length, 1);
  } finally {raw.resolve(); geometryGates.clear(); await page?.close();}
});

test('teardown aborts active geometry, rejects consumers and never installs a late response', async () => {
  const gate = Promise.withResolvers(); geometryGates.set('/mesh/demand/4', gate);
  let page;
  try {
    ({page} = await openScene('demand'));
    await page.evaluate(() => {
      window.retainedHost = window.blind;
      window.disposedDemand = window.blind.execute('entity:set-quality', {id: 'geometry-4', quality: 'raw'});
    });
    await page.waitForFunction(async () => {
      const result = await window.blind.execute('entity:get', {id: 'geometry-4'});
      return result.ok && result.value.loadState === 'loading';
    });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false})));
    const result = await page.evaluate(() => window.disposedDemand);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'DISPOSED');
    assert.ok(await page.evaluate(() => window.abortedGeometry.includes('/mesh/demand/4')));
    gate.resolve(); await rendered(page);
    assert.equal(await page.locator('#canvas-root canvas').count(), 0);
    assert.equal(await page.locator('.scene-surface').count(), 0);
    const later = await page.evaluate(() => window.retainedHost.execute('entity:list'));
    assert.equal(later.ok, false); assert.equal(later.error.code, 'DISPOSED');
  } finally {gate.resolve(); geometryGates.clear(); await page?.close();}
});

test('the latest pending focus supersedes earlier focus and default framing before geometry arrives', async () => {
  const unframed = structuredClone(demand); unframed.state.camera = null;
  unframed.meshes[1].visible = unframed.entities[1].visible = true;
  unframed.meshes[1].translation = unframed.entities[1].position = [30, 0, 0];
  scenes.set('unframed-demand', unframed);
  const first = Promise.withResolvers(), latest = Promise.withResolvers();
  geometryGates.set('/mesh/demand/0', first); geometryGates.set('/mesh/demand/1', latest);
  let page;
  try {
    ({page} = await openScene('unframed-demand'));
    const before = (await operation(page, 'view:get')).camera;
    await page.evaluate(() => {
      window.earlierFocus = window.blind.execute('entity:focus', {ids: ['geometry-0']});
      window.latestFocus = window.blind.execute('entity:focus', {ids: ['geometry-1']});
    });
    first.resolve();
    const earlier = await page.evaluate(() => window.earlierFocus);
    assert.equal(earlier.ok, true, JSON.stringify(earlier.error)); assert.equal(earlier.value.status, 'interrupted');
    sameCamera((await operation(page, 'view:get')).camera, before);
    latest.resolve();
    const focused = await page.evaluate(() => window.latestFocus);
    assert.equal(focused.ok, true, JSON.stringify(focused.error)); assert.equal(focused.value.status, 'committed');
    assert.ok(focused.value.view.camera.target[0] > 20, 'latest focus must frame the translated entity');
  } finally {first.resolve(); latest.resolve(); geometryGates.clear(); scenes.delete('unframed-demand'); await page?.close();}
});

test('section opening awaits selected nonresident geometry and drawing cancellation prevents a late open', async () => {
  const held = Promise.withResolvers(); geometryGates.set('/mesh/demand/0', held);
  let page;
  try {
    ({page} = await openScene('demand'));
    await page.evaluate(() => {
      window.sectionOpeningSettled = false;
      window.sectionOpening = window.blind.execute('section:open').then(result => {window.sectionOpeningSettled = true; return result;});
    });
    await rendered(page);
    assert.equal(await page.evaluate(() => window.sectionOpeningSettled), false, 'section opening must wait for selected geometry, not reject an unloaded surface');
    await operation(page, 'section:cancel');
    held.resolve();
    const cancelled = await page.evaluate(() => window.sectionOpening);
    assert.equal(cancelled.ok, false); assert.equal(cancelled.error.code, 'CANCELLED');
    assert.equal((await operation(page, 'section:get')).drawing, false);
    await page.locator('#observe-trigger').click();
    await page.locator('#section-trigger').click();
    await page.locator('.section-draw-overlay').waitFor({state: 'visible'});
    assert.equal((await operation(page, 'section:get')).drawing, true);
    await operation(page, 'section:cancel');
  } finally {held.resolve(); geometryGates.clear(); await page?.close();}
});

test('saved section identity and measurements survive unavailable geometry and restore real contours after retry', async () => {
  const held = Promise.withResolvers(); geometryGates.set('/mesh/demand/0', held);
  geometryFailures.add('/mesh/demand/0'); geometryRequests.length = 0;
  const saved = structuredClone(demand);
  saved.state.section = {
    entity_id: 'geometry-0', mesh: 0, revision: 'fixture',
    origin: [0, 0, .25], normal: [0, 0, 1], axis: [1, 0, 0], radius: 2, offset: 0,
    fit: false, pan: [.1, .2], panel_size: [500, 380],
    targets: [{entity_id: 'geometry-0', mesh: 0, revision: 'fixture'}, {entity_id: 'geometry-1', mesh: 1, revision: 'fixture'}],
    measurements: [{a: [0, 0], b: [1, 0]}],
  };
  scenes.set('saved-section-demand', saved);
  let page;
  try {
    ({page} = await openScene('saved-section-demand'));
    const initial = await operation(page, 'section:get');
    assert.equal(initial.active, true); assert.deepEqual(initial.state, saved.state.section);
    assert.deepEqual(initial.contours, []); assert.equal(initial.measurements[0].distance, 1);
    assert.deepEqual(geometryRequests, ['/mesh/demand/0'], 'saved hidden section targets must not load at startup');
    held.resolve();
    await page.waitForFunction(async () => (await window.blind.execute('entity:get', {id: 'geometry-0'})).value.loadState === 'error');
    assert.deepEqual((await operation(page, 'section:get')).state, saved.state.section, 'a transient geometry failure must not erase the captured section');
    geometryFailures.delete('/mesh/demand/0');
    await operation(page, 'entity:set-quality', {id: 'geometry-0', quality: 'raw'});
    const restored = await operation(page, 'section:get');
    assert.deepEqual(restored.state, saved.state.section); assert.equal(restored.measurements[0].distance, 1);
    assert.deepEqual(restored.contours.map(contour => contour.entityId), ['geometry-0']);
    const endpoints = restored.contours[0].segments.flatMap(segment => [segment.a, segment.b]);
    for (const expected of [[0, 0], [.75, 0], [0, .75]]) {
      assert.ok(endpoints.some(point => point.every((value, index) => Math.abs(value - expected[index]) < 1e-6)), `missing tetrahedron intersection ${expected}`);
    }
    assert.equal((await operation(page, 'entity:get', {id: 'geometry-1'})).loadState, 'unloaded');
  } finally {held.resolve(); geometryGates.clear(); geometryFailures.clear(); scenes.delete('saved-section-demand'); await page?.close();}
});
