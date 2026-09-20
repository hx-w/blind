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

async function openPage(viewport, markupResizeDelay = 0, sceneOverride = null, meshes = null) {
  const page = await browser.newPage({viewport, deviceScaleFactor: 2});
  if (meshes) await page.route('**/mesh/*', route => route.fulfill({contentType:'application/ply', body: meshes[Number(new URL(route.request().url()).pathname.split('/').at(-1))]}));
  if (sceneOverride) await page.route('**/api/v1/scenes/**', route => route.request().method() === 'GET' ? route.fulfill({json:sceneOverride}) : route.continue());
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
      for (const selector of ['.panel-trigger','#close-panel','#scene-info-toggle','#brush-tool','#surface-brush','#surface-done','#axis-orb','#fit-view']) {
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
    await page.locator('#detail-mesh-select').selectOption('mesh-1');
    assert.equal(await toggle.isChecked(),true);
    await page.locator('#detail-mesh-select').selectOption('mesh-0');
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
    await page.locator('#detail-mesh-select').selectOption('mesh-1');
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
    await page.locator('#detail-mesh-select').selectOption('mesh-0');
    await page.locator('#close-panel').click();
    await page.waitForTimeout(350);
    clip = await placeInsideMesh();
    const selected = await page.screenshot({clip});
    await label.evaluate(element => {element.style.visibility='hidden';});
    const selectedHidden = await page.screenshot({clip});
    assert.notDeepEqual(selected, selectedHidden, 'the selected label must paint in front of geometry');
  } finally { await page.close(); }
});

