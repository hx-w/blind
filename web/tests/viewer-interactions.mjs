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
async function clickDisplay(page) {
  if (await page.locator('.dock-observe').getAttribute('aria-hidden') === 'true') await page.locator('#observe-trigger').click();
  if (await page.locator('[data-observe-category="light"]').getAttribute('aria-expanded') === 'false') await page.locator('[data-observe-category="light"]').click();
}
async function selectSceneMesh(page, index) {
  const toggle = page.locator('#scene-tree-toggle');
  const wasOpen = await toggle.getAttribute('aria-expanded') === 'true';
  if (!wasOpen) await toggle.click();
  await page.locator('.scene-tree-row').nth(index).locator('.scene-tree-select').click();
  if (!wasOpen) await toggle.click();
}
async function sectionContourPair(page) {
  return page.locator('.section-plot').evaluate(canvas => {
    const {width,height} = canvas;
    const pixels = canvas.getContext('2d').getImageData(0,0,width,height).data;
    let left = null, right = null;
    for (let y=8;y<height-8;y+=2) for (let x=8;x<width-8;x+=2) {
      const offset = (y*width+x)*4;
      const [red,green,blue] = pixels.subarray(offset,offset+3);
      const blueContour = blue > 185 && blue > red+55 && blue > green+25;
      const amberContour = red > 220 && green > 140 && blue < 140;
      if (!blueContour && !amberContour) continue;
      if (!left || x<left.x) left={x,y};
      if (!right || x>right.x) right={x,y};
    }
    if (!left || !right || right.x-left.x<25) throw new Error(`No usable contour in the section plot: ${JSON.stringify({width,height,left,right})}`);
    const rect=canvas.getBoundingClientRect();
    return [left,right].map(point=>[rect.left+(point.x+.5)*rect.width/width,rect.top+(point.y+.5)*rect.height/height]);
  });
}
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

