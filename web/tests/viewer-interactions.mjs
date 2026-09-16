import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const dist = new URL('../dist/', import.meta.url);
const fixture = await readFile(new URL('../../tests/fixtures/tetra.ply', import.meta.url));
const html = (await readFile(new URL('index.html', dist), 'utf8')).replace('<head>', '<head><base href="/">');
const scene = {
  title: 'Viewer interaction regression', owner: false,
  meshes: [0, 1].map(i => ({ name: `Mesh ${i + 1}`, format: 'ply', revision: 'fixture', byte_size: fixture.length,
    color: i ? '#5fb4ff' : '#ffc857', opacity: 1, visible: true, quality: 'raw', source_url: `/mesh/${i}`,
    ...(i === 0 ? {label:{text:'Mesh one'}} : {}) })),
  label_groups: [{text:'Reference pair',meshes:[0,1]}],
  state: { selected: 0, shading: 'flat', projection: 'perspective', background: 'dark', axes: false,
    frame: { width: 1280, height: 800 }, camera: null, strokes: [{color:'#ff6b5e',aspect:1.6,points:[[0.2,0.2],[0.4,0.3]]}] },
};
let browser, server, origin, shared;
before(async () => {
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'POST' && path.endsWith('/share')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        shared = JSON.parse(Buffer.concat(chunks));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({viewer_url: `${origin}/s/fixture`, image_url: `${origin}/i/fixture.png`, origin, hosts: []}));
      } else if (path.startsWith('/api/v1/scenes/')) {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(scene));
      } else if (path.startsWith('/mesh/')) {
        res.setHeader('Content-Type', 'application/ply'); res.end(fixture);
      } else if (path.startsWith('/assets/') && !path.includes('..')) {
        res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(await readFile(new URL(path.slice(1), dist)));
      } else { res.setHeader('Content-Type','text/html'); res.end(html); }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.BLIND_TEST_CHROMIUM || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

async function openPage(viewport, markupResizeDelay = 0) {
  const page = await browser.newPage({viewport, deviceScaleFactor: 2});
  if (markupResizeDelay) await page.addInitScript(delay => {
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        super((entries, observer) => {
          if (entries.some(entry => entry.target.id === 'viewer')) {
            setTimeout(() => {
              callback(entries, observer);
              window.delayedMarkupResizeDelivered = true;
            }, delay);
          } else callback(entries, observer);
        });
      }
    };
  }, markupResizeDelay);
  await page.addInitScript(() => {
    window.paintEvents = []; window.paintFrame = 0;
    const frame = () => { window.paintFrame++; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    const name = canvas => canvas.id === 'markup-canvas' ? 'markup' : canvas.parentElement?.id === 'canvas-root' ? 'mesh' : null;
    const record = (canvas, type) => { const target = name(canvas); if (target) window.paintEvents.push({target,type,frame:window.paintFrame}); };
    for (const property of ['width','height']) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
      Object.defineProperty(HTMLCanvasElement.prototype, property, {...d, set(value) { record(this,'resize'); d.set.call(this,value); }});
    }
    for (const [type, method] of [[WebGL2RenderingContext,'clear'],[CanvasRenderingContext2D,'clearRect']]) {
      const original = type.prototype[method];
      type.prototype[method] = function(...args) { record(this.canvas,'render'); return original.apply(this,args); };
    }
  });
  await page.goto(`${origin}/s/fixture`);
  await page.locator('#loading-state').waitFor({state:'hidden'});
  assert.equal(await page.locator('#invalid-state').isVisible(), false);
  await page.waitForTimeout(350);
  return page;
}
async function eventsDuring(page, action) {
  await page.evaluate(() => { window.paintEvents = []; });
  await action(); await page.waitForTimeout(300);
  return page.evaluate(() => window.paintEvents);
}
async function viewportResizeEvents(page, viewport) {
  return eventsDuring(page, async () => {
    await page.setViewportSize(viewport);
    // ResizeObserver and its scheduled paint can exceed a fixed delay on CI.
    // Still fail on a missing resize; the assertions below check same-frame paint.
    await page.waitForFunction(() => ['mesh','markup'].every(target =>
      window.paintEvents.some(event => event.target === target && event.type === 'resize')
    ), null, {timeout:10_000});
  });
}
function assertViewportResized(events) {
  for (const target of ['mesh','markup']) {
    const resizes = events.filter(e=>e.type==='resize' && e.target===target);
    assert.ok(resizes.length > 0, `real viewport resize must resize ${target}`);
    for (const resize of resizes) assert.ok(events.some(e=>e.target===target && e.type==='render' && e.frame===resize.frame), `${target} buffer cleared without repainting in the same frame`);
  }
}