test('selecting a group member lifts only its label and group caption', async () => {
  const fixture=structuredClone(scene);
  fixture.meshes.push({...fixture.meshes[1],name:'Other',label:{text:'Other'}});
  fixture.meshes[1].label={text:'Mesh two'};
  fixture.state.selected=2;
  const page=await openPage({width:1280,height:800},0,fixture);
  try {
    const layer=()=>page.evaluate(()=>({
      captions:[...document.querySelectorAll('.mesh-label-foreground .mesh-group-label')].map(el=>el.textContent),
      members:[...document.querySelectorAll('.mesh-label-foreground .mesh-label')].filter(el=>!el.hidden).map(el=>el.textContent),
      frames:document.querySelectorAll('.mesh-label-foreground .mesh-group-frame').length,
      hiddenMembers:[...document.querySelectorAll('.mesh-label-layer:not(.mesh-label-foreground) .mesh-label')].map(el=>({text:el.textContent,hidden:el.hidden})),
    }));
    assert.equal((await layer()).captions.length,0);
    for(const index of [0,1,2]) {
      await page.locator('.panel-trigger').click();await page.locator('#detail-mesh-select').selectOption(`mesh-${index}`);await page.locator('#close-panel').click();
      await page.waitForTimeout(100);
      const state=await layer();assert.equal(state.frames,0);
      assert.deepEqual(state.members,[["Mesh one"],["Mesh two"],["Other"]][index]);
      assert.equal(state.captions.length,index<2?1:0);
      if(index<2){
        assert.equal(await page.locator('.mesh-group-label.selected').evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'),false);
        assert.ok(state.hiddenMembers.every(member=>member.text==='Other'||member.hidden));
      }
    }
  } finally {await page.close();}
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
      await page.locator('#detail-mesh-select').selectOption('mesh-3');
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

const surfaceFixture = () => ({
  ...structuredClone(scene), label_groups: [],
  meshes: scene.meshes.map((mesh, i) => ({...mesh, visible: i === 0, label:null})),
  state: {...structuredClone(scene.state), strokes: [], annotations: [], axes: false,
    camera: {position:[0.3,0.3,3],target:[0.3,0.3,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:2}},
});
async function captureShare(page) {
  await page.locator('#share-view').click(); await page.locator('#share-sheet').waitFor({state:'visible'});
  const snapshot = structuredClone(shared); await page.locator('#close-share').click(); return snapshot;
}

test('surface points and paths survive touch editing, navigation and share reopening', async () => {
  const page = await openPage({width:390,height:844}, 0, surfaceFixture());
  try {
    await page.locator('#brush-tool').click();
    await page.locator('#surface-input').waitFor({state:'visible'});
    const touch = await page.context().newCDPSession(page);
    const tap = async (x,y) => {
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    };
    await tap(195,400);
    let snapshot = await captureShare(page);
    assert.equal(snapshot.state.annotations.length,1);
    assert.equal(snapshot.state.annotations[0].kind,'point');
    const firstPoint = structuredClone(snapshot.state.annotations[0]);
    await page.locator('#surface-undo').click();
    assert.equal((await captureShare(page)).state.annotations.length,0);
    await page.locator('#surface-redo').click();
    assert.deepEqual((await captureShare(page)).state.annotations[0],firstPoint);
    // A cancelled touch never commits a moved point.
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:400}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:205,y:405}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    assert.deepEqual((await captureShare(page)).state.annotations[0],firstPoint);
    await page.locator('[data-surface-mode="line"]').click();
    await tap(165,420); await tap(170,385); await tap(190,355);
    await page.locator('#surface-end').click();
    snapshot = await captureShare(page);
    assert.equal(snapshot.state.annotations.length,2);
    assert.ok(snapshot.state.annotations[1].points.length > 3);
    assert.deepEqual(snapshot.state.camera,(await captureShare(page)).state.camera);
    await page.locator('[data-surface-mode="select"]').click();
    await page.mouse.move(200,420); await page.mouse.down(); await page.mouse.move(240,460,{steps:8}); await page.mouse.up();
    const rotated = await captureShare(page);
    assert.notDeepEqual(rotated.state.camera,snapshot.state.camera);
    assert.deepEqual(rotated.state.annotations,snapshot.state.annotations);
    const fixture=surfaceFixture(); fixture.state=rotated.state;
    fixture.meshes=fixture.meshes.map((m,i)=>({...m,...rotated.meshes[i]}));
    const reopened=await openPage({width:390,height:844},0,fixture);
    try { assert.deepEqual((await captureShare(reopened)).state.annotations,snapshot.state.annotations); }
    finally { await reopened.close(); }
  } finally { await page.close(); }
});

test('selection supports camera gestures and the inline color palette fits a narrow toolbar', async () => {
  const page=await openPage({width:320,height:700},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();
    assert.equal(await page.locator('#surface-navigate').count(),0);
    assert.equal(await page.locator('#surface-color-toggle').count(),0);
    assert.equal(await page.locator('[data-surface-color]:visible').count(),4);
    const palette=await page.locator('.surface-colors').boundingBox();const toolbar=await page.locator('#surface-toolbar').boundingBox();
    assert.ok(palette.x>=toolbar.x && palette.x+palette.width<=toolbar.x+toolbar.width);
    await page.locator('[data-surface-color="#ffc857"]').click();await page.mouse.click(160,340);
    await page.locator('[data-surface-mode="select"]').click();
    const before=await captureShare(page);assert.equal(before.state.annotations[0].color,'#ffc857');
    await page.mouse.move(55,240);await page.mouse.down();await page.mouse.move(90,265,{steps:8});await page.mouse.up();
    const rotated=await captureShare(page);assert.notDeepEqual(rotated.state.camera,before.state.camera);assert.deepEqual(rotated.state.annotations,before.state.annotations);
    const touch=await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:40,y:230,id:0},{x:100,y:230,id:1}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:25,y:225,id:0},{x:120,y:240,id:1}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const scaled=await captureShare(page);assert.notDeepEqual(scaled.state.camera,rotated.state.camera);assert.deepEqual(scaled.state.annotations,before.state.annotations);
  } finally {await page.close();}
});

test('selection recovers after an outside release and cancels a mixed edit-touch gesture', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.mouse.click(195,400);
    await page.locator('[data-surface-mode="select"]').click();
    const box=await page.locator('#surface-toolbar').boundingBox();
    await page.mouse.move(box.x+20,box.y-10);await page.mouse.down();
    await page.mouse.move(box.x+20,box.y+20,{steps:8});await page.mouse.up();
    const anchor=await page.locator('.surface-badge-leader').evaluate(el=>({x:Number(el.getAttribute('x1')),y:Number(el.getAttribute('y1'))}));
    await page.locator('[data-surface-mode="select"]').click();await page.mouse.click(anchor.x,anchor.y);
    assert.equal(await page.locator('#surface-name').isVisible(),true,'outside release must not leave camera ownership stuck');
    const before=await captureShare(page);
    const touch=await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:anchor.x,y:anchor.y,id:0}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:anchor.x,y:anchor.y,id:0},{x:anchor.x+50,y:anchor.y,id:1}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:anchor.x-10,y:anchor.y-10,id:0},{x:anchor.x+70,y:anchor.y+10,id:1}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const after=await captureShare(page);assert.deepEqual(after.state.annotations,before.state.annotations);assert.deepEqual(after.state.camera,before.state.camera);
    await page.mouse.move(50,280);await page.mouse.down();await page.mouse.move(80,305,{steps:8});await page.mouse.up();
    assert.notDeepEqual((await captureShare(page)).state.camera,before.state.camera);
  } finally {await page.close();}
});