test('render tool and desktop copy shortcuts preserve inspection settings in shared links', async () => {
  const page = await openPage({width: 900, height: 700});
  const copyModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  try {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {
      write: async items => { window.writeStarted = true; window.copied = await (await items[0].getType('text/plain')).text(); },
      writeText: async value => { window.copied = value; },
    }}));
    await clickDisplay(page);
    assert.equal(await page.locator('[data-observe-mode="matte"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-observe-mode="raking"]').click();
    await page.locator('#light-azimuth').fill('-70');
    await page.locator('#light-elevation').fill('12');
    await page.locator('#light-intensity').fill('140');
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
      await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/render-tool.png`});
    }
    let update = await captureShare(page);
    assert.equal(update.state.render_mode, 'raking');
    assert.deepEqual(update.state.light, {azimuth: -70, elevation: 12, intensity: 1.4});
    let releaseShare;
    const shareGate = new Promise(resolve => { releaseShare = resolve; });
    await page.route('**/api/v1/scenes/*/share', async route => { await shareGate; await route.continue(); }, {times:1});
    await page.keyboard.press(`${copyModifier}+c`);
    assert.equal(await page.evaluate(() => window.writeStarted), true, 'clipboard write must start before the share request finishes');
    releaseShare();
    await page.waitForFunction(() => window.copied?.endsWith('/i/fixture.png'));
    await page.keyboard.press(`${copyModifier}+Shift+c`);
    await page.waitForFunction(() => window.copied?.endsWith('/s/fixture'));
    await clickDisplay(page);
    await page.locator('[data-observe-mode="normals"]').click();
    update = await captureShare(page);
    assert.equal(update.state.render_mode, 'normals');
    await page.locator('#scene-tree-toggle').click();
    await page.locator('.scene-tree-edit').first().click();
    await page.locator('.scene-tree-rename textarea:visible').fill('copy text');
    await page.locator('.scene-tree-rename textarea:visible').focus();
    await page.evaluate(() => { window.copied = 'unchanged'; });
    await page.keyboard.press(`${copyModifier}+c`);
    assert.equal(await page.evaluate(() => window.copied), 'unchanged');
    await page.setViewportSize({width: 390, height: 700});
    await page.locator('.scene-tree-rename textarea:visible').blur();
    await page.keyboard.press(`${copyModifier}+Shift+c`);
    await page.waitForFunction(() => window.copied?.endsWith('/s/fixture'));
    await clickDisplay(page);
    await page.locator('#observe-scene-trigger').click();
    assert.equal(await page.locator('#render-controls').isVisible(), true);
    const compactHeight = await page.locator('.review-dock').evaluate(element => element.getBoundingClientRect().height);
    if (process.env.BLIND_TEST_SCREENSHOTS) await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/render-tool-mobile.png`});
    await page.locator('[data-observe-category="light"]').click();
    await page.locator('[data-observe-mode="raking"]').click();
    assert.equal(await page.locator('#light-controls').isVisible(), true);
    assert.equal(await page.locator('[data-observe-mode="raking"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-observe-mode="normals"]').getAttribute('aria-pressed'), 'false');
    await page.waitForTimeout(280);
    const lightHeight = await page.locator('.review-dock').evaluate(element => element.getBoundingClientRect().height);
    assert.ok(lightHeight > compactHeight + 80);
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await page.waitForTimeout(200);
      await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/render-light-mobile.png`});
    }
    await page.evaluate(() => {
      window.copied = 'mobile untouched';
      Object.defineProperty(navigator, 'userAgent', {configurable:true,value:`${navigator.userAgent} Mobile`});
    });
    await page.keyboard.press(`${copyModifier}+c`);
    assert.equal(await page.evaluate(() => window.copied), 'mobile untouched');
  } finally { await page.close(); }
});

test('the latest copy shortcut wins when share requests finish out of order', async () => {
  const page = await openPage({width:900,height:700});
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  let calls = 0;
  let firstIntercept;
  const firstIntercepted = new Promise(resolve => { firstIntercept = resolve; });
  let thirdIntercept;
  const thirdIntercepted = new Promise(resolve => { thirdIntercept = resolve; });
  try {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
      write: async items => { window.copied = await (await items[0].getType('text/plain')).text(); },
    }}));
    await page.route('**/api/v1/scenes/*/share', async route => {
      const order = ++calls;
      if (order === 1) firstIntercept();
      if (order === 3) thirdIntercept();
      await new Promise(resolve => setTimeout(resolve, order === 1 || order === 3 ? 300 : 20));
      await route.fulfill({json:{viewer_url:`${origin}/s/${order}`,image_url:`${origin}/i/${order}.png`,origin,hosts:[]}});
    });
    await page.keyboard.press(`${modifier}+c`);
    await firstIntercepted;
    await page.keyboard.press(`${modifier}+Shift+c`);
    await page.waitForFunction(expected => window.copied === expected, `${origin}/s/2`);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.copied), `${origin}/s/2`);
    assert.equal(calls, 2);
    await page.locator('#share-view').click();
    await thirdIntercepted;
    await page.keyboard.press(`${modifier}+c`);
    await page.waitForFunction(expected => window.copied === expected, `${origin}/i/4.png`);
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#share-sheet').evaluate(element => element.open), false, 'a stale share request must not open the sheet');
    assert.equal(calls, 4);
  } finally { await page.close(); }
});

test('raking light resolves shallow bumps and pits from either direction', async () => {
  const count = 81, vertices = [], faces = [];
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    const x = col * 2 / (count - 1) - 1, y = row * 2 / (count - 1) - 1;
    const bump = Math.exp(-((x + .42) ** 2 + y ** 2) / .035);
    const pit = Math.exp(-((x - .42) ** 2 + y ** 2) / .035);
    vertices.push(`${x} ${y} ${(.06 * (bump - pit)).toFixed(6)}`);
  }
  for (let row = 0; row < count - 1; row++) for (let col = 0; col < count - 1; col++) {
    const a = row * count + col, b = a + 1, c = a + count, d = c + 1;
    faces.push(`3 ${a} ${b} ${d}`, `3 ${a} ${d} ${c}`);
  }
  const ply = `ply\nformat ascii 1.0\nelement vertex ${vertices.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n${vertices.join('\n')}\n${faces.join('\n')}\n`;
  const data = structuredClone(scene);
  data.meshes = [{...data.meshes[0],name:'Relief',label:null,color:'#b8b8b8',byte_size:Buffer.byteLength(ply)}];
  data.label_groups = []; data.state = {...data.state,shading:'flat',strokes:[],camera:{position:[0,0,4],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:3}};
  const page = await openPage({width:800,height:800},0,data,[ply]);
  const measure = async name => {
    const png = await page.screenshot();
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS,{recursive:true});
      const {writeFile} = await import('node:fs/promises');
      await writeFile(`${process.env.BLIND_TEST_SCREENSHOTS}/relief-${name}.png`,png);
    }
    return page.evaluate(async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image,0,0);
      const region = context.getImageData(Math.round(image.width * .25),Math.round(image.height * .35),Math.round(image.width * .5),Math.round(image.height * .3));
      const pixels = region.data, values = [];
      for (let i=0;i<pixels.length;i+=4) {
        const value = (pixels[i]+pixels[i+1]+pixels[i+2])/3;
        values.push(value);
      }
      const mean = values.reduce((sum,value)=>sum+value,0)/values.length;
      return {mean, contrast: Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/values.length)};
    },`data:image/png;base64,${png.toString('base64')}`);
  };
  try {
    const matte = await measure('matte');
    await clickDisplay(page);
    await page.locator('[data-observe-mode="raking"]').click();
    await page.locator('#light-azimuth').fill('0');
    await page.waitForTimeout(300);
    const east = await measure('east');
    await clickDisplay(page);
    await page.locator('#light-azimuth').fill('180');
    await page.waitForTimeout(300);
    const west = await measure('west');
    assert.ok(east.contrast > matte.contrast * 1.8, `east light must expose relief: ${JSON.stringify({matte,east})}`);
    assert.ok(west.contrast > matte.contrast * 1.8, `west light must expose relief: ${JSON.stringify({matte,west})}`);
    assert.ok(Math.abs(east.mean - west.mean) > 1, 'moving the light must change the relief image');
    await page.locator('[data-observe-category="shading"]').click();
    await page.locator('[data-shading="wire"]').click();
    await page.waitForTimeout(300);
    const wire = await measure('wire');
    assert.ok(wire.mean < east.mean * .8, 'wireframe must remain visible under raking light');
  } finally { await page.close(); }
});

test('observation toolbar opens a selected-entity section and shares the read-only plane', async () => {
  const page = await openPage({width:390,height:844});
  try {
    await page.locator('#observe-trigger').click();
    assert.equal(await page.locator('.dock-main').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('.dock-observe').getAttribute('aria-hidden'), 'false');
    await page.locator('#section-trigger').click();
    assert.equal(await page.locator('.section-panel').isVisible(), false, 'section starts with a line gesture');
    await page.locator('#section-trigger').click();
    assert.equal(await page.locator('.section-draw-overlay').isVisible(), false, 'second click closes drawing mode');
    await page.locator('#section-trigger').click();
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:120,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:124,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    assert.equal(await page.locator('.section-draw-overlay').isVisible(),true,'a short line leaves drawing ready for retry');
    await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:120,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:260,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await page.locator('.section-panel').waitFor({state:'visible'});
    await page.waitForTimeout(250);
    if (process.env.BLIND_TEST_SCREENSHOTS) await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/section-mobile-current.png`});
    assert.match(await page.locator('.section-status').textContent(), /段截线/);
    assert.deepEqual((await captureShare(page)).state.section.targets.map(target => target.mesh),[0,1],
      'a new section includes every visible triangle Mesh by default');
    assert.equal(await page.locator('.section-scope-count').textContent(),'2/2');
    await page.locator('.section-panel header button').first().click();
    await page.locator('.section-scope input[data-mesh="1"]').uncheck();
    assert.deepEqual((await captureShare(page)).state.section.targets.map(target => target.mesh),[0],
      'the picker can isolate the anchor Mesh');
    await page.locator('.section-scope input[data-mesh="1"]').check();
    const combined = (await captureShare(page)).state.section;
    assert.deepEqual(combined.targets.map(target => target.mesh), [0,1], 'one plane includes two explicit Mesh targets');
    assert.match(await page.locator('.section-status').textContent(), /个 Mesh 相交/);
    await page.locator('.section-scope input[data-mesh="0"]').uncheck();
    assert.deepEqual((await captureShare(page)).state.section.targets.map(target => target.mesh), [1], 'targets can exclude the original anchor Mesh');
    await page.locator('.section-scope input[data-mesh="0"]').check();
    await page.locator('.section-scope input[data-mesh="1"]').uncheck();
    await page.locator('.section-panel header button').first().click();
    const before = await page.locator('.section-status').textContent();
    const tree = page.locator('#scene-tree-toggle');
    if (await tree.getAttribute('aria-expanded') !== 'true') await tree.click();
    await page.locator('.scene-tree-row').nth(1).locator('.scene-tree-visibility').click();
    assert.equal(await page.locator('.section-status').textContent(), before, 'other entities must not contribute to this section');
    await tree.click();
    const state = (await captureShare(page)).state.section;
    assert.equal(state.entity_id, 'mesh-0');
    assert.equal(state.mesh, 0);
    assert.equal(state.revision, 'fixture');
    assert.ok(state.radius > 0);
    assert.equal(await page.locator('.section-panel').isVisible(), true, 'returning to the main dock keeps the section ready to share');
    await page.locator('button[aria-label="放大剖面"]').click();
    const zoomed = (await captureShare(page)).state.section;
    assert.ok(zoomed.radius < state.radius, 'zoom changes the shared section view');
    const plot = await page.locator('.section-plot').boundingBox();
    const zoomAt = {x:plot.x+plot.width*.65,y:plot.y+plot.height*.42};
    const planeAt = (section, point) => {
      const scale = Math.min((plot.width-32)/(section.radius*2),(plot.height-32)/(section.radius*2));
      return [section.pan[0]+(point.x-plot.x-plot.width/2)/scale,
        section.pan[1]-(point.y-plot.y-plot.height/2)/scale];
    };
    await page.mouse.move(zoomAt.x,zoomAt.y);
    await page.mouse.wheel(0,-150);
    const wheelZoomed = (await captureShare(page)).state.section;
    assert.ok(wheelZoomed.radius < zoomed.radius);
    const anchorBefore = planeAt(zoomed,zoomAt), anchorAfter = planeAt(wheelZoomed,zoomAt);
    assert.ok(Math.hypot(anchorBefore[0]-anchorAfter[0],anchorBefore[1]-anchorAfter[1]) < 1e-3,
      'wheel zoom keeps the point under the cursor stationary within a screen pixel');
    await page.mouse.move(plot.x + plot.width * .4, plot.y + plot.height * .5);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * .6, plot.y + plot.height * .5, {steps:5});
    await page.mouse.up();
    const panned = (await captureShare(page)).state.section;
    assert.ok(Math.abs(panned.pan[0]) > 0, 'plot dragging is saved with the section');
    await page.getByRole('button',{name:'全幅显示剖面'}).click();
    await page.locator('button[aria-label^="测量剖面距离"]').click();
    await page.mouse.click(plot.x + 8, plot.y + 8);
    await page.mouse.click(plot.x + plot.width - 8, plot.y + 8);
    assert.equal((await captureShare(page)).state.section.measurements.length,0,'empty plot does not create a geometry measurement');
    if (process.env.BLIND_TEST_SCREENSHOTS) await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/section-before-measure.png`});
    const [firstContour,secondContour] = await sectionContourPair(page);
    await page.mouse.click(...firstContour);
    await page.mouse.click(...secondContour);
    const measured = (await captureShare(page)).state.section;
    assert.equal(measured.measurements.length, 1, 'measurement anchors are shared in plane coordinates');
    assert.ok(Math.hypot(measured.measurements[0].b[0]-measured.measurements[0].a[0], measured.measurements[0].b[1]-measured.measurements[0].a[1]) > 0);
    await page.mouse.move(plot.x+plot.width*.4,plot.y+plot.height*.5);
    await page.mouse.down({button:'right'});
    await page.mouse.move(plot.x+plot.width*.5,plot.y+plot.height*.5,{steps:4});
    await page.mouse.up({button:'right'});
    const rightPanned = (await captureShare(page)).state.section;
    assert.notDeepEqual(rightPanned.pan,measured.pan,'right drag pans while the ruler is active');
    assert.equal(rightPanned.measurements.length,1,'panning preserves the ruler');
    const touchA = {x:plot.x+plot.width*.4,y:plot.y+plot.height*.5,id:0};
    const touchB = {x:plot.x+plot.width*.6,y:plot.y+plot.height*.5,id:1};
    await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[touchA,touchB]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[
      {...touchA,x:plot.x+plot.width*.3},{...touchB,x:plot.x+plot.width*.7}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    const pinched = (await captureShare(page)).state.section;
    assert.ok(pinched.radius < rightPanned.radius,'two fingers pinch zoom while measuring');
    assert.equal(pinched.measurements.length,1,'pinching preserves the ruler');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.section-panel').isVisible(),true,'Escape leaves the section window open');
    assert.equal(await page.locator('button[aria-label^="测量剖面距离"]').getAttribute('aria-pressed'),'false');
    assert.equal((await captureShare(page)).state.section.measurements.length,0,'Escape clears ruler lines');
    await page.getByRole('button',{name:'全幅显示剖面'}).click();
    await page.locator('button[aria-label^="测量剖面距离"]').click();
    const [nextFirst,nextSecond] = await sectionContourPair(page);
    await page.mouse.click(...nextFirst);
    await page.mouse.click(...nextSecond);
    assert.equal((await captureShare(page)).state.section.measurements.length,1);
    const beforeResize = await page.locator('.section-plot').boundingBox();
    const handle = await page.locator('.section-resize-handle').boundingBox();
    const hx = handle.x + handle.width / 2, hy = handle.y + handle.height / 2;
    await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:hx,y:hy}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:hx,y:hy-88}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    const afterResize = await page.locator('.section-plot').boundingBox();
    assert.ok(afterResize.height > beforeResize.height + 60, 'dragging the handle expands the 2D viewport');
    assert.ok((await captureShare(page)).state.section.panel_size[1] > beforeResize.height + 60);
    await page.locator('button[aria-label="重新划线"]').click();
    await touch.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:120,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:260,y:400}]});
    await touch.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await page.locator('.section-draw-overlay').waitFor({state:'hidden'});
    const drawn = (await captureShare(page)).state.section;
    assert.equal(drawn.entity_id, 'mesh-0');
    assert.equal(drawn.fit, true, 'touch line initially fits the entire contour');
    assert.equal(drawn.measurements?.length ?? 0, 0, 'redrawing clears stale measurements');
    assert.ok(drawn.radius > 0);
    await page.locator('#observe-trigger').click();
    await page.locator('#section-trigger').click();
    assert.equal((await captureShare(page)).state.section, null);
  } finally {await page.close();}
});

test('JSON component selects on click and opens on double click without resize or fullscreen controls', async () => {
  const data = structuredClone(scene); data.label_groups = []; data.state.strokes = [];
  data.meshes = data.meshes.slice(0, 1);
  data.attachments = [{id:'json',label:'Report',byte_size:40,url:'/test/attachments/0',unavailable:null}];
  data.components = [
    {id:'mesh',component:'mesh',source:{kind:'mesh',index:0},label:'Mesh',group:null,position:[0,0,0],size:null,visible:true,opacity:1},
    {id:'report',component:'json',source:{kind:'attachment',index:0},label:'Report',group:null,position:[40,0,0],size:[40,32],visible:true,opacity:1},
  ];
  const page = await browser.newPage({viewport:{width:900,height:700}});
  try {
    await page.route('**/api/v1/scenes/**', route => route.request().method() === 'GET' ? route.fulfill({json:data}) : route.continue());
    await page.route('**/test/attachments/*', route => route.fulfill({contentType:'application/json',body:JSON.stringify({quality:{gaps:2,valid:true},note:'x'.repeat(3000)})}));
    await page.goto(`${origin}/s/fixture`);
    await page.locator('#loading-state').waitFor({state:'hidden'});
    const surface = page.locator('[data-component="json"]');
    const preview = surface.locator('.component-enter');
    assert.equal(await surface.locator('.json-key').nth(1).textContent(), 'quality: ');
    assert.match(await surface.locator('.json-string').textContent(), /3000 字符/);
    assert.ok((await surface.locator('.json-string').textContent()).length < 2100);
    assert.equal(await surface.locator('.component-resize').count(), 0);
    assert.equal(await surface.getByRole('button',{name:'全屏'}).count(), 0);
    await surface.locator('.component-handle').click();
    assert.equal(await page.locator('.component-dialog').evaluate(node => node.open), false);
    assert.equal(await surface.evaluate(node => node.classList.contains('selected')), true);
    await preview.click();
    assert.equal(await page.locator('.component-dialog').evaluate(node => node.open), false);
    assert.equal(await surface.evaluate(node => node.classList.contains('selected')), true);
    await page.locator('#scene-tree-toggle').click();
    await page.locator('.scene-tree-edit').nth(1).click();
    await page.locator('.scene-tree-rename textarea:visible').fill('检验报告');
    await page.locator('.scene-tree-rename textarea:visible').press('Enter');
    await page.locator('#scene-tree-toggle').click();
    assert.equal(await surface.locator('.component-handle > span').textContent(), '检验报告');
    assert.equal((await captureShare(page)).entities.find(entity => entity.id === 'report').label, '检验报告');
    await preview.dblclick();
    assert.equal(await page.locator('.component-dialog').evaluate(node => node.open), true);
    assert.equal(await page.locator('.component-dialog').getByRole('button',{name:'全屏'}).count(), 0);
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
      await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/json-component.png`});
    }
  } finally { await page.close(); }
});

