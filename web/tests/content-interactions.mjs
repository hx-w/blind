import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function shareView(page) {
  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/share'));
  await page.locator('#share-view').click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  const links = await result.json();
  await page.locator('#share-sheet[open], .collection-share[open]').waitFor();
  await page.keyboard.press('Escape');
  return links;
}
async function state(url) {
  const token = new URL(url).pathname.split('/').at(-1);
  const response = await fetch(new URL(`/api/v1/scenes/${token}`, url));
  assert.equal(response.status, 200);
  return response.json();
}

test('source-anchored spatial reading survives dragging, fullscreen reflow and real reshare', {timeout:180000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blind-native-content-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const env = {...process.env, BLIND_CONFIG_DIR:join(directory,'server'), BLIND_CLIENT_DIR:join(directory,'client')};
  const cli = (args, input) => {
    const result = spawnSync(join(root,'target/debug/blind'), args, {env,input,encoding:'utf8',timeout:90000});
    assert.equal(result.status,0,`${result.error?.message ?? ''}\n${result.stderr}`); return result.stdout;
  };
  let server, browser, serverLog = '';
  try {
    const path = join(directory,'review.log');
    await writeFile(path, Array.from({length:4322}, (_,i) => `source line ${i+1}: review the rendering boundary and preserve this source target.`).join('\n'));
    cli(['init','--host',origin]);
    server = spawn(join(root,'target/debug/blind'), ['serve','--listen',new URL(origin).host], {env,stdio:'pipe'});
    server.stdout.on('data', chunk => { serverLog += chunk; });
    server.stderr.on('data', chunk => { serverLog += chunk; });
    for (let attempt=0;attempt<100;attempt++) {
      try { if ((await fetch(`${origin}/api/v1/health`)).ok) break; } catch {}
      if (attempt===99) throw new Error('Blind server did not become ready');
      await new Promise(resolve => setTimeout(resolve,100));
    }
    const links = JSON.parse(cli(['share',path,'--format','json']));
    browser = await chromium.launch({headless:true, executablePath:process.env.BLIND_TEST_CHROMIUM || undefined, args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page = await browser.newPage({viewport:{width:1100,height:800}});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.goto(links.viewer_url);
    await page.locator('.component-content pre').filter({hasText:'source line 4322:'}).waitFor();
    const body = page.locator('.component-body');
    const box = await body.boundingBox();
    const original = await state((await shareView(page)).viewer_url);
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.65);
    await page.mouse.down();
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.25,{steps:12});
    await page.mouse.up();
    const shared = await shareView(page);
    const saved = await state(shared.viewer_url);
    assert.ok(saved.entities[0].state.reading, 'direct spatial drag must produce a source reading anchor');
    assert.notDeepEqual(saved.entities[0].state.reading, original.entities[0].state?.reading, 'drag must advance the actual source target');
    assert.deepEqual(saved.state.camera, original.state.camera, 'body reading must not navigate the camera');
    assert.deepEqual(saved.entities[0].position, original.entities[0].position, 'content remains fixed in world coordinates');
    await page.goto(shared.viewer_url);
    await page.locator('.component-content pre').filter({hasText:'source line 4322:'}).waitFor();
    const reopened = await shareView(page);
    const reopenedState = await state(reopened.viewer_url);
    assert.equal(reopenedState.entities[0].state.reading.target, saved.entities[0].state.reading.target);
    assert.equal(reopenedState.entities[0].state.reading.source, saved.entities[0].state.reading.source);
    const edgeViewport = page.locator('.component-content');
    await edgeViewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await edgeViewport.hover();
    await page.mouse.wheel(0, 800);
    const boundary = await state((await shareView(page)).viewer_url);
    assert.deepEqual(boundary.state.camera, saved.state.camera, 'wheel at the content boundary must not zoom the camera');
    await page.goto(shared.viewer_url);
    await page.locator('.component-content pre').filter({hasText:'source line 4322:'}).waitFor();
    await page.locator('.component-handle').dblclick();
    await page.locator('.component-dialog[open]').waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'返回场景',exact:true}).click();
    const returnedLinks = await shareView(page);
    const returned = await state(returnedLinks.viewer_url);
    assert.equal(returned.entities[0].state.reading.target,saved.entities[0].state.reading.target,'fullscreen/reflow/return must retain the source target');
    await page.locator('#fit-view').click();
    await page.waitForFunction(() => { const box=document.querySelector('.component-content').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth; });
    await page.getByRole('button',{name:'全屏 review.log',exact:true}).click();
    await page.locator('.component-dialog.fullscreen-dialog[open]').waitFor();
    await page.locator('.component-dialog .component-content').hover();
    await page.mouse.wheel(0, 700);
    await page.getByRole('button',{name:'返回场景',exact:true}).click();
    const continued = await state((await shareView(page)).viewer_url);
    assert.notEqual(continued.entities[0].state.reading.target, saved.entities[0].state.reading.target, 'reading in fullscreen must update the returned spatial source target');
    await page.locator('#brush-tool').click();
    await page.getByRole('button',{name:'点',exact:true}).click();
    await page.getByRole('button',{name:'更多',exact:true}).click();
    const markingBox = await page.locator('.component-content').boundingBox();
    await page.mouse.click(markingBox.x+markingBox.width*.35,markingBox.y+markingBox.height*.3);
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('textbox',{name:'标注名称',exact:true}).fill('Rendering boundary');
    await page.getByRole('textbox',{name:'标注名称',exact:true}).press('Tab');
    await page.getByRole('button',{name:'完成标注',exact:true}).click();
    const markedLinks = await shareView(page);
    const marked = await state(markedLinks.viewer_url);
    assert.equal(marked.entities[0].state.marks[0].label,'Rendering boundary');
    assert.equal(marked.entities[0].state.marks[0].anchors[0].source,saved.entities[0].state.reading.source);
    assert.deepEqual(marked.state.strokes,[],'content annotation must not create a camera-scoped screen stroke');
    await page.goto(markedLinks.viewer_url);
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('button',{name:'添加内容标注',exact:true}).click();
    await page.getByRole('button',{name:'Rendering boundary',exact:true}).waitFor();
    const png = await fetch(markedLinks.image_url);
    assert.equal(png.status,200);
    const pixels = await page.evaluate(async data => {
      const image=new Image(); image.src=data; await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const rgba=context.getImageData(0,0,canvas.width,canvas.height).data;
      let red=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i]>180&&rgba[i+1]<150&&rgba[i+2]<150)red++;
      return red;
    },`data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString('base64')}`);
    assert.ok(pixels>10,'real PNG export must include the visible content mark');
    for (const [filename, source, expected] of [
      ['architecture.mmd', 'flowchart LR\nsubgraph frontend[Frontend]\nclient[Client]\nend\nsubgraph backend[Backend]\nserver[Server]\nend\nclient --> server', ['Client','Server']],
      ['architecture.dot', 'digraph { subgraph cluster_storage { label="Storage"; cache; database; } client -> cache; cache -> database; }', ['client','database']],
      ['diagrams.md', '# Review\n\n```mermaid\nflowchart LR\nclient[Client] --> server[Server]\n```\n\n```dot\ndigraph { cache -> database; }\n```', ['Client','database']],
    ]) {
      const file=join(directory,filename);await writeFile(file,source);
      const graphLinks=JSON.parse(cli(['share',file,'--format','json']));
      await page.goto(`${graphLinks.viewer_url}?render=1`);
      await page.waitForFunction(()=>document.documentElement.dataset.renderStatus==='ready');
      const text=await page.locator('.component-content svg').evaluateAll(nodes=>nodes.map(node=>node.textContent).join('\n'));
      for(const label of expected)assert.ok(text.includes(label),`vector diagram is missing ${label}`);
      assert.equal(await page.locator('.component-content svg script, .component-content svg image[href^="http"]').count(),0);
      const graphPng = await fetch(graphLinks.image_url);
      assert.equal(graphPng.status,200,`isolated PNG ${filename}: ${graphPng.ok ? '' : `${await graphPng.text()}\n${serverLog}`}`);
      if (filename === 'architecture.mmd') {
        await page.goto(graphLinks.viewer_url);
        await page.locator('.diagram-canvas > svg').waitFor();
        await page.getByRole('button',{name:'更多',exact:true}).click();
        for (let step=0;step<6;step++) await page.getByRole('button',{name:'放大',exact:true}).click();
        await page.getByRole('button',{name:'更多',exact:true}).click();
        const viewport = page.locator('.diagram-viewport');
        await viewport.evaluate(element => {
          element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
        });
        const beforeZoom = await state((await shareView(page)).viewer_url);
        const svgBox = await page.locator('.diagram-canvas > svg').boundingBox();
        await viewport.hover();
        await page.keyboard.down('Control');
        try { await page.mouse.wheel(0,-150); } finally { await page.keyboard.up('Control'); }
        await page.waitForFunction(width => document.querySelector('.diagram-canvas > svg').getBoundingClientRect().width > width, svgBox.width);
        const afterZoom = await state((await shareView(page)).viewer_url);
        const beforeReading = beforeZoom.entities[0].state.reading, afterReading = afterZoom.entities[0].state.reading;
        assert.ok(afterZoom.entities[0].state.zoom > beforeZoom.entities[0].state.zoom,'Ctrl+wheel must zoom the diagram');
        assert.equal(afterReading.target,beforeReading.target);
        assert.ok(Math.abs(afterReading.x-beforeReading.x)<.01 && Math.abs(afterReading.y-beforeReading.y)<.01,
          'diagram zoom must retain the source point at the viewport center, not also scroll');
        assert.deepEqual(afterZoom.state.camera,beforeZoom.state.camera,'diagram zoom must not navigate the scene camera');
        await page.getByRole('button',{name:'更多',exact:true}).click();
        await page.getByRole('combobox',{name:'图层',exact:true}).selectOption('depth');
        await page.getByRole('button',{name:'屏幕画笔',exact:true}).click();
        await page.locator('#surface-toolbar:not([hidden])').waitFor();
        await page.mouse.move(90,450); await page.mouse.down();
        await page.mouse.move(270,520,{steps:8}); await page.mouse.up();
        await page.locator('#surface-done').click();
        const depthInkLinks = await shareView(page);
        const depthInk = await state(depthInkLinks.viewer_url);
        assert.equal(depthInk.state.strokes.length,1);
        assert.equal(depthInk.entities[0].state.layer,'depth');
        await page.goto(depthInkLinks.viewer_url);
        await page.locator('.diagram-semantic-depth').waitFor();
        const reopenedDepth = await state((await shareView(page)).viewer_url);
        assert.deepEqual(reopenedDepth.state.strokes,depthInk.state.strokes,'initial graph layer/reading restore must retain saved screen ink');
        assert.equal(reopenedDepth.entities[0].state.layer,'depth');
      }
    }
    await page.goto(markedLinks.viewer_url);
    await page.getByRole('button',{name:'全屏 review.log',exact:true}).click();
    await page.locator('.component-dialog[open]').waitFor();
    await page.getByRole('button',{name:'更多',exact:true}).click();
    await page.getByRole('button',{name:'屏幕画笔',exact:true}).click();
    await page.waitForFunction(() => !document.querySelector('.component-dialog').open);
    await page.locator('#surface-toolbar:not([hidden])').waitFor();
    await page.mouse.move(90,450); await page.mouse.down();
    await page.mouse.move(270,520,{steps:8}); await page.mouse.up();
    await page.locator('#surface-done').click();
    const screenMarked = await state((await shareView(page)).viewer_url);
    assert.equal(screenMarked.state.strokes.length,1,'fullscreen screen-brush handoff must expose a usable drawing canvas');
    assert.deepEqual(screenMarked.entities[0].state.marks,marked.entities[0].state.marks,'screen brush must not replace source-anchored marks');
    const markedToken = new URL(markedLinks.viewer_url).pathname.split('/').at(-1);
    const entity = marked.entities[0];
    const invalidState = await fetch(`${origin}/api/v1/scenes/${markedToken}/share`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({meshes:[],state:marked.state,entities:[{
        id:entity.id,position:entity.position,size:entity.size,visible:entity.visible,
        opacity:entity.opacity,state:{marks:[{id:'invalid',anchors:null}]},
      }]}),
    });
    const rejection = await invalidState.json();
    assert.ok(invalidState.status >= 400 && invalidState.status < 500,'malformed native state must be rejected as invalid input');
    assert.match(rejection.error,/invalid native mark/);
    assert.deepEqual((await state(markedLinks.viewer_url)).entities[0].state,marked.entities[0].state,'rejected updates must not mutate the original share');
    const unavailablePath = join(directory,'unavailable.txt');
    await writeFile(unavailablePath,'A second source that will be unavailable during reopen.');
    const collection = JSON.parse(cli(['share','--config','-','--format','json'],JSON.stringify({
      kind:'collection',schema_version:1,title:'Delayed source',active_scene_id:'model',scenes:[
        {id:'model',title:'Model',resources:[{path:join(root,'tests/fixtures/tetra.ply')}]},
        {id:'late',title:'Late document',resources:[{path},{path:unavailablePath}]},
      ],
    })));
    const collectionToken = new URL(collection.viewer_url).pathname.split('/').at(-1);
    const lateScene = await (await fetch(`${origin}/api/v1/scenes/${collectionToken}?scene=late`)).json();
    const savedModalResponse = await fetch(`${origin}/api/v1/scenes/${collectionToken}/share`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        active_scene_id:'model',updates:{late:{meshes:[],state:lateScene.state,
          entities:lateScene.entities.map((entity,index) => ({
            id:entity.id,position:entity.position,size:entity.size,visible:entity.visible,
            opacity:entity.opacity,state:index===0?{presentation:'fullscreen'}:{},
          })),
        }},strokes:[],
      }),
    });
    const savedModalCollection = await savedModalResponse.json();
    assert.equal(savedModalResponse.status,200,JSON.stringify(savedModalCollection));
    let releaseLate, sourceRequested;
    const heldSource = new Promise(resolve => { releaseLate=resolve; });
    const requestedSource = new Promise(resolve => { sourceRequested=resolve; });
    await page.route(/\/attachments\/\d+\?scene=late$/,async route => {
      if (/\/attachments\/1\?/.test(route.request().url())) {
        await route.fulfill({status:410,contentType:'application/json',body:'{"error":"Source unavailable"}'});
        return;
      }
      sourceRequested(); await heldSource; await route.continue();
    });
    await page.setViewportSize({width:1280,height:800});
    await page.goto(savedModalCollection.viewer_url);
    await requestedSource;
    await page.frameLocator('[data-scene="model"] iframe').locator('#loading-state').waitFor({state:'hidden'});
    await page.locator('#brush-tool').click();
    await page.locator('.collection-shell #surface-toolbar [data-surface-mode="screen"]').click();
    await page.mouse.move(180,450); await page.mouse.down();
    await page.mouse.move(1050,520,{steps:10}); await page.mouse.up();
    await page.locator('.collection-shell #surface-done').click();
    releaseLate();
    const lateFrame = page.frameLocator('[data-scene="late"] iframe');
    await lateFrame.locator('.component-content pre').filter({hasText:'source line 4322:'}).waitFor();
    await lateFrame.locator('.component-content').filter({hasText:'source line 4322:'}).evaluate(element => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    assert.equal(await page.locator('.collection-card.active').getAttribute('data-scene'),'model','background saved presentation must not steal scene focus');
    assert.equal(await lateFrame.locator('.component-dialog[open]').count(),0,'inactive saved content modal must remain deferred');
    const delayedLinks = await shareView(page);
    assert.equal((await state(delayedLinks.viewer_url)).strokes.length,1,'background initial source installation must preserve collection screen ink');
    await page.getByRole('button',{name:'Late document',exact:true}).click();
    await lateFrame.locator('.component-dialog[open]').waitFor();
    await lateFrame.getByRole('button',{name:'返回场景',exact:true}).click();
    await page.unroute(/\/attachments\/\d+\?scene=late$/);
    assert.deepEqual(errors,[]);
    await writeFile(path,'source changed after share');
    const oldSource = await fetch(new URL(saved.attachments[0].url, `${origin}/`));
    assert.equal(oldSource.status,410,'old anchors must not be rendered against replaced source bytes');
  } finally {
    await browser?.close();
    if(server) { server.kill(); await new Promise(resolve=>server.once('exit',resolve)); }
    await rm(directory,{recursive:true,force:true});
  }
});