test('surface editor fits narrow screens and line closure can be undone', async () => {
  const page = await openPage({width:320,height:700},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click(); await page.locator('#surface-input').waitFor({state:'visible'});
    await page.locator('[data-surface-mode="line"]').click();
    for(const [x,y] of [[150,340],[190,325],[175,290]]) await page.mouse.click(x,y);
    await page.locator('#surface-close').click();
    let snapshot=await captureShare(page); const line=snapshot.state.annotations[0];
    assert.equal(line.closed,true);assert.deepEqual(line.points[0],line.points.at(-1));
    const controls=await page.locator('#surface-toolbar button:visible, #surface-toolbar input:visible').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,height:r.height};}));
    assert.ok(controls.every(r=>r.x>=0 && r.right<=320 && r.y>=0 && r.bottom<=700 && r.height>=40));
    await page.locator('#surface-undo').click();snapshot=await captureShare(page);
    assert.equal(snapshot.state.annotations[0].closed,false);
    // Sharing a one-point draft cancels it instead of emitting an invalid line.
    await page.locator('[data-surface-mode="line"]').click();await page.mouse.click(125,355);
    assert.equal((await captureShare(page)).state.annotations.length,1);
  } finally { await page.close(); }
});

test('a continuous surface stroke is one undo step and uses sparse editing handles', async () => {
  const page = await openPage({width:390,height:844},0,surfaceFixture());
  try {
    const before = await captureShare(page);
    await page.locator('#brush-tool').click();await page.locator('#surface-input').waitFor({state:'visible'});
    await page.locator('[data-surface-mode="line"]').click();
    await page.mouse.move(155,435);await page.mouse.down();
    for(const [x,y] of [[164,420],[171,403],[183,390],[198,378],[207,365]]) await page.mouse.move(x,y,{steps:3});
    await page.mouse.up();
    const drawn=await captureShare(page);const line=drawn.state.annotations[0];
    assert.equal(drawn.state.annotations.length,1);assert.ok(line.points.length>20);
    assert.ok(line.controls.length<line.points.length/3);assert.deepEqual(drawn.state.camera,before.state.camera);
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.annotations.length,0);
    await page.locator('#surface-redo').click();assert.deepEqual((await captureShare(page)).state.annotations[0],line);
    // Select first; drawing tools always create a new stroke.
    await page.locator('[data-surface-mode="select"]').click();await page.mouse.click(207,365);
    // Move an existing endpoint along the same surface; undo recovers the frozen curve.
    await page.mouse.move(207,365);await page.mouse.down();await page.mouse.move(220,355,{steps:4});await page.mouse.up();
    const moved=(await captureShare(page)).state.annotations[0];assert.notDeepEqual(moved.points,line.points);
    await page.locator('#surface-undo').click();assert.deepEqual((await captureShare(page)).state.annotations[0],line);
  } finally { await page.close(); }
});

test('surface hits choose the visible mesh independently of the mesh selection', async () => {
  const fixture=surfaceFixture();fixture.meshes[0].visible=false;fixture.meshes[1].visible=true;
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    await page.locator('#brush-tool').click();
    assert.equal(await page.locator('#surface-target').count(),0);
    assert.equal(await page.locator('#surface-new').count(),0);
    await page.mouse.click(195,400);
    const snapshot=await captureShare(page);
    assert.equal(snapshot.state.annotations.length,1);assert.equal(snapshot.state.annotations[0].mesh,1);
    await page.locator('[data-surface-mode="select"]').click();
    await page.locator('.surface-badge').filter({hasText:'点 1'}).click();
    assert.equal(await page.locator('#surface-name').inputValue(),'点 1');
    await page.waitForFunction(()=>document.querySelector('.surface-badge.selected')?.textContent.includes('点 1'));
    await page.locator('#surface-done').click();await page.locator('.panel-trigger').click();
    await page.locator('#detail-mesh-select').selectOption('mesh-1');await page.locator('#mesh-visible-toggle').locator('..').click();
    await page.locator('#close-panel').click();await page.locator('#brush-tool').click();
    assert.equal(await page.locator('.surface-list-row').count(),0);
  } finally {await page.close();}
});

