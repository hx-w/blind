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

async function openPage(viewport, markupResizeDelay = 0, sceneOverride = null) {
  const page = await browser.newPage({viewport, deviceScaleFactor: 2});
  if (sceneOverride) await page.route('**/api/v1/scenes/**', route => route.fulfill({json:sceneOverride}));
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

test('opaque geometry covers ordinary labels but the selected label stays in front', async () => {
  const ungrouped = {...scene,label_groups:[]};
  const page = await openPage({width:1280,height:800},0,ungrouped);
  try {
    await page.locator('.panel-trigger').click();
    await page.locator('#detail-mesh-select').selectOption('1');
    await page.locator('#close-panel').click();
    await page.waitForTimeout(350);
    const placeInsideMesh = () => page.evaluate(() => {
      const dot = document.querySelector('.mesh-label-anchor');
      const root = document.querySelector('.canvas-root').getBoundingClientRect();
      const x = Number(dot.getAttribute('cx')), y = Number(dot.getAttribute('cy'));
      const label = document.querySelector('.mesh-label');
      Object.assign(label.style, {transform:`translate(${x-10}px, ${y-10}px)`,width:'20px',height:'20px',padding:'0',background:'rgb(255, 0, 0)',boxShadow:'none'});
      label.textContent = '';
      return {x:root.x+x-2,y:root.y+y-2,width:4,height:4};
    });
    const label = page.locator('.mesh-label');
    let clip = await placeInsideMesh();
    const ordinary = await page.screenshot({clip});
    await label.evaluate(element => {element.style.visibility='hidden';});
    const geometry = await page.screenshot({clip});
    assert.deepEqual(ordinary, geometry, 'an ordinary label must not paint over opaque geometry');
    await label.evaluate(element => {element.style.visibility='';});
    await page.locator('.panel-trigger').click();
    await page.locator('#detail-mesh-select').selectOption('0');
    await page.locator('#close-panel').click();
    await page.waitForTimeout(350);
    clip = await placeInsideMesh();
    const selected = await page.screenshot({clip});
    await label.evaluate(element => {element.style.visibility='hidden';});
    const selectedHidden = await page.screenshot({clip});
    assert.notDeepEqual(selected, selectedHidden, 'the selected label must paint in front of geometry');
  } finally { await page.close(); }
});

test('an ordinary group label remains pointer-accessible through wireframe openings', async () => {
  const fixtureScene = structuredClone(scene);
  fixtureScene.meshes.push({...fixtureScene.meshes[1],name:'Third Mesh',label:{text:'Third Mesh'}});
  fixtureScene.state.selected = 2;
  fixtureScene.state.shading = 'wire';
  const page = await openPage({width:1280,height:800},0,fixtureScene);
  try {
    const point = await page.evaluate(() => {
      const group = document.querySelector('.mesh-group-label');
      const dot = document.querySelector('.mesh-label-anchor');
      const root = document.querySelector('.canvas-root').getBoundingClientRect();
      const x = Number(dot.getAttribute('cx'))+8, y = Number(dot.getAttribute('cy'))+8;
      // Pointer-down triggers a render. Keep this synthetic test position fixed
      // while the normal label layout recomputes its inline transform.
      const style = document.createElement('style');
      style.textContent = `.mesh-group-label { transform: translate(${x-group.offsetWidth/2}px, ${y-group.offsetHeight/2}px) !important; }`;
      document.head.append(style);
      window.groupClicks=[];
      group.addEventListener('click',event => window.groupClicks.push(event.detail));
      return {x:root.x+x,y:root.y+y};
    });
    assert.equal(await page.locator('.mesh-group-label').evaluate(el=>el.classList.contains('selected')),false);
    await page.mouse.move(point.x,point.y);
    await page.mouse.down();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(()=>window.groupClicks),[1], 'visible group labels must retain animated pointer activation');
  } finally { await page.close(); }
});