test('large JSON uses a bounded preview with a link to the original file', async () => {
  const data = structuredClone(scene); data.meshes = []; data.label_groups = []; data.state.strokes = [];
  data.attachments = [{id:'large',label:'Large report',byte_size:4 * 1024 * 1024 + 100,url:'/test/attachments/0',unavailable:null}];
  data.components = [{id:'large',component:'json',source:{kind:'attachment',index:0},label:'Large report',group:null,
    position:[0,0,0],size:[80,50],visible:true,opacity:1}];
  const page = await browser.newPage({viewport:{width:900,height:700}});
  try {
    await page.route('**/api/v1/scenes/**', route => route.request().method() === 'GET' ? route.fulfill({json:data}) : route.continue());
    await page.route('**/test/attachments/*', route => route.fulfill({contentType:'application/json',body:JSON.stringify({data:'x'.repeat(4 * 1024 * 1024)})}));
    await page.goto(`${origin}/s/fixture`);
    await page.locator('#loading-state').waitFor({state:'hidden'});
    const link = page.locator('[data-component="json"] .component-json a');
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), '/test/attachments/0');
    assert.match(await page.locator('.component-json .json-status').textContent(), /无法在预览中展开/);
  } finally { await page.close(); }
});

test('JSON preview creates branches on demand and pages large arrays', async () => {
  const data = structuredClone(scene); data.meshes = []; data.label_groups = []; data.state.strokes = [];
  data.attachments = [{id:'json',label:'Large array',byte_size:60000,url:'/test/attachments/0',unavailable:null}];
  data.components = [{id:'json',component:'json',source:{kind:'attachment',index:0},label:'Large array',group:null,
    position:[0,0,0],size:[80,50],visible:true,opacity:1}];
  const page = await browser.newPage({viewport:{width:900,height:700}});
  try {
    await page.route('**/api/v1/scenes/**', route => route.request().method() === 'GET' ? route.fulfill({json:data}) : route.continue());
    await page.route('**/test/attachments/*', route => route.fulfill({contentType:'application/json',body:JSON.stringify({rows:Array.from({length:10000},(_,i) => ({index:i}))})}));
    await page.goto(`${origin}/s/fixture`);
    await page.locator('#loading-state').waitFor({state:'hidden'});
    const tree = page.locator('.component-json .json-tree');
    await tree.waitFor();
    assert.ok(await tree.locator('.json-node').count() <= 2);
    await page.locator('[data-component="json"] .component-enter').dblclick();
    const dialogTree = page.locator('.component-dialog .json-tree');
    await dialogTree.waitFor();
    await dialogTree.locator('details').nth(1).evaluate(node => { node.open = true; });
    await dialogTree.locator('.json-more').waitFor();
    assert.ok(await dialogTree.locator('.json-node').count() <= 102);
    await dialogTree.locator('.json-more').click();
    assert.ok(await dialogTree.locator('.json-node').count() <= 202);
  } finally { await page.close(); }
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
      assert.equal(await page.locator('.review-dock #share-view').count(), 1, 'single-scene sharing belongs in the shared toolbar');
      const dock = await page.locator('.review-dock').boundingBox();
      assert.ok(dock.x >= 0 && dock.x + dock.width <= viewport.width, 'the dock must fit the viewport');
      for (const selector of ['#scene-tree-toggle','#brush-tool','#surface-brush','#surface-done','#fit-view','#observe-trigger','#observe-back']) {
        const events = await eventsDuring(page, () => page.locator(selector).click());
        assert.equal(events.filter(e=>e.type==='resize').length, 0, `${selector} cleared a scene canvas`);
        if (selector === '#observe-trigger') assert.equal(await page.locator('.dock-observe').getAttribute('aria-hidden'), 'false', 'observe trigger must activate the secondary dock');
      }
      assert.equal(await page.locator('.review-dock #share-view').count(), 1, 'sharing returns to the regular toolbar after editing');
      if (process.env.BLIND_TEST_SCREENSHOTS) {
        if (await page.locator('#scene-tree-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#scene-tree-toggle').click();
        await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
        await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/${viewport.width}x${viewport.height}.png`});
        await page.locator('#scene-tree-toggle').click();
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

test('per-entity opacity and visibility preserve their values and shared state', async () => {
  const page = await openPage({width:390,height:844});
  try {
    await page.locator('#scene-tree-toggle').click();
    const first = page.locator('.scene-tree-row').first();
    const second = page.locator('.scene-tree-row').nth(1);
    const slider = first.locator('.scene-tree-opacity');
    const toggle = first.locator('.scene-tree-visibility');
    const geometry = await page.evaluate(() => {
      const a=document.querySelector('.scene-tree-row .scene-tree-opacity').getBoundingClientRect();
      const b=document.querySelector('.scene-tree-row .scene-tree-visibility').getBoundingClientRect();
      return {delta:Math.abs((a.top+a.bottom)/2-(b.top+b.bottom)/2), gap:b.left-a.right,width:a.width};
    });
    assert.ok(geometry.delta < 8 && geometry.gap >= 0 && geometry.width >= 70, 'slider and visibility must fit the same row');
    assert.equal(await page.locator('#opacity-range').count(), 0, 'the detail panel no longer duplicates opacity');
    await slider.fill('37');
    assert.equal(await slider.getAttribute('aria-valuetext'),'37%');
    await toggle.click();
    assert.equal(await toggle.getAttribute('data-visible'),'false');
    assert.equal(await slider.inputValue(),'37');
    assert.equal(await second.locator('.scene-tree-visibility').getAttribute('data-visible'),'true');
    // The eye button is keyboard operable and restores the previous opacity.
    await toggle.focus(); await page.keyboard.press('Space'); assert.equal(await toggle.getAttribute('data-visible'),'true');
    await page.keyboard.press('Space'); assert.equal(await toggle.getAttribute('data-visible'),'false');
    await slider.fill('0'); assert.equal(await toggle.getAttribute('data-visible'),'false');
    await toggle.click(); assert.equal(await slider.inputValue(),'100', 'showing zero opacity restores a visible value');
    await slider.fill('37'); await toggle.click();
    await page.locator('#scene-tree-toggle').click();
    await page.locator('#share-view').click();
    await page.locator('#share-sheet').waitFor({state:'visible'});
    assert.equal(shared.meshes[0].visible,false);
    assert.equal(shared.meshes[0].opacity,0.37);
    assert.equal(shared.meshes[1].visible,true);
  } finally { await page.close(); }
});

test('scene color opens below its Mesh and updates only that Mesh in shares', async () => {
  const page = await openPage({width:390,height:844});
  try {
    await page.locator('#scene-tree-toggle').click();
    const first = page.locator('.scene-tree-row').first();
    const second = page.locator('.scene-tree-row').nth(1);
    assert.equal(await page.locator('#color-swatches').count(), 0, 'color editing lives in each scene row');
    assert.equal(await first.locator('.scene-tree-color').evaluate(button => button.style.getPropertyValue('--swatch')), '#ffc857');
    await first.locator('.scene-tree-color').click();
    assert.equal(await first.locator('.scene-tree-color').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.scene-tree-color-options:visible button').count(), 6);
    await second.locator('.scene-tree-color').click();
    assert.equal(await first.locator('.scene-tree-color').getAttribute('aria-expanded'), 'false', 'only one palette stays open');
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
      await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/scene-color-mobile.png`});
    }
    await second.locator('..').locator('.scene-tree-color-choice[data-color="#8f8bb2"]').click();
    assert.equal(await second.locator('.scene-tree-color').getAttribute('aria-expanded'), 'false');
    assert.equal(await second.locator('.scene-tree-color').evaluate(button => button.style.getPropertyValue('--swatch')), '#8f8bb2');
    assert.equal(await first.locator('.scene-tree-color').evaluate(button => button.style.getPropertyValue('--swatch')), '#ffc857');
    const shared = await captureShare(page);
    assert.deepEqual(shared.meshes.map(mesh => mesh.color), ['#ffc857','#8f8bb2']);
    await second.locator('.scene-tree-color').click();
    await page.keyboard.press('Escape');
    assert.equal(await second.locator('.scene-tree-color').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.scene-tree').isVisible(), true, 'Escape closes the palette before the scene list');
  } finally { await page.close(); }
});