test('surface and screen strokes share tools, selection and undo history', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.mouse.click(195,400);
    await page.locator('#surface-brush').click();
    await page.mouse.move(60,200);await page.mouse.down();await page.mouse.move(130,230,{steps:12});await page.mouse.up();
    let snapshot=await captureShare(page);assert.equal(snapshot.state.annotations.length,1);assert.equal(snapshot.state.strokes.length,1);
    await page.locator('#surface-undo').click();snapshot=await captureShare(page);assert.equal(snapshot.state.strokes.length,0);assert.equal(snapshot.state.annotations.length,1);
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.annotations.length,0);
    await page.locator('#surface-redo').click();await page.locator('#surface-redo').click();
    await page.locator('[data-surface-mode="select"]').click();assert.equal(await page.locator('.surface-list-row').count(),2);
    await page.locator('.surface-badge').filter({hasText:'画笔 1'}).click();
    await page.waitForFunction(()=>document.querySelector('.surface-badge.selected')?.textContent.includes('画笔 1'));
    await page.locator('[data-surface-color="#5fb4ff"]').click();
    assert.equal((await captureShare(page)).state.strokes[0].color,'#5fb4ff');
    await page.locator('#surface-delete').click();assert.equal((await captureShare(page)).state.strokes.length,0);
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.strokes.length,1);
  } finally {await page.close();}
});

test('lifting the pointer completes a surface stroke and the next drag starts a new line', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="line"]').click();
    for(const [x,y,endX,endY] of [[155,435,190,380],[175,440,215,390]]) {
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(endX,endY,{steps:12});await page.mouse.up();
    }
    const snapshot=await captureShare(page);assert.equal(snapshot.state.annotations.length,2);
    assert.ok(snapshot.state.annotations.every(m=>m.kind==='line' && m.points.length>10));
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.annotations.length,1);
    await page.locator('[data-surface-mode="select"]').click();await page.mouse.click(190,380);
    assert.equal(await page.locator('.surface-list-row.selected').count(),1);
  } finally {await page.close();}
});

test('new point and line names remain editable after pointer release and share completion', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.mouse.click(195,400);
    const name=page.locator('#surface-name');
    assert.equal(await name.isVisible(),true);assert.equal(await name.inputValue(),'点 1');
    await page.waitForTimeout(250);assert.equal(await name.isVisible(),true);
    await name.fill('检查位置');await name.press('Tab');
    assert.equal((await captureShare(page)).state.annotations[0].label,'检查位置');
    await page.locator('[data-surface-mode="line"]').click();
    await page.mouse.move(155,435);await page.mouse.down();await page.mouse.move(190,380,{steps:12});await page.mouse.up();
    assert.equal(await name.isVisible(),true);assert.equal(await name.inputValue(),'线 1');
    await name.fill('检查路径');await name.press('Tab');
    assert.equal((await captureShare(page)).state.annotations[1].label,'检查路径');
    assert.equal(await name.isVisible(),true);
    // The next stroke starts another mark without an inert New action.
    await page.mouse.move(175,440);await page.mouse.down();await page.mouse.move(215,390,{steps:12});await page.mouse.up();
    assert.equal(await name.inputValue(),'线 2');assert.equal((await captureShare(page)).state.annotations.length,3);
    // Click-to-connect completion also keeps the name field available.
    await page.locator('[data-surface-mode="line"]').click();await page.mouse.click(165,420);await page.mouse.click(170,385);
    await page.locator('#surface-end').click();assert.equal(await name.isVisible(),true);
    await name.fill('连线路径');await name.press('Tab');assert.equal((await captureShare(page)).state.annotations[3].label,'连线路径');
  } finally {await page.close();}
});