for (const viewport of [{width:390,height:844},{width:320,height:700},{width:740,height:420},{width:1280,height:800}]) {
  test(`dense grouped labels keep one detail and compact frame captions at ${viewport.width}×${viewport.height}`, async () => {
    const names = ['1. deformr / FDI 15 / ok','2. deformr / FDI 25 / partial','3. es-v24 / FDI 15 / partial','4. es-v24 / FDI 25 / partial'];
    const dense = structuredClone(scene);
    dense.state.strokes=[];
    dense.meshes = names.flatMap((name,group) => ['扫描','交付冠'].map((role,member) => ({...scene.meshes[member],
      name:`${name} / ${role}`,label:{text:`${name} / ${role}`},source_url:`/dense-mesh/${group*2+member}`})));
    dense.label_groups=names.map((text,index)=>({text,meshes:[index*2,index*2+1]}));
    const page = await browser.newPage({viewport,deviceScaleFactor:2});
    await page.route('**/api/v1/scenes/**',route=>route.fulfill({json:dense}));
    await page.route('**/dense-mesh/*',route=>{
      const index=Number(route.request().url().split('/').at(-1)), group=Math.floor(index/2);
      const lines=fixture.toString().trim().split('\n'), start=lines.indexOf('end_header')+1;
      const scale=index%2 ? .45 : 1;
      for(let i=start;i<start+4;i++) {
        const p=lines[i].split(' ').map(Number);
        lines[i]=[p[0]*scale+(group%2)*2.2,p[1]*scale+Math.floor(group/2)*2.2,p[2]*scale+(index%2?.6:0)].join(' ');
      }
      return route.fulfill({body:lines.join('\n')+'\n',contentType:'application/ply'});
    });
    try {
      await page.goto(`${origin}/s/dense`);
      await page.locator('#loading-state').waitFor({state:'hidden'});
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.mesh-label:visible').count(),1,'group members must not repeat every group title');
      assert.equal(await page.locator('.mesh-label:visible').textContent(),'扫描');
      const captions=await page.locator('.mesh-group-label:visible').evaluateAll(elements=>elements.map(el=>{
        const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,font:parseFloat(getComputedStyle(el).fontSize)};
      }));
      if(process.env.BLIND_TEST_SCREENSHOTS) {
        await mkdir(process.env.BLIND_TEST_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/dense-${viewport.width}.png`});
      }
      assert.equal(captions.length,4,'separated groups should retain their captions');
      for(const a of captions) {
        assert.ok(a.font<=12,'group captions must use the explicit compact type scale');
        assert.ok(a.x>=0 && a.x+a.width<=viewport.width && a.y>=0 && a.y+a.height<=viewport.height,'caption clipped by viewport');
      }
      for(let i=0;i<captions.length;i++) for(let j=i+1;j<captions.length;j++) {
        const a=captions[i],b=captions[j];
        assert.ok(Math.min(a.x+a.width,b.x+b.width)<=Math.max(a.x,b.x) || Math.min(a.y+a.height,b.y+b.height)<=Math.max(a.y,b.y),'group captions overlap');
      }
      await page.locator('.panel-trigger').click();
      await page.locator('#detail-mesh-select').selectOption('3');
      await page.locator('#close-panel').click();
      await page.waitForTimeout(350);
      assert.equal(await page.locator('.mesh-label:visible').count(),1);
      assert.equal(await page.locator('.mesh-label:visible').textContent(),'交付冠');
    } finally {await page.close();}
  });
}

test('ungrouped crowding keeps the selection and suppresses colliding secondary labels', async () => {
  const crowded = structuredClone(scene);
  crowded.label_groups=[];
  crowded.meshes=Array.from({length:10},(_,index)=>({...scene.meshes[index%2],label:{text:`独立网格 ${index+1} / 扫描参考`}}));
  const page=await openPage({width:390,height:844},0,crowded);
  try {
    const labels=await page.locator('.mesh-label:visible').evaluateAll(elements=>elements.map(el=>{
      const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,selected:el.classList.contains('selected')};
    }));
    assert.ok(labels.length>0 && labels.length<10,'crowded labels must be reduced, not merely repositioned');
    assert.equal(labels.filter(label=>label.selected).length,1);
    for(let i=0;i<labels.length;i++) for(let j=i+1;j<labels.length;j++) {
      const a=labels[i],b=labels[j];
      assert.ok(Math.min(a.x+a.width,b.x+b.width)<=Math.max(a.x,b.x) || Math.min(a.y+a.height,b.y+b.height)<=Math.max(a.y,b.y),'secondary labels overlap');
    }
  } finally {await page.close();}
});

test('overlapping selected groups do not stack their captions', async () => {
  const overlapping={...scene,label_groups:Array.from({length:6},(_,i)=>({text:`参考组 ${i+1}`,meshes:[0,1]}))};
  const page=await openPage({width:390,height:844},0,overlapping);
  try {
    const rects=await page.locator('.mesh-group-label:visible, .mesh-label:visible').evaluateAll(elements=>elements.map(el=>{
      const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};
    }));
    assert.ok(rects.length>1 && rects.length<7);
    for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) {
      const a=rects[i],b=rects[j];assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,'selected groups must respect other captions');
    }
  } finally {await page.close();}
});