test('inline rename keeps long labels readable and preserves the full shared value', async () => {
  const longName = `左上第一磨牙 · ${'扫描对照与边缘检查'.repeat(11)} · 终版`;
  const fixture = structuredClone(scene);
  fixture.meshes[0].label = {text: longName};
  const page = await openPage({width:320,height:700},0,fixture);
  try {
    assert.equal(await page.locator('.panel-trigger').count(),0);
    await page.locator('#scene-tree-toggle').click();
    const item = page.locator('.scene-tree-item').first();
    const select = item.locator('.scene-tree-select');
    await page.waitForFunction(() => document.querySelector('.scene-tree-select')?.textContent?.includes('…'));
    const compact = await select.textContent();
    assert.ok(compact.startsWith('左') && compact.endsWith('版') && compact.includes('…'));
    assert.equal(await select.getAttribute('aria-label'),longName);
    assert.equal(await page.locator('.scene-tree-name-preview').count(),0);
    const canvasLabel = page.locator('.mesh-label:visible').first();
    assert.ok((await canvasLabel.textContent()).includes('…'));
    assert.ok((await canvasLabel.boundingBox()).height < 40,'3D label cannot cover the model');
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS,{recursive:true});
      await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/long-name-mobile.png`});
    }
    await page.locator('#scene-tree-info-tab').click();
    assert.equal(await page.locator('#scene-selected-label').textContent(),longName);
    const bounds = await page.locator('#scene-selected-label').evaluate(element => ({height:element.clientHeight,scroll:element.scrollHeight}));
    assert.ok(bounds.height <= 54 && bounds.scroll > bounds.height,'full name stays available in a bounded scroll area');
    await page.locator('#scene-tree-elements-tab').click();
    await item.locator('.scene-tree-edit').click();
    const input = item.locator('.scene-tree-rename textarea');
    assert.equal(await input.inputValue(),longName);
    const renamed = `${longName.slice(0,-2)}修订`;
    await input.fill(renamed); await input.press('Enter');
    assert.equal(await select.getAttribute('aria-label'),renamed);
    assert.equal((await captureShare(page)).entities[0].label,renamed);
    await item.locator('.scene-tree-edit').click();
    await input.fill('取消的名称'); await input.press('Escape');
    assert.equal((await captureShare(page)).entities[0].label,renamed);
  } finally {await page.close();}
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
    await selectSceneMesh(page, 1);
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
    await selectSceneMesh(page, 0);
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
      await selectSceneMesh(page, index);
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
      await selectSceneMesh(page, 3);
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
  if (await page.locator('.dock-observe').getAttribute('aria-hidden') === 'false') await page.locator('#observe-back').click();
  await page.locator('#share-view').click(); await page.locator('#share-sheet').waitFor({state:'visible'});
  const snapshot = structuredClone(shared); await page.locator('#close-share').click(); return snapshot;
}

test('surface points and paths survive touch editing, navigation and share reopening', async () => {
  const page = await openPage({width:390,height:844}, 0, surfaceFixture());
  try {
    await page.locator('#brush-tool').click();
    assert.equal(await page.locator('[data-surface-mode="screen"]').getAttribute('aria-pressed'),'true',
      'annotation opens with the screen brush');
    await page.locator('[data-surface-mode="point"]').click();
    await page.locator('#surface-input').waitFor({state:'visible'});
    assert.equal(await page.locator('#surface-toolbar #share-view').count(), 1, 'sharing stays in the annotation toolbar while editing');
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
    await page.locator('[data-surface-mode="point"]').click();
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
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();await page.mouse.click(195,400);
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
    await page.locator('#brush-tool').click();
    await page.locator('[data-surface-mode="line"]').click();
    await page.locator('#surface-input').waitFor({state:'visible'});
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
    await page.locator('#brush-tool').click();
    await page.locator('[data-surface-mode="line"]').click();
    await page.locator('#surface-input').waitFor({state:'visible'});
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
    await page.locator('[data-surface-mode="point"]').click();
    assert.equal(await page.locator('#surface-target').count(),0);
    assert.equal(await page.locator('#surface-new').count(),0);
    await page.mouse.click(195,400);
    const snapshot=await captureShare(page);
    assert.equal(snapshot.state.annotations.length,1);assert.equal(snapshot.state.annotations[0].mesh,1);
    await page.locator('[data-surface-mode="select"]').click();
    await page.locator('.surface-badge').filter({hasText:'点 1'}).click();
    assert.equal(await page.locator('#surface-name').inputValue(),'点 1');
    await page.waitForFunction(()=>document.querySelector('.surface-badge.selected')?.textContent.includes('点 1'));
    await page.locator('#surface-done').click();await page.locator('#scene-tree-toggle').click();
    await page.locator('.scene-tree-row').nth(1).locator('.scene-tree-visibility').click();
    await page.locator('#scene-tree-toggle').click();await page.locator('#brush-tool').click();
    assert.equal(await page.locator('.surface-list-row').count(),0);
  } finally {await page.close();}
});

test('surface and screen strokes share tools, selection and undo history', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();await page.mouse.click(195,400);
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
    const input=page.locator('#surface-name');
    assert.equal(await input.getAttribute('readonly'),null);
    await input.fill('这里需要检查');await input.press('Tab');
    snapshot=await captureShare(page);assert.equal(snapshot.state.strokes[0].label,'这里需要检查');
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.strokes[0].label,undefined);
    await page.locator('#surface-redo').click();snapshot=await captureShare(page);
    const reopened=await openPage({width:390,height:844},0,{...surfaceFixture(),state:snapshot.state});
    try {assert.equal(await reopened.locator('.surface-badge').filter({hasText:'这里需要检查'}).count(),1);}
    finally {await reopened.close();}
  } finally {await page.close();}
});

test('new point, line and screen brush names remain editable after pointer release and share completion', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();await page.mouse.click(195,400);
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
    await page.locator('#surface-brush').click();
    await page.mouse.move(60,200);await page.mouse.down();await page.mouse.move(130,230,{steps:12});await page.mouse.up();
    assert.equal(await name.isVisible(),true,'new screen stroke exposes its name immediately');
    assert.equal(await name.inputValue(),'画笔 1');
    await name.fill('检查边缘');await name.press('Tab');
    assert.equal((await captureShare(page)).state.strokes[0].label,'检查边缘');
    assert.equal(await name.isVisible(),true);
    await page.locator('#surface-undo').click();assert.equal((await captureShare(page)).state.strokes[0].label,undefined);
    await page.locator('#surface-redo').click();assert.equal((await captureShare(page)).state.strokes[0].label,'检查边缘');
    await page.mouse.move(60,260);await page.mouse.down();await page.mouse.move(130,290,{steps:12});await page.mouse.up();
    assert.equal(await name.inputValue(),'画笔 2');
    await name.fill('第二处');await name.press('Tab');
    const strokes=(await captureShare(page)).state.strokes;
    assert.deepEqual(strokes.map(s=>s.label),['检查边缘','第二处']);
    await page.locator('#surface-undo').click();await page.locator('#surface-undo').click();
    assert.equal((await captureShare(page)).state.strokes.length,1);
    await page.locator('#surface-redo').click();assert.equal(await name.inputValue(),'画笔 2');

  } finally {await page.close();}
});

test('annotation names stay on canvas and the list adapts to available space independently', async () => {
  const fixture=surfaceFixture();
  fixture.state.annotations=Array.from({length:11},(_,i)=>({id:`list-${i}`,mesh:0,revision:'fixture',kind:'point',label:`标记 ${i+1} · 参考位置`,color:'#ff6b5e',visible:true,closed:false,points:[[0.3+i*0.005,0.3,0.4-i*0.005]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}));
  for(const viewport of [{width:390,height:666},{width:320,height:568},{width:390,height:844},{width:600,height:360},{width:759,height:481},{width:900,height:600},{width:1024,height:768},{width:1280,height:800},{width:1440,height:900},{width:1440,height:600}]) {
    const dense = structuredClone(fixture);
    // List overflow needs 80 rows, not 80 overlapping render/annotation occluders.
    if(viewport.width>=1280) dense.meshes=Array.from({length:80},(_,i)=>({...fixture.meshes[0],name:`Long scene item ${i+1}`,label:null,visible:i===0}));
    const page=await openPage(viewport,0,dense);
    try {
      const roomy=viewport.width>=900 && viewport.height>=600;
      assert.equal(await page.locator('.surface-list').isVisible(),roomy);
      assert.equal(await page.locator('#surface-list-toggle').count(),0);
      assert.equal(await page.locator('#surface-toolbar').isVisible(),false);
      assert.equal(await page.locator('#surface-input').isVisible(),false);
      assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
      const before=await captureShare(page);
      if (viewport.width >= 1280) {
        const assertSeparated = async () => {
          const a=await page.locator('.scene-tree').boundingBox(),b=await page.locator('.surface-list').boundingBox();
          assert.ok(a && b);
          assert.ok(a.y+a.height<=b.y || b.y+b.height<=a.y || a.x+a.width<=b.x || b.x+b.width<=a.x,JSON.stringify({a,b}));
          assert.ok(Math.max(a.y+a.height,b.y+b.height)<viewport.height-70);
          assert.ok(await page.locator('.scene-tree-list').evaluate(el=>el.scrollHeight>el.clientHeight));
          await page.locator('.scene-tree-list').evaluate(el=>el.scrollTop=el.scrollHeight);
          const last=await page.locator('.scene-tree-row').last().boundingBox();
          assert.ok(last.y>=a.y && last.y+last.height<=a.y+a.height,'last scene row stays inside its scrolling pane');
        };
        await assertSeparated();
      }
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
      if (await page.locator('#scene-tree-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#scene-tree-toggle').click();
      await page.locator('#scene-tree-info-tab').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.surface-list').isVisible(),false);
      assert.equal(await page.locator('.surface-badge').last().textContent(),'标记 11 · 参考位置');
      await page.locator('#scene-tree-toggle').click();
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

test('opening scene info preserves visible annotation badges, list and document', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=[{id:'named-point',mesh:0,revision:'fixture',kind:'point',label:'稳定标记',color:'#ff6b5e',visible:true,closed:false,points:[[0.3,0.3,0.4]],normals:[[0.57735,0.57735,0.57735]],controls:[0]}];
  for(const viewport of [{width:320,height:700},{width:390,height:844},{width:1280,height:800},{width:740,height:420}]) {
    const page=await openPage(viewport,0,fixture);
    try {
      await page.waitForFunction(()=>document.querySelector('.surface-badge'));
      const before=await captureShare(page);
      if (await page.locator('#scene-tree-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#scene-tree-toggle').click();
      await page.locator('#scene-tree-info-tab').click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('.surface-list').isVisible(),viewport.width>=900 && viewport.height>=600);
      assert.equal(await page.locator('.surface-badge').first().isVisible(),true);
      const boxes=await page.evaluate(()=>['.surface-list','#scene-tree'].map(item=>{const r=document.querySelector(item).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom};}));
      const [a,b]=boxes;assert.ok(a.right<=b.x || b.right<=a.x || a.bottom<=b.y || b.bottom<=a.y,'panels must not overlap');
      await page.locator('#scene-tree-toggle').click();
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
    await page.locator('#scene-tree-toggle').click();await page.locator('.scene-tree-row').first().locator('.scene-tree-opacity').fill('100');
    assert.equal(await page.locator('.surface-list-row').count(),1);
  } finally {await page.close();}
});

test('new marks refuse the scene sample limit before producing an invalid share', async () => {
  const fixture=surfaceFixture();fixture.state.annotations=Array.from({length:4},(_,i)=>({id:`full-${i}`,mesh:0,revision:'fixture',kind:'line',label:`满 ${i}`,color:'#ff6b5e',visible:false,closed:false,points:Array.from({length:4096},()=>[0.3,0.3,0.4]),normals:Array.from({length:4096},()=>[0.57735,0.57735,0.57735]),controls:[0,4095]}));
  const page=await openPage({width:390,height:844},0,fixture);
  try {await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();await page.mouse.click(195,400);assert.equal((await captureShare(page)).state.annotations.length,4);} finally {await page.close();}
});

test('undo restores Raw geometry before restoring a deleted annotation', async () => {
  const page=await openPage({width:390,height:844},0,surfaceFixture());
  try {
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();await page.mouse.click(195,400);const original=(await captureShare(page)).state.annotations;
    await page.locator('#surface-delete').click();await page.locator('#surface-done').click();
    await page.locator('#scene-tree-toggle').click();await page.locator('#scene-tree-info-tab').click();await page.locator('[data-quality="lod"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-quality="lod"]').classList.contains('active'));
    await page.locator('#scene-tree-toggle').click();await page.locator('#brush-tool').click();
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
    await page.locator('#brush-tool').click();await page.locator('[data-surface-mode="point"]').click();const touch=await page.context().newCDPSession(page);
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
    await page.locator('#scene-tree-toggle').click();
    await page.locator('.scene-tree-row').first().locator('.scene-tree-visibility').click();await page.locator('#scene-tree-toggle').click();
    await page.mouse.click(400,300);
    await page.locator('#surface-undo').click();await page.locator('#surface-undo').click();
    await page.locator('#scene-tree-toggle').click();await page.locator('.scene-tree-row').first().locator('.scene-tree-visibility').click();await page.locator('#scene-tree-toggle').click();
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
    assert.equal(await page.locator('#scene-selected-label').textContent(),'Mesh one');
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
    await page.setViewportSize({width:900,height:700});
    await page.evaluate(() => window.addEventListener('keydown', event => { window.copyIntercepted = event.defaultPrevented; }, {once:true}));
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+c`);
    assert.equal(await page.evaluate(() => window.copyIntercepted), false);
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

test('wireframe gaps expose component input while painted edges remain occluders', async () => {
  for (const projection of ['perspective', 'orthographic']) for (const shading of ['flat', 'wire']) {
    const data={...structuredClone(scene),label_groups:[],meshes:[{...scene.meshes[0],label:null,color:'#ff0000'}]};
    data.state={...data.state,projection,shading,strokes:[],camera:{position:[0,0,10],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:8}};
    data.attachments=[{id:'log',label:'Occluded log',byte_size:20,url:'/wireframe-log'}];
    data.components=[{id:'mesh',component:'mesh',source:{kind:'mesh',index:0},label:'Mesh',position:[0,0,0],visible:true,opacity:1},
      {id:'log',component:'text',source:{kind:'attachment',index:0},label:'Log',position:[0,0,-1],size:[4,4],visible:true,opacity:1}];
    const page=await browser.newPage({viewport:{width:800,height:800},deviceScaleFactor:2});
    await page.route('**/wireframe-log',r=>r.fulfill({contentType:'text/plain',body:'Visible through wireframe'}));
    await page.route('**/api/v1/scenes/**',r=>r.fulfill({json:data}));
    await page.route('**/mesh/0',r=>r.fulfill({body:planePly(2)}));
    try {
      await page.goto(`${origin}/s/fixture`);await page.locator('#loading-state').waitFor({state:'hidden'});
      await page.mouse.click(400,400);
      assert.equal(await page.locator('.component-dialog').isVisible(),false,`${projection}/${shading}: painted triangle edge must intercept input`);
      await page.mouse.dblclick(450,400);
      assert.equal(await page.locator('.component-dialog').isVisible(),shading==='wire',`${projection}/${shading}: input must match visible triangle coverage`);
    } finally {await page.close();}
  }
});

async function centerPixel(page) {
  const png = await page.screenshot();
  return page.evaluate(async data => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
  }, `data:image/png;base64,${png.toString('base64')}`);
}