test('annotation names stay on canvas and the list adapts to available space independently', async () => {
  const fixture=surfaceFixture();
  fixture.state.annotations=Array.from({length:11},(_,i)=>({id:`list-${i}`,mesh:0,revision:'fixture',kind:'point',label:`标记 ${i+1} · 参考位置`,color:'#ff6b5e',visible:true,closed:false,points:[[0.3+i*0.005,0.3,0.4-i*0.005]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}));
  for(const viewport of [{width:390,height:666},{width:320,height:568},{width:390,height:844},{width:600,height:360},{width:759,height:481},{width:900,height:600},{width:1024,height:768},{width:1280,height:800}]) {
    const page=await openPage(viewport,0,fixture);
    try {
      const roomy=viewport.width>=900 && viewport.height>=600;
      assert.equal(await page.locator('.surface-list').isVisible(),roomy);
      assert.equal(await page.locator('#surface-list-toggle').count(),0);
      assert.equal(await page.locator('#surface-toolbar').isVisible(),false);
      assert.equal(await page.locator('#surface-input').isVisible(),false);
      assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
      const before=await captureShare(page);
      if(viewport.width===390 && viewport.height===844) {
        const boxes=await page.locator('.surface-badge').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
        for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++) {
          const a=boxes[i],b=boxes[j];assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,JSON.stringify({i,j,a,b}));
        }
        for(const index of [0,5,10]) {
          await page.locator('.surface-badge').nth(index).click();
          assert.equal(await page.locator('#surface-name').inputValue(),`标记 ${index+1} · 参考位置`);
          await page.locator('#surface-done').click();
        }
      }
      if(roomy) {
        const bounds=await page.evaluate(()=>{const list=document.querySelector('.surface-list').getBoundingClientRect(),items=document.querySelector('#surface-items').getBoundingClientRect();return {bottom:list.bottom,itemsBottom:items.bottom,scrollable:document.querySelector('#surface-items').scrollHeight>document.querySelector('#surface-items').clientHeight};});
        assert.ok(bounds.itemsBottom<=bounds.bottom-7);assert.equal(bounds.scrollable,true);
        await page.locator('#surface-items').evaluate(el=>el.scrollTop=el.scrollHeight);
        await page.locator('.surface-list-row').last().locator('button').first().click();
        assert.equal(await page.locator('#surface-name').inputValue(),'标记 11 · 参考位置');
        await page.locator('#surface-list-close').click();
        assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
        assert.equal(await page.locator('#surface-name').inputValue(),'标记 11 · 参考位置');
        await page.locator('#surface-done').click();
      }
      await page.locator('.surface-badge').last().click();
      assert.equal(await page.locator('#surface-name').inputValue(),'标记 11 · 参考位置');
      if(viewport.width===390 && viewport.height===666) {
        await page.locator('#surface-name').focus();
        await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:320});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:24});visualViewport.dispatchEvent(new Event('resize'));});
        await page.waitForTimeout(100);
        assert.ok(await page.locator('#surface-toolbar').evaluate(el=>el.getBoundingClientRect().bottom<=344));
        assert.equal(await page.locator('.surface-list').isVisible(),false);
        await page.locator('#surface-name').blur();
        await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:innerHeight});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:0});visualViewport.dispatchEvent(new Event('resize'));});
      }
      await page.locator('#surface-done').click();
      for(const trigger of ['.panel-trigger','#scene-info-toggle']) {
        await page.locator(trigger).click();await page.waitForTimeout(100);
        assert.equal(await page.locator('.surface-list').isVisible(),false);
        assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
        await page.locator('#close-panel').click();
      }
      assert.deepEqual((await captureShare(page)).state.annotations,before.state.annotations);
    } finally {await page.close();}
  }
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    await page.setViewportSize({width:1280,height:800});
    // Resize and visualViewport events are asynchronous on CI runners.
    await page.locator('.surface-list').waitFor({state:'visible',timeout:10_000});
    await page.locator('#surface-list-close').click();
    await page.setViewportSize({width:390,height:844});await page.setViewportSize({width:1280,height:800});
    assert.equal(await page.locator('.surface-list').isVisible(),false);
    assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
  } finally {await page.close();}
});

test('a partly occluded path keeps its name on a visible sample', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=[{id:'around-edge',mesh:0,revision:'fixture',kind:'line',label:'绕面路径',color:'#ffc857',visible:true,closed:false,points:[[0.3,0.3,0.4],[0.3,0,0.3],[0.4,0.3,0.3]],normals:[[0.57735,0.57735,0.57735],[0,-1,0],[0.57735,0.57735,0.57735]],controls:[0,1,2]}];
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    assert.deepEqual(await page.locator('.surface-badge').allTextContents(),['绕面路径']);
    await page.locator('.surface-badge').click();assert.equal(await page.locator('#surface-name').inputValue(),'绕面路径');
  } finally {await page.close();}
});