for (const viewport of [{width:1280,height:800},{width:390,height:844},{width:320,height:700},{width:740,height:420}]) {
  test(`toolbars preserve the scene canvas at ${viewport.width}×${viewport.height}`, async () => {
    const page = await openPage(viewport);
    try {
      for (const selector of ['.panel-trigger','#close-panel','#scene-info-toggle','#brush-tool','#finish-brush','#axis-orb','#fit-view']) {
        const events = await eventsDuring(page, () => page.locator(selector).click());
        assert.equal(events.filter(e=>e.type==='resize').length, 0, `${selector} cleared a scene canvas`);
      }
      if (process.env.BLIND_TEST_SCREENSHOTS) {
        await page.locator('.panel-trigger').click();
        await page.locator('#opacity-range').scrollIntoViewIfNeeded();
        await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
        await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/${viewport.width}x${viewport.height}.png`});
        await page.locator('#close-panel').click();
      }
      assertViewportResized(await viewportResizeEvents(page, {width:viewport.width+40,height:viewport.height+30}));
    } finally { await page.close(); }
  });
}

test('viewport resize waits for a delayed markup observer', async () => {
  const page = await openPage({width:1280,height:800}, 500);
  try {
    // Let the delayed initial notification finish before measuring the resize.
    await page.waitForFunction(() => window.delayedMarkupResizeDelivered);
    assertViewportResized(await viewportResizeEvents(page, {width:1320,height:830}));
  } finally { await page.close(); }
});

test('visibility beside opacity preserves opacity, selection and shared state', async () => {
  const page = await openPage({width:390,height:844});
  try {
    await page.locator('.panel-trigger').click();
    const toggle = page.locator('#mesh-visible-toggle');
    await toggle.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const a=document.querySelector('label[for="opacity-range"]').getBoundingClientRect();
      const b=document.querySelector('#mesh-visible-toggle').closest('label').getBoundingClientRect();
      return {delta:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2), gap:b.left-a.right};
    });
    assert.ok(geometry.delta < 8 && geometry.gap >= 0, 'visibility must sit beside the opacity label');
    await page.locator('#opacity-range').fill('37');
    await toggle.locator('..').click();
    assert.equal(await toggle.isChecked(),false);
    assert.equal(await page.locator('#opacity-range').inputValue(),'37');
    await page.locator('#detail-mesh-select').selectOption('1');
    assert.equal(await toggle.isChecked(),true);
    await page.locator('#detail-mesh-select').selectOption('0');
    assert.equal(await toggle.isChecked(),false);
    assert.equal(await page.locator('#opacity-range').inputValue(),'37');
    // The hidden native checkbox remains keyboard operable and has a visible focus cue.
    await toggle.focus(); await page.keyboard.press('Space'); assert.equal(await toggle.isChecked(),true);
    await page.keyboard.press('Space'); assert.equal(await toggle.isChecked(),false);
    await page.locator('#close-panel').click();
    await page.locator('#share-view').click();
    await page.locator('#share-sheet').waitFor({state:'visible'});
    assert.equal(shared.meshes[0].visible,false);
    assert.equal(shared.meshes[0].opacity,0.37);
    assert.equal(shared.meshes[1].visible,true);
  } finally { await page.close(); }
});

test('a label spanning multiple Meshes draws a focusable frame beside individual labels', async () => {
  const page = await openPage({width:390,height:844});
  try {
    const group = page.locator('.mesh-group-label');
    assert.equal(await group.getAttribute('aria-label'),'聚焦标注 Reference pair，2 个 Mesh');
    assert.equal(await page.locator('.mesh-label').getByText('Mesh one').isVisible(),true);
    const geometry = await page.evaluate(() => {
      const label=document.querySelector('.mesh-group-label').getBoundingClientRect();
      return {path:document.querySelector('.mesh-group-frame').getAttribute('d'),left:label.left,right:label.right,width:innerWidth};
    });
    assert.ok(geometry.path.length > 20,'group frame must contain visible corner segments');
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.width,'group label must stay inside the viewport');
    await group.click();
    assert.equal(await group.isVisible(),true);
  } finally { await page.close(); }
});