test('orthographic framing retains geometry behind the saved camera', async () => {
  const data = {...structuredClone(scene), label_groups: [], meshes: [{...scene.meshes[0], label:null, color:'#ff0000', translation:[0,0,1]}]};
  data.state = {...data.state, strokes:[], projection:'orthographic', camera:{position:[.2,0,.2],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:8}};
  const page = await openPage({width:800,height:800},0,data,[planePly(2)]);
  try {
    const p = await centerPixel(page);
    assert.ok(p[0] > p[1]*2 && p[0] > p[2]*2, `clipped orthographic plane: ${p}`);
    const saved = (await captureShare(page)).state;
    assert.equal(saved.camera.zoom,1); assert.equal(saved.camera.orthographic_height,8);
    const offset=saved.camera.position.map((v,i)=>v-saved.camera.target[i]);
    const expected=data.state.camera.position.map((v,i)=>v-data.state.camera.target[i]);
    for(let i=0;i<3;i++)assert.ok(Math.abs(offset[i]/Math.hypot(...offset)-expected[i]/Math.hypot(...expected))<1e-5,'restoring an oblique camera must preserve its direction');
    await page.mouse.move(380,380);await page.mouse.down();await page.mouse.move(420,400,{steps:8});await page.mouse.up();
    assert.notDeepEqual((await captureShare(page)).state.camera,saved.camera);
  } finally { await page.close(); }
});