test('annotation labels follow every rendered camera frame without replacing their DOM nodes', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=[{id:'tracked',mesh:0,revision:'fixture',kind:'point',label:'跟随位置',color:'#ff6b5e',visible:true,closed:false,points:[[0.3,0.3,0.4]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}];
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    await page.evaluate(()=>{
      window.trackedBadge=document.querySelector('.surface-badge');window.badgeFrames=[];window.badgeMoves=0;window.paintEvents=[];
      const style=window.trackedBadge.style;
      // Selection redraws can keep the same projection. Observe assignments,
      // not DOM mutations: browsers may elide identical CSS values entirely.
      Object.defineProperty(style,'transform',{
        get:()=>style.getPropertyValue('transform'),
        set:value=>{window.badgeFrames.push(window.paintFrame);if(value!==style.getPropertyValue('transform'))window.badgeMoves++;style.setProperty('transform',value);},
      });
    });
    await page.mouse.move(165,345);await page.mouse.down();await page.waitForTimeout(100);
    for(let i=1;i<=16;i++){await page.mouse.move(165+i,345+i/2);await page.waitForTimeout(20);}
    await page.mouse.up();
    const result=await page.evaluate(()=>({same:window.trackedBadge===document.querySelector('.surface-badge'),frames:window.badgeFrames,moves:window.badgeMoves,mesh:[...new Set(window.paintEvents.filter(e=>e.target==='mesh'&&e.type==='render').map(e=>e.frame))]}));
    assert.equal(result.same,true);assert.ok(result.mesh.length>=8,JSON.stringify(result));
    assert.ok(result.moves>=8,JSON.stringify(result));
    assert.ok(result.mesh.every(frame=>result.frames.includes(frame)),JSON.stringify(result));
  } finally {await page.close();}
});

test('opening detail and info preserves visible annotation badges, list and document', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=[{id:'named-point',mesh:0,revision:'fixture',kind:'point',label:'稳定标记',color:'#ff6b5e',visible:true,closed:false,points:[[0.3,0.3,0.4]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}];
  for(const viewport of [{width:320,height:700},{width:390,height:844},{width:1280,height:800},{width:740,height:420}]) {
    const page=await openPage(viewport,0,fixture);
    try {
      await page.waitForFunction(()=>document.querySelector('.surface-badge'));
      const before=await captureShare(page);
      for(const trigger of ['.panel-trigger','#scene-info-toggle']) {
        await page.locator(trigger).click();await page.waitForTimeout(300);
        assert.equal(await page.locator('.surface-list').isVisible(),viewport.width>=1256 && viewport.height>=600);
        assert.equal(await page.locator('.surface-badge').first().isVisible(),true);
        const boxes=await page.evaluate(()=>['.surface-list','#control-panel'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
        const [a,b]=boxes;assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,'panels must not overlap');
        await page.locator('#close-panel').click();
      }
      const after=await captureShare(page);assert.deepEqual(after.state.annotations,before.state.annotations);assert.deepEqual(after.state.camera,before.state.camera);
    } finally {await page.close();}
  }
});

test('zero opacity filters annotation list and restoring opacity recovers it', async () => {
  const fixture=surfaceFixture();fixture.meshes[0].opacity=0;
  fixture.state.annotations=[{id:'transparent-point',mesh:0,revision:'fixture',kind:'point',label:'位置',color:'#ff6b5e',visible:true,closed:false,points:[[0.3,0.3,0.4]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}];
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    assert.equal(await page.locator('.surface-list-row').count(),0);
    await page.locator('.panel-trigger').click();await page.locator('#opacity-range').fill('100');
    assert.equal(await page.locator('.surface-list-row').count(),1);
  } finally {await page.close();}
});

test('new marks refuse the scene sample limit before producing an invalid share', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=Array.from({length:4},(_,i)=>({id:`full-${i}`,mesh:0,revision:'fixture',kind:'line',label:`满 ${i}`,color:'#ff6b5e',visible:false,closed:false,points:Array.from({length:4096},()=>[0.3,0.3,0.4]),normals:Array.from({length:4096},()=>[0.57735,0.57735,0.57735]),controls:[0,4095]}));
  const page=await openPage({width:390,height:844},0,fixture);
  try {await page.locator('#brush-tool').click();await page.mouse.click(195,400);assert.equal((await captureShare(page)).state.annotations.length,4);} finally {await page.close();}
});

test('undo restores Raw geometry before restoring a deleted annotation', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.mouse.click(195,400);const original=(await captureShare(page)).state.annotations;
    await page.locator('#surface-delete').click();await page.locator('#surface-done').click();
    await page.locator('.panel-trigger').click();await page.locator('[data-quality="lod"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-quality="lod"]').classList.contains('active'));
    await page.locator('#close-panel').click();await page.locator('#brush-tool').click();
    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/mesh/0',async route=>{await gate;await route.fulfill({body:await readFile(new URL('../../tests/fixtures/tetra.ply',import.meta.url)),contentType:'application/ply'});});
    await page.locator('#surface-undo').click();await page.waitForFunction(()=>document.querySelector('#surface-hint').textContent.includes('恢复'));
    assert.equal(await page.locator('.surface-list').evaluate(el=>el.inert),true);
    assert.equal(await page.locator('[data-surface-color]').first().isDisabled(),true);
    assert.equal(await page.locator('#share-view').isDisabled(),true);release();
    await page.waitForFunction(()=>document.querySelectorAll('.surface-list-row').length===1);
    const restored=await captureShare(page);assert.equal(restored.meshes[0].quality,'raw');assert.deepEqual(restored.state.annotations,original);
  } finally {await page.close();}
});

test('a second touch during Raw loading cancels the pending gesture without corrupting it', async () => {
  const fixture=surfaceFixture();fixture.meshes[0].quality='lod';
  const page=await openPage({width:390,height:844},0,fixture);
  try {
    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/mesh/0',async route=>{await gate;await route.fulfill({body:await readFile(new URL('../../tests/fixtures/tetra.ply',import.meta.url)),contentType:'application/ply'});});
    await page.locator('#brush-tool').click();const touch=await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:400,id:1}]});
    await page.waitForFunction(()=>document.querySelector('#surface-hint').textContent.includes('准备'));
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:400,id:1},{x:160,y:380,id:2}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});release();
    await page.waitForTimeout(250);assert.equal((await captureShare(page)).state.annotations.length,0);
    await page.mouse.click(195,400);assert.equal((await captureShare(page)).state.annotations.length,1);
  } finally {await page.close();}
});

test('undo derives the restored draft target from its original mesh', async () => {
  const fixture=surfaceFixture();fixture.meshes[1].visible=true;
  fixture.state.camera={position:[0.3,0.3,5],target:[0.3,0.3,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:2};
  // Identical geometry is deliberate: swapping visibility lets the same pointer
  // hit another owner without changing camera or relying on projected heuristics.
  const page=await openPage({width:800,height:600},0,fixture);
  try {
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="line"]').click();
    await page.mouse.click(380,310);await page.mouse.click(400,290);await page.locator('#surface-end').click();
    // Apply actual visibility controls without exiting the annotation editor.
    await page.locator('.panel-trigger').dispatchEvent('click');
    await page.locator('#mesh-visible-toggle').locator('..').click();await page.locator('#close-panel').click();
    await page.mouse.click(400,300);
    await page.locator('#surface-undo').click();await page.locator('#surface-undo').click();
    await page.locator('.panel-trigger').dispatchEvent('click');await page.locator('#mesh-visible-toggle').locator('..').click();await page.locator('#close-panel').click();
    await page.mouse.click(400,290);await page.locator('#surface-end').click();
    const result=await captureShare(page);assert.equal(result.state.annotations.length,1);assert.equal(result.state.annotations[0].mesh,0);assert.ok(result.state.annotations[0].points.length>=2);
  } finally {await page.close();}
});

test('translated panels retain their separate world positions and attachment links', async () => {
  const shifted=structuredClone(scene);
  shifted.label_groups=[];
  shifted.meshes=shifted.meshes.map((m,i)=>({...m,translation:[i===0?-6:6,0,0],label:{text:i===0?'Left panel':'Right panel'},visible:true}));
  shifted.state.camera={position:[0,0,25],target:[0,0,0],up:[0,1,0],fov:50,zoom:1,orthographic_height:20};
  shifted.state.strokes=[];
  shifted.attachments=[{id:'log',label:'Run log',byte_size:12,url:'api/v1/scenes/fixture/attachments/0',unavailable:null}];
  shifted.warnings=[{code:'MISSING',message:'Missing historical artifact'}];
  const page=await openPage({width:1280,height:800},0,shifted);
  try {
    const left=await page.locator('.mesh-label').getByText('Left panel',{exact:true}).boundingBox();
    const right=await page.locator('.mesh-label').getByText('Right panel',{exact:true}).boundingBox();
    assert.ok(left && right && right.x-left.x>150,'labels must follow translated geometry');
    assert.equal(await page.locator('.scene-artifacts a').getAttribute('href'),'api/v1/scenes/fixture/attachments/0');
    assert.match(await page.locator('.scene-artifacts').textContent(),/Missing historical artifact/);
  } finally {await page.close();}
});