test('fit resets orthographic zoom while preserving oblique rotation and roll', async () => {
  const corners=[[-1,-.5,-6],[1,-.5,-6],[1,.5,-6],[-1,.5,-6],[-1,-.5,6],[1,-.5,6],[1,.5,6],[-1,.5,6]];
  const faces=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  const mesh=`ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n${corners.map(p=>p.join(' ')).join('\n')}\n${faces.map(f=>`3 ${f.join(' ')}`).join('\n')}\n`;
  const data={...structuredClone(scene),label_groups:[],meshes:[{...scene.meshes[0],label:null}],
    state:{...scene.state,projection:'orthographic',strokes:[],camera:{position:[14,14,14],target:[0,0,0],up:[1,-1,0],fov:34,zoom:1,orthographic_height:20}}};
  const page=await openPage({width:800,height:800},0,data,[mesh]);
  const unit=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
  const direction=c=>unit(c.position.map((v,i)=>v-c.target[i]));
  const close=(actual,expected,message)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-5,`${message}: ${actual} vs ${expected}`));
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    const original=(await captureShare(page)).state.camera;
    await page.locator('#fit-view').click();
    const baseline=(await captureShare(page)).state.camera;
    close(direction(baseline),direction(original),'global fit preserves viewing direction');
    close(unit(baseline.up),unit(original.up),'global fit preserves camera roll');
    for(const action of ['global','double-click']) for(const delta of [-500,500]) {
      await page.mouse.move(400,400);await page.mouse.wheel(0,delta);await page.waitForTimeout(150);
      const zoomed=(await captureShare(page)).state.camera;
      assert.ok(Math.abs(zoomed.zoom-1)>.1,'wheel actually changes orthographic magnification');
      if(action==='global')await page.locator('#fit-view').click();
      else await page.mouse.dblclick(400,400,{delay:80});
      const fitted=(await captureShare(page)).state.camera;
      assert.equal(fitted.zoom,1,`${action} resets zoom after wheel ${delta}`);
      assert.ok(Math.abs(fitted.orthographic_height/fitted.zoom-baseline.orthographic_height/baseline.zoom)<1e-5,`${action} restores stable framing`);
      close(direction(fitted),direction(zoomed),`${action} preserves viewing direction`);
      close(unit(fitted.up),unit(zoomed.up),`${action} preserves camera roll`);
      const backward=direction(fitted),up=unit(fitted.up);
      const right=unit([up[1]*backward[2]-up[2]*backward[1],up[2]*backward[0]-up[0]*backward[2],up[0]*backward[1]-up[1]*backward[0]]);
      const halfHeight=fitted.orthographic_height/fitted.zoom/2;
      for(const point of corners)for(const axis of [right,up]) {
        const projected=point.reduce((sum,v,i)=>sum+(v-fitted.target[i])*axis[i],0);
        assert.ok(Math.abs(projected)<halfHeight*.99,`${action} includes the rotated depth extent with padding`);
      }
    }
    data.state.projection='perspective';
    await page.reload();await page.locator('#loading-state').waitFor({state:'hidden'});
    await page.locator('#fit-view').click();
    const perspectiveBaseline=(await captureShare(page)).state.camera;
    for(const [action,shift,delta] of [['global',false,-500],['global',true,500],['double-click',false,500],['double-click',true,-500]]) {
      await page.mouse.move(400,400);
      if(shift)await page.keyboard.down('Shift');
      await page.mouse.wheel(0,delta);
      if(shift)await page.keyboard.up('Shift');
      await page.waitForTimeout(150);
      const zoomed=(await captureShare(page)).state.camera;
      if(shift)assert.ok(Math.abs(zoomed.fov-perspectiveBaseline.fov)>.1,'Shift+wheel actually changes perspective FOV');
      else assert.ok(Math.hypot(...zoomed.position.map((v,i)=>v-perspectiveBaseline.position[i]))>.1,'wheel actually changes perspective distance');
      if(action==='global')await page.locator('#fit-view').click();
      else await page.mouse.dblclick(400,400,{delay:80});
      const fitted=(await captureShare(page)).state.camera;
      assert.equal(fitted.fov,perspectiveBaseline.fov,`${action} resets perspective FOV`);
      close(fitted.position,perspectiveBaseline.position,`${action} restores perspective framing`);
      close(direction(fitted),direction(zoomed),`${action} preserves perspective rotation`);
      close(unit(fitted.up),unit(zoomed.up),`${action} preserves perspective roll`);
    }
    // Pan updates Arcball's live view before its public target is refreshed.
    // Animated fits must preserve that view throughout the transition as well.
    await page.mouse.move(400,400);await page.mouse.down({button:'right'});
    await page.mouse.move(440,430,{steps:5});await page.mouse.up({button:'right'});
    const panned=(await captureShare(page)).state.camera;
    assert.ok(Math.hypot(...panned.position.map((v,i)=>v-perspectiveBaseline.position[i]))>.1,'the view was actually panned');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#fit-view').click();await page.waitForTimeout(60);
    const during=(await captureShare(page)).state.camera;
    close(direction(during),direction(panned),'animated fit preserves rotation after pan');
    close(unit(during.up),unit(panned.up),'animated fit preserves roll after pan');
    await page.waitForTimeout(300);
    const settled=(await captureShare(page)).state.camera;
    close(direction(settled),direction(panned),'completed fit preserves rotation after pan');
    close(unit(settled.up),unit(panned.up),'completed fit preserves roll after pan');
    close(settled.position,perspectiveBaseline.position,'completed fit recenters a panned view');
  } finally {await page.close();}
});

test('spatial content respects depth and stays fixed during pointer and keyboard navigation', async () => {
  for (const type of ['image','text']) for (const z of [-1,1]) {
    const data={...structuredClone(scene),label_groups:[],meshes:[{...scene.meshes[0],label:null,color:'#ff0000'}, {...scene.meshes[1],translation:[100,0,0]}]};
    data.state={...data.state,selected:1,strokes:[],camera:{position:[0,0,10],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:8}};
    data.attachments=[{id:'image',label:'Depth image',byte_size:100,url:'/depth.svg'}];
    data.components=[{id:'mesh',component:'mesh',source:{kind:'mesh',index:0},label:'Mesh',position:[0,0,0],visible:true,opacity:1},
      {id:'image',component:type,source:{kind:'attachment',index:0},label:'Image',position:[0,0,z],size:[4,4],visible:true,opacity:1},
      {id:'other-mesh',component:'mesh',source:{kind:'mesh',index:1},label:'Other mesh',position:[100,0,0],visible:true,opacity:1}];
    const page=await browser.newPage({viewport:{width:800,height:800}});
    await page.route('**/depth.svg',r=>type==='text'?r.fulfill({contentType:'text/plain',body:'Diagnostic text'}):r.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNkYPjPgA0wYRUdtBIAy0MBD1YkjLoAAAAASUVORK5CYII=','base64')}));
    await page.route('**/api/v1/scenes/**',r=>r.request().method()==='GET'?r.fulfill({json:data}):r.continue());
    await page.route('**/mesh/0',r=>r.fulfill({body:planePly(2)}));
    try {
      await page.goto(`${origin}/s/fixture?render=1`);await page.waitForFunction(()=>document.documentElement.dataset.renderStatus==='ready');
      const p=await centerPixel(page);
      assert.ok(z<0 ? p[0]>p[2]*2 : type==='image' ? p[2]>p[0]*2 : p[0]<p[2]*2,`${type} depth ${z}: ${p}`);
      if (type==='image' && z>0) {
        data.components[1].opacity=.5;
        await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.renderStatus==='ready');
        const mixed=await centerPixel(page);
        assert.ok(mixed[0]>60 && mixed[2]>mixed[0] && mixed[1]<5,`half-opacity image must blend with the rear mesh, not the scene background: ${mixed}`);
        data.components[1].opacity=1;
      }
      await page.goto(`${origin}/s/fixture`);await page.locator('#loading-state').waitFor({state:'hidden'});
      if(z<0) {
        await page.mouse.click(650,400);
        assert.equal((await captureShare(page)).state.selected,0,'exposed mesh pixels remain selectable with DOM content present');
        await page.reload();await page.locator('#loading-state').waitFor({state:'hidden'});
      }
      await page.mouse.click(400,400);
      assert.equal(await page.locator('.component-dialog').isVisible(),false,'a single click only selects content');
      await page.mouse.dblclick(400,400);
      assert.equal(await page.locator('.component-dialog').isVisible(),z>0,'only exposed content opens on a double click');
      if(z<0)assert.equal((await captureShare(page)).state.selected,0,'mesh pixels covering DOM content remain selectable');
      if(z>0)await page.getByRole('button',{name:'返回场景'}).click();
      const before=(await captureShare(page)).state.camera;
      await page.mouse.move(400,400);await page.mouse.down();await page.mouse.move(450,410,{steps:8});await page.mouse.up();
      let after=await captureShare(page);
      assert.notDeepEqual(after.state.camera,before,'navigation must still work over overlapping content');
      assert.deepEqual(after.entities.map(c=>c.position),data.components.map(c=>c.position));
      if (z>0) {
        const header=page.locator('.component-handle');const box=await header.boundingBox();
        await page.mouse.move(box.x+box.width*.2,box.y+box.height*.5);await page.mouse.down();
        await page.mouse.move(box.x+box.width*.2+30,box.y+box.height*.5+20,{steps:5});await page.mouse.up();
        const headerDrag=await captureShare(page);
        assert.deepEqual(headerDrag.entities.map(c=>c.position),data.components.map(c=>c.position),'title drags cannot move content');
        assert.notDeepEqual(headerDrag.state.camera,after.state.camera,'title drags navigate the scene');
      }
      await page.locator('#scene-tree-toggle').click();
      const row=page.locator('.scene-tree-row').getByRole('button',{name:'Image',exact:true});
      await row.focus();await page.keyboard.press('Alt+ArrowRight');
      after=await captureShare(page);
      assert.deepEqual(after.entities.map(c=>c.position),data.components.map(c=>c.position),'position shortcuts are disabled');
    } finally {await page.close();}
  }
});

test('translucent DOM layers blend once and respect intervening geometry from both sides', async () => {
  const page=await browser.newPage({viewport:{width:800,height:800}});
  const colors=await page.evaluate(()=>Object.fromEntries(['red','blue'].map(color=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
    const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,8,8);
    return [color,canvas.toDataURL().split(',')[1]];
  })));
  const data={...structuredClone(scene),label_groups:[],meshes:[{...scene.meshes[0],label:null,color:'#00ff00'}]};
  data.attachments=['red','blue'].map(color=>({id:color,label:color,byte_size:100,url:`/alpha-${color}.png`}));
  data.components=[{id:'mesh',component:'mesh',source:{kind:'mesh',index:0},label:'Middle mesh',position:[0,0,0],visible:true,opacity:1},
    {id:'rear',component:'image',source:{kind:'attachment',index:0},label:'Red rear',position:[0,0,-1],size:[4,4],visible:true,opacity:1},
    {id:'front',component:'image',source:{kind:'attachment',index:1},label:'Blue front',position:[0,0,1],size:[4,4],visible:true,opacity:.5}];
  await page.route('**/alpha-*.png',r=>r.fulfill({contentType:'image/png',body:Buffer.from(colors[r.request().url().includes('red')?'red':'blue'],'base64')}));
  await page.route('**/api/v1/scenes/**',r=>r.request().method()==='GET'?r.fulfill({json:data}):r.continue());
  await page.route('**/mesh/0',r=>r.fulfill({body:planePly(2)}));
  try {
    for(const projection of ['perspective','orthographic']) for(const side of [1,-1]) for(const geometry of [false,true]) {
      data.meshes[0].visible=data.components[0].visible=geometry;
      data.state={...data.state,projection,strokes:[],camera:{position:[0,0,10*side],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:8}};
      await page.goto(`${origin}/s/fixture?render=1`);
      await page.waitForFunction(()=>document.documentElement.dataset.renderStatus==='ready');
      const p=await centerPixel(page), context=`${projection}, side ${side}, middle mesh ${geometry}: ${p}`;
      if(side<0) assert.ok(p[0]>250 && p[1]<5 && p[2]<5,`the opaque red panel hides both later layers: ${context}`);
      else if(geometry) assert.ok(p[0]<15 && p[1]>60 && p[2]>=125 && p[2]<145,`the blue panel blends with the intervening green mesh: ${context}`);
      else assert.ok(Math.abs(p[0]-127)<=2 && p[1]<5 && Math.abs(p[2]-128)<=2,`half-blue over opaque red must be purple: ${context}`);
    }
  } finally {await page.close();}
});

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


test('PNG export does not read hidden unavailable geometry', async () => {
  const exported = structuredClone(scene);
  exported.meshes[1].visible = false;
  const page = await browser.newPage({viewport:{width:1200,height:900}});
  let hiddenReads = 0;
  try {
    await page.route('**/api/v1/scenes/**', route => route.fulfill({json:exported}));
    await page.route('**/mesh/1*', route => {hiddenReads++;return route.fulfill({status:410,body:'gone'});});
    await page.goto(`${origin}/s/fixture?render=1`);
    await page.waitForFunction(() => document.documentElement.dataset.renderStatus === 'ready');
    assert.equal(hiddenReads,0,'hidden sources must not invalidate or block the exported scene');
  } finally {await page.close();}
});