test('partial scenes show a persistent notice and semantic details', async () => {
  const partial=structuredClone(scene);
  partial.warnings=[{code:'ORDER_FAILED',message:'牙冠生成失败；显示已有产物。'}, {code:'RESOURCE_UNAVAILABLE',message:'人工颈缘：产物缺失'}];
  partial.attachments=[{id:'log',label:'运行日志',url:null,unavailable:'产物缺失'}];
  const page=await openPage({width:390,height:844},0,partial);
  try {
    assert.equal(await page.locator('#scene-notice').isVisible(),true);
    assert.match(await page.locator('#scene-notice').textContent(),/场景部分可用/);
    await page.locator('#scene-notice').click();
    assert.match(await page.locator('.scene-artifacts').textContent(),/牙冠生成失败；显示已有产物/);
    assert.match(await page.locator('.scene-artifacts').textContent(),/人工颈缘：产物缺失/);
    assert.match(await page.locator('.scene-artifacts').textContent(),/运行日志.*产物缺失/);
    assert.equal(await page.locator('.scene-artifacts a').count(),0);
    assert.equal(await page.locator('#detail-mesh-select option').first().textContent(),'Mesh one');
  } finally { await page.close(); }
});


test('all failed mesh downloads show unavailable instead of a partial scene', async () => {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  try {
    await page.route('**/mesh/**',route=>route.fulfill({status:503,body:'Unavailable'}));
    await page.goto(`${origin}/s/fixture`);
    await page.waitForSelector('#invalid-state:not([hidden])');
    assert.match(await page.locator('#invalid-state h2').textContent(),/暂时无法打开/);
    assert.equal(await page.locator('#scene-notice').isVisible(),false);
    assert.equal(await page.locator('#share-view').isVisible(),false);
  } finally { await page.close(); }
});


function planePly(size) {
  return `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 2
property list uchar int vertex_indices
end_header
${-size} ${-size} 0
${size} ${-size} 0
${size} ${size} 0
${-size} ${size} 0
3 0 1 2
3 0 2 3
`;
}

test('later meshes and curves respect real depth with another panel crossing camera depth', async () => {
  for (const projection of ['perspective','orthographic']) {
    const meshes=[planePly(5),planePly(5),planePly(2),planePly(5)];
    const fixtureScene={title:'Depth regression',owner:false,label_groups:[],meshes:meshes.map((data,i)=>({
      name:`Geometry ${i}`, format:i===2?'pts':'ply',revision:'fixture',byte_size:data.length,
      color:['#ff0000','#0000ff','#00ff00','#ffffff'][i],opacity:1,visible:true,quality:'raw',source_url:`/mesh/${i}`,
      translation:[[0,0,0],[0,0,-1],[0,0,-1],[100,0,40]][i],
    })),state:{...scene.state, selected:0,projection,strokes:[],camera:{position:[0,0,40],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:24}}};
    const page=await openPage({width:512,height:512},0,fixtureScene,meshes);
    try {
      const canvas=page.locator('#canvas-root canvas');
      const png=await canvas.screenshot();
      const leaked=await page.evaluate(async data=>{
        const image=new Image();image.src=data;await image.decode();
        const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
        const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
        const {data:p}=ctx.getImageData(c.width/2-12,c.height/2-12,24,24);
        let leaked=0;for(let i=0;i<p.length;i+=4)if(!(p[i]>p[i+1]*2&&p[i]>p[i+2]*2))leaked++;
        return leaked;
      },`data:image/png;base64,${png.toString('base64')}`);
      assert.equal(leaked,0,`${projection}: rear geometry covered the foreground`);
    } finally {await page.close();}
  }
});

test('flat scan back faces receive the same lighting as front faces', async () => {
  const front=planePly(5), back=front.replace('3 0 1 2\n3 0 2 3','3 2 1 0\n3 3 2 0');
  const values=[];
  for(const geometry of [front,back]) {
    const fixtureScene={...scene,label_groups:[],meshes:[{...scene.meshes[0],label:undefined,color:'#ffffff',quality:'raw'}],
      state:{...scene.state,strokes:[],camera:{position:[0,0,40],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:24}}};
    const page=await openPage({width:512,height:512},0,fixtureScene,[geometry]);
    try {
      const png=await page.locator('#canvas-root canvas').screenshot();
      values.push(await page.evaluate(async data=>{
        const image=new Image();image.src=data;await image.decode();
        const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
        const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
        return ctx.getImageData(c.width/2,c.height/2,1,1).data[0];
      },`data:image/png;base64,${png.toString('base64')}`));
    } finally {await page.close();}
  }
  assert.ok(values[0]>200);
  assert.ok(Math.abs(values[0]-values[1])<=1,`front/back lighting differs: ${values}`);
});