for (const viewport of [{width:1280,height:800},{width:320,height:700}]) {
  test(`scene tree isolates and restores every component type at ${viewport.width}×${viewport.height}`, async () => {
    const mixed=structuredClone(scene); mixed.label_groups=[]; mixed.state.strokes=[];
    mixed.meshes=mixed.meshes.map((m,i)=>({...m,name:i?'Margin':'Scan',label:undefined,format:i?'pts':'ply',opacity:i?0:.37,visible:true}));
    mixed.attachments=['Log','Trace'].map((label,i)=>({id:`a${i}`,label,byte_size:16,url:`/test/attachments/${i}`,unavailable:null}));
    mixed.components=['mesh','points','text','example:trace'].map((component,i)=>({id:`c${i}`,component,
      source:{kind:i<2?'mesh':'attachment',index:i<2?i:i-2},label:['Scan','Margin','Log','Trace'][i],group:i<2?'Geometry':'Diagnostics',
      position:[i*4,0,0],size:i<2?null:[3,2],visible:i!==3,opacity:[.37,0,.6,0][i],
      ...(i===3?{renderer:{plugin:'example',revision:'fixture',name:'trace',capabilities:{movable:false,resizable:false,presentations:['spatial','focus']}}}:{})}));
    const openMixed=async data=>{
      const page=await browser.newPage({viewport});
      await page.route('**/api/v1/scenes/**',r=>r.request().method()==='GET'?r.fulfill({json:data}):r.continue());
      await page.route('**/test/attachments/*',r=>r.fulfill({contentType:'text/plain',body:'test diagnostic'}));
      await page.route('**/test/renderers/*',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><p>Trace fixture</p><script>addEventListener('message',e=>{if(e.data?.type==='blind:init')e.ports[0].postMessage({version:1,type:'ready'});});</script>`}));
      await page.goto(`${origin}/s/fixture`); await page.locator('#loading-state').waitFor({state:'hidden'});
      assert.equal(await page.locator('#invalid-state').isVisible(),false);
      const toggle=page.locator('#scene-tree-toggle'); if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
      return page;
    };
    const page=await openMixed(mixed);
    const checks=()=>page.locator('.scene-tree-visibility').evaluateAll(buttons=>buttons.map(button=>button.dataset.visible==='true'));
    const row=name=>page.locator('.scene-tree-row').getByRole('button',{name,exact:true});
    try {
      assert.equal(await page.locator('.scene-tree-color').count(),2,'Mesh and PTS rows show color; content rows do not');
      // A hidden, zero-opacity geometry must become visible when isolated.
      await row('Margin').dblclick(); assert.deepEqual(await checks(),[false,true,false,false]);
      let snapshot=await captureShare(page);
      assert.deepEqual(snapshot.entities.map(c=>c.visible),[false,true,false,false]);
      assert.equal(snapshot.meshes[0].opacity,.37);assert.equal(snapshot.meshes[1].opacity,1);
      assert.deepEqual(snapshot.meshes.map(m=>m.visible),[false,true]);
      await row('Log').dblclick(); assert.deepEqual(await checks(),[false,false,true,false]);
      await page.getByRole('button',{name:'全部隐藏',exact:true}).click();assert.deepEqual(await checks(),[false,false,false,false]);
      await page.waitForFunction(()=>[...document.querySelectorAll('.scene-surface')].every(e=>!e.checkVisibility()));
      snapshot=await captureShare(page);assert.ok(snapshot.entities.every(c=>!c.visible));assert.ok(snapshot.meshes.every(m=>!m.visible));
      await page.getByRole('button',{name:'全部显示',exact:true}).click();assert.deepEqual(await checks(),[true,true,true,true]);
      await page.waitForFunction(()=>[...document.querySelectorAll('.scene-surface')].every(e=>e.checkVisibility()));
      snapshot=await captureShare(page);assert.deepEqual(snapshot.entities.map(c=>c.opacity),[.37,1,.6,1]);
      assert.ok(snapshot.entities.every(c=>c.visible));assert.ok(snapshot.meshes.every(m=>m.visible));
      const logRow=row('Log').locator('xpath=ancestor::div[contains(@class,"scene-tree-row")]');
      await logRow.locator('.scene-tree-opacity').fill('42');
      await logRow.locator('.scene-tree-visibility').click();
      assert.equal(await logRow.locator('.scene-tree-opacity').inputValue(),'42');
      snapshot=await captureShare(page);assert.equal(snapshot.entities[2].visible,false);assert.equal(snapshot.entities[2].opacity,.42);
      await logRow.locator('.scene-tree-opacity').fill('60');
      assert.equal(await logRow.locator('.scene-tree-visibility').getAttribute('data-visible'),'true');
      await page.getByRole('button',{name:'全部隐藏',exact:true}).click();
      await row('Trace').dblclick();assert.deepEqual(await checks(),[false,false,false,true]);
      await page.waitForFunction(()=>!document.querySelector('[data-component="text"]').checkVisibility()&&document.querySelector('[data-component="example:trace"]').checkVisibility());
      snapshot=await captureShare(page);assert.deepEqual(snapshot.entities.map(c=>c.visible),[false,false,false,true]);
      const saved={...mixed,state:snapshot.state,meshes:mixed.meshes.map((m,i)=>({...m,...snapshot.meshes[i]})),entities:mixed.components.map((c,i)=>({...c,...snapshot.entities[i]}))};
      const reopened=await openMixed(saved);
      try {assert.deepEqual(await reopened.locator('.scene-tree-visibility').evaluateAll(buttons=>buttons.map(button=>button.dataset.visible==='true')),[false,false,false,true]);}
      finally {await reopened.close();}
      if(process.env.BLIND_TEST_SCREENSHOTS) {
        await page.getByRole('button',{name:'全部显示',exact:true}).click();await page.mouse.move(0,0);
        await mkdir(process.env.BLIND_TEST_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:`${process.env.BLIND_TEST_SCREENSHOTS}/tree-actions-${viewport.width}.png`});
      }
    } finally {await page.close();}
  });
}

async function horizontalOrbitAngle(page, wheel = 0) {
  const unzoomed=wheel ? (await captureShare(page)).state.camera : null;
  await page.mouse.move(400,400);
  if(wheel) { await page.mouse.wheel(0,wheel); await page.waitForTimeout(100); }
  const before=(await captureShare(page)).state.camera;
  if(unzoomed) assert.ok(Math.abs(before.zoom-unzoomed.zoom)>1e-6 || Math.hypot(...before.position.map((x,i)=>x-unzoomed.position[i]))>1e-6,'wheel must actually change magnification');
  await page.mouse.move(400,400); await page.mouse.down();
  await page.mouse.move(440,400,{steps:20}); await page.mouse.up();
  const after=(await captureShare(page)).state.camera;
  const direction=c=>{const d=c.target.map((x,i)=>x-c.position[i]);const n=Math.hypot(...d);return d.map(x=>x/n);};
  const a=direction(before),b=direction(after);
  return Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,x,i)=>sum+x*b[i],0))));
}

test('spread-out scene keeps rotation sensitivity after zoom and fit', async () => {
  const data={...structuredClone(scene),label_groups:[],
    meshes:Array.from({length:10},(_,i)=>({...scene.meshes[0],label:null,translation:[50+i*2,-26,0]})),
    state:{...scene.state,strokes:[],camera:{position:[60,-26,60],target:[60,-26,0],up:[0,1,0],fov:40,zoom:1,orthographic_height:20}}};
  const page=await openPage({width:800,height:800},0,data);
  try {
    const initial=await horizontalOrbitAngle(page);
    const zoomed=await horizontalOrbitAngle(page,-1000);
    assert.ok(initial>.01,'drag must actually rotate the camera');
    assert.ok(Math.abs(zoomed/initial-1)<.01,`zoom changed orbit sensitivity: ${initial} -> ${zoomed}`);
    await page.emulateMedia({reducedMotion:'reduce'}); await page.locator('#fit-view').click();
    const fitted=await horizontalOrbitAngle(page);
    const fittedZoomed=await horizontalOrbitAngle(page,-1000);
    assert.ok(Math.abs(fittedZoomed/fitted-1)<.01,`zoom after fit changed orbit sensitivity: ${fitted} -> ${fittedZoomed}`);
  } finally { await page.close(); }
});

test('orthographic rotation stays continuous at the clipping safety boundary', async () => {
  const angles=[];
  for(const distance of [5,.1]) {
    const data={...structuredClone(scene),label_groups:[],meshes:[{...scene.meshes[0],label:null}],
      state:{...scene.state,projection:'orthographic',strokes:[],camera:{position:[.3,.3,distance],target:[.3,.3,0],up:[0,1,0],fov:34,zoom:10,orthographic_height:2}}};
    const page=await openPage({width:800,height:800},0,data);
    try { angles.push(await horizontalOrbitAngle(page)); } finally { await page.close(); }
  }
  assert.ok(angles[0]>.01,'drag must actually rotate the camera');
  assert.ok(Math.abs(angles[1]/angles[0]-1)<.01,`clipping changed a continuous drag: ${angles}`);
});

test('double-click keeps the mesh pivot through rotation, pan and share reopening', async () => {
  const close=(actual,expected,message)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-5,`${message}: ${actual} vs ${expected}`));
  const unit=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  for(const projection of ['orthographic','perspective']) for(const z of [100,-100]) {
    const data={...structuredClone(scene),label_groups:[],
      meshes:[{...scene.meshes[0],label:null},{...scene.meshes[1],translation:[20,0,z]}],
      state:{...scene.state,projection,strokes:[],camera:{position:[0,0,200],target:[0,0,0],up:[0,1,0],fov:34,zoom:1,orthographic_height:8}}};
    const meshes=[planePly(2),planePly(2)];
    const page=await openPage({width:800,height:800},0,data,meshes);
    try {
      await page.mouse.dblclick(400,400,{delay:80});await page.waitForTimeout(350);
      const fitted=(await captureShare(page)).state.camera;
      assert.ok(projection==='orthographic' ? fitted.orthographic_height<8 : fitted.position[2]<200,'double-click must actually fit the mesh');
      await page.mouse.move(400,400);await page.mouse.down();
      await page.mouse.move(440,420,{steps:20});await page.mouse.up();
      const rotated=(await captureShare(page)).state.camera;
      const forward=unit(rotated.target.map((v,i)=>v-rotated.position[i]));
      const up=unit(rotated.up);
      const right=unit([forward[1]*up[2]-forward[2]*up[1],forward[2]*up[0]-forward[0]*up[2],forward[0]*up[1]-forward[1]*up[0]]);
      const toCenter=rotated.position.map(v=>-v);
      assert.ok(Math.abs(forward[0])>.01,'drag must actually rotate');
      close([dot(toCenter,right),dot(toCenter,up)],[0,0],`${projection}/${z}: mesh center must stay at screen center after rotation`);
      close(fitted.target,[0,0,0],'share must retain the fitted pivot');
      close(rotated.target,[0,0,0],'rotation must retain the fitted pivot');

      await page.mouse.move(400,400);await page.mouse.down({button:'right'});
      await page.mouse.move(430,420,{steps:10});await page.mouse.up({button:'right'});
      const panned=(await captureShare(page)).state.camera;
      assert.ok(Math.hypot(...panned.target)>.01,'pan must move the live pivot');
      await page.mouse.move(400,400);await page.mouse.down();
      await page.mouse.move(440,400,{steps:20});await page.mouse.up();
      const snapshot=await captureShare(page);
      close(snapshot.state.camera.target,panned.target,'next rotation must preserve the panned pivot');
      await clickDisplay(page);
      await page.locator('[data-observe-category="projection"]').click();
      await page.locator(`[data-projection="${projection==='orthographic' ? 'perspective' : 'orthographic'}"]`).click();
      const switched=(await captureShare(page)).state.camera;
      close(switched.target,panned.target,'projection switch must preserve the panned pivot');
      close(switched.up,snapshot.state.camera.up,'projection switch must preserve roll');
      const reopened=await openPage({width:800,height:800},0,{...data,state:snapshot.state},meshes);
      try {close((await captureShare(reopened)).state.camera.target,panned.target,'reopening must preserve the live pivot');}
      finally {await reopened.close();}
    } finally {await page.close();}
  }
});
