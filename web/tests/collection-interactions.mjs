import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

async function clickDisplay(page) {
  if (await page.locator('.dock-observe').getAttribute('aria-hidden') === 'true') await page.locator('#observe-trigger').click();
  if (await page.locator('[data-observe-category="light"]').getAttribute('aria-expanded') === 'false') await page.locator('[data-observe-category="light"]').click();
}

async function operation(page, name, params = {}) {
  const result = await page.evaluate(({name, params}) => window.blind.execute(name, params), {name, params});
  assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.error)}`);
  assert.equal(typeof result.revision, 'number');
  return result.value;
}

async function sceneOperation(page, sceneId, name, params = {}) {
  return await operation(page, 'collection:scene-execute', {sceneId, operation: name, params});
}

async function waitForCollectionInkCleared(page) {
  return await page.evaluate(() => new Promise((resolve, reject) => {
    const api = window.blind;
    let finished = false;
    const unsubscribe = api.subscribe(event => {
      if (event.domain === 'annotation' || event.domain === 'collection:scene') void check();
    });
    const timeout = setTimeout(() => finish(new Error('Collection framing did not clear ink and history')), 10000);
    function finish(error, state) {
      if (finished) return;
      finished = true; clearTimeout(timeout); unsubscribe();
      if (error) reject(error); else resolve(state);
    }
    async function check() {
      const result = await api.execute('collection:get', {});
      if (!result.ok) return finish(new Error(JSON.stringify(result.error)));
      const state = result.value;
      if (!state.strokes.length && !state.canUndo && !state.canRedo) finish(undefined, state);
    }
    void check();
  }));
}

async function waitForCollectionReady(page, sceneIds) {
  assert.ok(sceneIds.length, 'collection readiness requires explicit scene IDs');
  return await page.evaluate(sceneIds => new Promise((resolve, reject) => {
    const api = window.blind;
    let finished = false;
    const unsubscribe = api.subscribe(event => {
      if (event.domain === 'collection' || event.domain === 'collection:scene') void check();
    });
    const timeout = setTimeout(() => finish(new Error(`Collection scenes did not become ready: ${sceneIds.join(', ')}`)), 30000);
    function finish(error, state) {
      if (finished) return;
      finished = true; clearTimeout(timeout); unsubscribe();
      if (error) reject(error); else resolve(state);
    }
    async function check() {
      try {
        const result = await api.execute('collection:get', {});
        if (!result.ok) throw new Error(`collection:get: ${JSON.stringify(result.error)}`);
        const state = result.value;
        if (state.scenes.length === sceneIds.length && sceneIds.every(id => state.scenes.some(scene => scene.id === id && scene.ready)))
          finish(undefined, state);
      } catch (error) { finish(error); }
    }
    void check();
  }), sceneIds);
}

async function waitForContentReady(page, sceneId, id) {
  return await page.evaluate(({sceneId, id}) => new Promise((resolve, reject) => {
    const api = window.blind;
    let finished = false;
    const unsubscribe = api.subscribe(event => {
      if (event.domain === 'collection:scene' && event.data.sceneId === sceneId) void check();
    });
    const timeout = setTimeout(() => finish(new Error(`Content did not become ready: ${sceneId}/${id}`)), 30000);
    function finish(error, content) {
      if (finished) return;
      finished = true; clearTimeout(timeout); unsubscribe();
      if (error) reject(error); else resolve(content);
    }
    async function check() {
      try {
        const result = await api.execute('collection:scene-execute', {sceneId, operation: 'content:get', params: {id}});
        if (!result.ok) throw new Error(`content:get: ${JSON.stringify(result.error)}`);
        if (result.value.unavailable) throw new Error(result.value.unavailable);
        if (result.value.ready) finish(undefined, result.value);
      } catch (error) { finish(error); }
    }
    void check();
  }), {sceneId, id});
}

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = join(root, 'target/debug/blind');
const fixture = fileURLToPath(new URL('../../tests/fixtures/tetra.ply', import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('collection layout, focused toolbar, independent rendering, and scene switching', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'blind-collection-browser-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {...process.env, BLIND_CONFIG_DIR: join(directory, 'server'), BLIND_CLIENT_DIR: join(directory, 'client')};
  const cli = (args, input) => {
    const result = spawnSync(binary, args, {env, input, encoding: 'utf8', timeout: 90000});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  let server, browser;
  try {
    cli(['init', '--host', origin]);
    server = spawn(binary, ['serve', '--listen', `127.0.0.1:${port}`], {env, stdio: 'pipe'});
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/api/v1/health`)).ok) break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      if (i === 99) throw new Error('Blind server did not start');
    }
    const config = {kind:'collection',schema_version:1,title:'Review pair',active_scene_id:'design',scenes:[
      {id:'design',title:'Design',resources:[{path:fixture}]},
      {id:'scan',title:'Scan',resources:[{path:fixture}]},
    ]};
    const shared = JSON.parse(cli(['share','--config','-','--format','json'], JSON.stringify(config)));
    browser = await chromium.launch({headless:true, executablePath:process.env.BLIND_TEST_CHROMIUM || undefined,
      args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors = [];
    let overviewRequests = 0;
    page.on('request', request => {
      if (request.method() === 'GET' && request.url() === `${origin}/api/v1/scenes/${shared.viewer_url.split('/').at(-1)}`) overviewRequests++;
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(shared.viewer_url);
    await page.locator('.collection-shell.collection-split').waitFor();
    assert.equal(overviewRequests, 1, 'opening a collection should fetch its overview once');
    const childPage = await browser.newPage({viewport:{width:1280,height:800}});
    await childPage.goto(shared.scenes[1].viewer_url);
    await childPage.locator('#loading-state').waitFor({state:'hidden'});
    assert.equal(await childPage.locator('.collection-shell').count(), 0, 'a child viewer URL should open one scene');
    assert.equal(await childPage.getByRole('tablist', {name:'场景切换'}).count(), 0, 'one scene does not need collection tabs');
    assert.equal(await childPage.locator('.collection-scene-expand').count(), 0, 'one scene does not need a pane expansion control');
    await childPage.close();
    assert.equal(await page.locator('.collection-shell .topbar').count(), 0);
    assert.equal(await page.locator('.collection-shell .review-dock #share-view').count(), 1);
    assert.ok((await page.locator('.collection-stage').boundingBox()).y <= 10);
    assert.ok((await page.locator('.collection-stage').boundingBox()).y + (await page.locator('.collection-stage').boundingBox()).height >= 798);
    await page.locator('.collection-frame').first().waitFor();
    assert.equal(await page.locator('.collection-frame').count(), 2);
    assert.equal(await page.locator('.collection-card.active').getAttribute('data-scene'), 'design');
    const scan = page.frameLocator('.collection-card[data-scene="scan"] iframe');
    const design = page.frameLocator('.collection-card[data-scene="design"] iframe');
    await scan.locator('#loading-state').waitFor({state:'hidden'});
    await design.locator('#loading-state').waitFor({state:'hidden'});
    await waitForCollectionReady(page, ['design', 'scan']);
    const initialScanView = await sceneOperation(page, 'scan', 'view:get');
    const initialDesignView = await sceneOperation(page, 'design', 'view:get');
    assert.equal(await page.evaluate(() => window.blind.version), 1);
    const rootCatalog = await page.evaluate(() => window.blind.catalog());
    const stateDescriptor = rootCatalog.find(entry => entry.name === 'collection:get');
    assert.equal(stateDescriptor.outputSchema.properties.activeSceneId.type, 'string');
    assert.equal(stateDescriptor.outputSchema.properties.scenes.items.properties.parked.type, 'boolean');
    const snapshotDescriptor = rootCatalog.find(entry => entry.name === 'collection:scene-snapshot');
    assert.deepEqual(snapshotDescriptor.outputSchema.properties.state.properties.viewport.properties.mode.enum, ['auto', 'board', 'spatial']);
    assert.equal(snapshotDescriptor.outputSchema.properties.state.properties.strokes.items.properties.id.type, 'string');
    const catalog = await operation(page, 'collection:scene-catalog', {sceneId: 'scan'});
    assert.ok(catalog.some(entry => entry.name === 'view:get' && entry.readOnly));
    await operation(page, 'collection:select', {sceneId: 'scan'});
    const routed = await page.evaluate(async axes => {
      const request = window.blind.execute('collection:scene-execute', {sceneId: 'scan', operation: 'view:settings', params: {axes}});
      await window.blind.execute('collection:select', {sceneId: 'design'});
      return await request;
    }, !initialScanView.settings.axes);
    assert.equal(routed.ok, true);
    assert.equal((await sceneOperation(page, 'scan', 'view:get')).settings.axes, !initialScanView.settings.axes);
    assert.equal((await sceneOperation(page, 'design', 'view:get')).settings.axes, initialDesignView.settings.axes,
      'an in-flight command must retain its explicit scene ID after active scene selection changes');
    await scan.locator('#viewer').focus();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.getAttribute('data-scene') === 'scan');
    await design.locator('#viewer').focus();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.getAttribute('data-scene') === 'design');

    await page.locator('.collection-card[data-scene="scan"] .collection-scene-label').click();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.getAttribute('data-scene') === 'scan');
    await page.locator('#observe-trigger').click();
    await page.locator('#section-trigger').click();
    await scan.locator('.section-draw-overlay').waitFor({state:'visible'});
    const rect = await scan.locator('.section-draw-overlay').boundingBox();
    await page.mouse.move(rect.x + rect.width * .35, rect.y + rect.height * .5);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .65, rect.y + rect.height * .5, {steps:8});
    await page.mouse.up();
    await scan.locator('.section-panel').waitFor({state:'visible'});
    assert.equal(await design.locator('.section-panel').isVisible(), false, 'a section belongs to one scene');
    await page.locator('.collection-card[data-scene="design"] .collection-scene-label').click();
    await scan.locator('.section-panel').waitFor({state:'hidden'});
    await page.locator('.collection-card[data-scene="scan"] .collection-scene-label').click();
    await scan.locator('.section-panel').waitFor({state:'visible'});
    await scan.locator('button[aria-label="关闭剖面观察"]').click();
    await page.locator('[data-observe-category="shading"]').click();
    await page.locator('.collection-shell [data-shading="wire"]').click();
    assert.equal((await sceneOperation(page, 'scan', 'view:get')).settings.shading, 'wire');
    await clickDisplay(page);
    await page.locator('.collection-shell .review-dock [data-observe-mode="raking"]').click();
    await sceneOperation(page, 'scan', 'view:settings', {light: {azimuth: 0, elevation: 45, intensity: .6}});
    await page.locator('#light-intensity').fill('100');
    assert.equal((await sceneOperation(page, 'scan', 'view:get')).settings.light.intensity, 1,
      'the collection percent slider must convert 100 percent to unit scene intensity');
    await sceneOperation(page, 'scan', 'view:settings', {light: {azimuth: -40, elevation: 25, intensity: 1.4}});
    assert.equal(await page.locator('#light-intensity').inputValue(), '140');
    assert.equal(await page.locator('#light-intensity-value').textContent(), '140%',
      'scene intensity must be displayed in percent after semantic changes');
    await page.locator('.collection-shell .review-dock [data-observe-mode="normals"]').click();
    await page.locator('.collection-card[data-scene="design"] .collection-scene-label').click();
    await clickDisplay(page);
    assert.equal(await design.locator('[data-observe-mode="matte"]').getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', {name:'放大 Scan', exact:true}).click();
    await page.locator('.collection-shell.collection-maximized').waitFor();
    const fullStage = await page.locator('.collection-stage').boundingBox();
    const fullScene = await page.locator('.collection-card[data-scene="scan"]').boundingBox();
    assert.deepEqual(fullScene, fullStage, 'the expanded scene must occupy the full viewing area');
    assert.equal(await page.locator('.collection-card[data-scene="design"]').isVisible(), false);
    assert.equal(await page.getByRole('tab', {name:'Scan', exact:true}).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', {name:'Design', exact:true}).click();
    assert.equal(await page.locator('.collection-card[data-scene="design"]').isVisible(), true);
    assert.equal(await page.locator('.collection-card[data-scene="scan"]').isVisible(), false);
    assert.equal(await design.locator('[data-observe-mode="matte"]').getAttribute('aria-pressed'), 'true');
    await page.getByRole('tab', {name:'Design', exact:true}).press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.dataset.scene === 'scan');
    assert.equal(await scan.locator('[data-observe-mode="normals"]').getAttribute('aria-pressed'), 'true', 'tab switching must retain the other scene rendering state');
    await page.getByRole('button', {name:'还原分屏', exact:true}).click();
    await page.locator('.collection-shell.collection-split').waitFor();
    assert.equal(await page.locator('.collection-card[data-scene="design"]').isVisible(), true);
    assert.equal(await page.locator('.collection-card[data-scene="scan"]').isVisible(), true);
    assert.equal(await page.getByRole('tablist', {name:'场景切换'}).isVisible(), false);
    await page.locator('.collection-card[data-scene="design"] .collection-scene-label').click();

    const shareResponse = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST');
    await page.locator('#observe-back').click();
    await page.locator('#share-view').click();
    const response = await shareResponse;
    assert.equal(response.status(), 200, await response.text());
    const link = await response.json();
    const savedToken = link.viewer_url.split('/').at(-1);
    const savedScan = await (await fetch(`${origin}/api/v1/scenes/${savedToken}?scene=scan`)).json();
    const savedDesign = await (await fetch(`${origin}/api/v1/scenes/${savedToken}?scene=design`)).json();
    assert.equal(savedScan.state.render_mode, 'normals');
    assert.equal(savedScan.state.shading, 'wire', 'collection shading must reach the active scene');
    assert.equal(savedDesign.state.render_mode, 'matte');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
      writeText: async value => { window.copiedCollection = value; },
    }}));
    await page.locator('.collection-share button', {hasText:'全部场景视角链接'}).click();
    assert.equal(await page.evaluate(() => window.copiedCollection), link.viewer_url);
    await page.evaluate(() => {
      window.clipboardWriteStarted = false;
      navigator.clipboard.write = async () => { window.clipboardWriteStarted = true; };
    });
    const {promise: sharePaused, resolve: releaseShare} = Promise.withResolvers();
    const sharePattern = '**/api/v1/scenes/*/share';
    await page.route(sharePattern, async route => {
      await sharePaused;
      await route.continue();
    });
    await page.locator('.collection-card[data-scene="design"] .collection-scene-label').focus();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+c`);
    assert.equal(await page.evaluate(() => window.clipboardWriteStarted), true,
      'clipboard write must start before the collection reshare request returns');
    const shortcutResponse = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST', {timeout:10000});
    releaseShare();
    await shortcutResponse;
    await page.unroute(sharePattern);
    const reopened = await browser.newPage({viewport:{width:1280,height:800}});
    await reopened.goto(link.viewer_url);
    await reopened.locator('.collection-shell.collection-split').waitFor();
    assert.equal(await reopened.locator('.collection-card').count(), 2);
    await reopened.close();

    await page.locator('#brush-tool').click();
    await page.waitForFunction(() => document.querySelector('.collection-shell')?.classList.contains('annotation-mode'));
    assert.equal(await page.locator('.collection-shell > #surface-toolbar').isVisible(), true);
    assert.equal(await design.locator('#surface-toolbar').isVisible(), false);
    await page.locator('.collection-shell > #surface-toolbar #surface-brush').click();
    await page.locator('.collection-markup.enabled').waitFor();
    const inkBounds = await page.locator('.collection-stage').boundingBox();
    const inkY = inkBounds.y + inkBounds.height * .4;
    await page.mouse.move(inkBounds.x + inkBounds.width * .25, inkY);
    await page.mouse.down();
    await page.mouse.move(inkBounds.x + inkBounds.width * .4, inkY, {steps:8});
    assert.deepEqual((await operation(page, 'collection:get')).strokes, [],
      'a held collection pointer draft must not be committed by child tool settlement or a pure query');
    await page.mouse.move(inkBounds.x + inkBounds.width * .75, inkY, {steps:16});
    await page.mouse.up();
    const inkShare = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST');
    await page.locator('.collection-shell > #surface-toolbar #share-view').click();
    const inkResponse = await inkShare;
    const inkPayload = inkResponse.request().postDataJSON();
    assert.equal(inkPayload.strokes.length, 1);
    assert.match(inkPayload.strokes[0].id, /^[0-9a-f-]{36}$/i, 'shared collection strokes carry stable IDs');
    assert.ok(inkPayload.strokes[0].points[0][0] < .5 && inkPayload.strokes[0].points.at(-1)[0] > .5);
    assert.ok(Math.abs(inkPayload.strokes[0].points[0][0] - .25) < .01);
    assert.ok(Math.abs(inkPayload.strokes[0].points.at(-1)[0] - .75) < .01,
      'physical split ink uses the entire collection viewport, not a child pane or a prematurely finished gesture');
    assert.deepEqual(inkPayload.updates.design.state.strokes, [],
      'collection screen ink must not be duplicated in the focused child snapshot');
    assert.deepEqual(inkPayload.updates.scan.state.strokes, []);
    assert.equal(inkPayload.layout.columns, 2);
    const inkLinks = await inkResponse.json();
    const inkToken = inkLinks.viewer_url.split('/').at(-1);
    assert.equal((await (await fetch(`${origin}/api/v1/scenes/${inkToken}`)).json()).strokes.length, 1);
    const inkImage = Buffer.from(await (await fetch(inkLinks.image_url)).arrayBuffer());
    assert.equal(inkImage.readUInt32BE(16), Math.round(inkBounds.width));
    assert.equal(inkImage.readUInt32BE(20), Math.round(inkBounds.height));
    await page.locator('.collection-share button', {hasText:'关闭'}).click();
    await page.evaluate(() => {
      window.collectionFrames = [...document.querySelectorAll('.collection-frame')].map(frame => frame.contentWindow);
    });
    await page.getByRole('button', {name:'放大 Design', exact:true}).click();
    await page.locator('.collection-shell.collection-maximized').waitFor();
    await design.locator('.app-shell.surface-mode').waitFor({state:'hidden'});
    await page.locator('.collection-shell > #surface-toolbar').waitFor({state:'hidden'});
    assert.equal(await design.locator('#brush-tool').getAttribute('aria-pressed'), 'false',
      'maximizing the already focused pane must finish its child annotation tool');
    const maximizedShare = page.waitForRequest(request => request.url().endsWith('/share') && request.method() === 'POST');
    await page.locator('#share-view').click();
    const maximizedPayload = (await maximizedShare).postDataJSON();
    assert.deepEqual(maximizedPayload.strokes, inkPayload.strokes, 'maximizing parks rather than deletes split ink');
    assert.deepEqual(maximizedPayload.layout, inkPayload.layout, 'parked ink retains its captured split layout');
    await page.locator('.collection-share button', {hasText:'关闭'}).click();

    await page.locator('#brush-tool').click();
    await page.locator('.collection-shell > #surface-toolbar').waitFor({state:'visible'});
    await page.locator('.collection-shell > #surface-toolbar [data-surface-mode="point"]').click();
    await page.getByRole('tab', {name:'Scan', exact:true}).click();
    await design.locator('.app-shell.surface-mode').waitFor({state:'hidden'});
    await page.locator('.collection-shell > #surface-toolbar').waitFor({state:'hidden'});
    await page.getByRole('tab', {name:'Design', exact:true}).click();
    await design.locator('.app-shell.surface-mode').waitFor({state:'visible'});
    await page.locator('.collection-shell > #surface-toolbar').waitFor({state:'visible'});
    assert.equal(await page.locator('.collection-shell > #surface-toolbar [data-surface-mode="point"]').getAttribute('aria-pressed'), 'true',
      'returning to a tab must resume its scene tool with a visible parent toolbar');
    await page.getByRole('button', {name:'还原分屏', exact:true}).click();
    await page.locator('.collection-shell.collection-split').waitFor();
    await design.locator('.app-shell.surface-mode').waitFor({state:'hidden'});
    await page.locator('.collection-shell > #surface-toolbar').waitFor({state:'hidden'});
    assert.equal(await design.locator('#brush-tool').getAttribute('aria-pressed'), 'false',
      'restoring the already focused pane must not leave an invisible point tool active');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.collection-frame')]
      .every((frame, index) => frame.contentWindow === window.collectionFrames[index])), true,
      'maximize, tabs, and restore must retain the original scene frames');
    const restoredShare = page.waitForRequest(request => request.url().endsWith('/share') && request.method() === 'POST');
    await page.locator('#share-view').click();
    const restoredPayload = (await restoredShare).postDataJSON();
    assert.deepEqual(restoredPayload.strokes, inkPayload.strokes, 'restoring the unchanged split must retain its ink');
    assert.deepEqual(restoredPayload.updates.design.state.camera, inkPayload.updates.design.state.camera,
      'view toggles must not move the first scene camera');
    assert.deepEqual(restoredPayload.updates.scan.state.camera, inkPayload.updates.scan.state.camera,
      'view toggles must not move the second scene camera');
    await page.locator('.collection-share button', {hasText:'关闭'}).click();
    await page.locator('#brush-tool').click();
    await page.locator('.collection-markup.enabled').waitFor();
    await page.locator('.collection-shell > #surface-toolbar #surface-undo').click();
    assert.equal(await page.locator('.collection-shell > #surface-toolbar #surface-redo').isEnabled(), true,
      'unchanged view toggles must retain the collection undo history');
    await page.locator('.collection-shell > #surface-toolbar #surface-redo').click();
    assert.equal(await page.locator('.collection-ink-badges button').count(), 1);
    assert.deepEqual((await operation(page, 'collection:get')).strokes, inkPayload.strokes,
      'global undo and redo restore the same stable stroke ID and combined coordinates');
    const displayView = await sceneOperation(page, 'design', 'view:get');
    await sceneOperation(page, 'design', 'view:settings', {
      background: displayView.settings.background === 'dark' ? 'light' : 'dark',
      shading: 'wire', light: {azimuth: 30, elevation: 20, intensity: 1},
    });
    await sceneOperation(page, 'design', 'view:settings', {projection: displayView.settings.projection});
    await sceneOperation(page, 'design', 'view:settings', {});
    assert.deepEqual((await operation(page, 'collection:get')).strokes, inkPayload.strokes,
      'display-only and no-op view notifications must retain global ink');
    await operation(page, 'annotation:undo');
    await sceneOperation(page, 'design', 'view:settings', {axes: !displayView.settings.axes});
    assert.equal((await operation(page, 'collection:get')).canRedo, true,
      'display changes must also retain ink that exists only in redo history');
    await operation(page, 'annotation:redo');
    await page.locator('.collection-shell > #surface-toolbar #surface-done').click();
    await page.getByRole('button', {name:'放大 Design', exact:true}).click();
    await page.locator('.collection-shell.collection-maximized').waitFor();
    const parkedDisplay = await sceneOperation(page, 'scan', 'view:get');
    await sceneOperation(page, 'scan', 'view:settings', {background: parkedDisplay.settings.background === 'dark' ? 'light' : 'dark'});
    await sceneOperation(page, 'scan', 'view:settings', {projection: parkedDisplay.settings.projection});
    await operation(page, 'collection:set-layout', {maximized: false});
    assert.deepEqual((await operation(page, 'collection:get')).strokes, inkPayload.strokes,
      'parked display-only events must not mark the captured split ink invalid');
    await operation(page, 'collection:set-layout', {sceneId: 'design', maximized: true});
    await sceneOperation(page, 'scan', 'view:settings', {projection: 'orthographic'});
    assert.equal(await page.locator('.collection-ink-badges button').count(), 1,
      'a parked scene change must not immediately delete hidden collection ink');
    await page.getByRole('button', {name:'还原分屏', exact:true}).click();
    await page.locator('.collection-shell.collection-split').waitFor();
    await page.waitForFunction(() => !document.querySelector('.collection-ink-badges button'));
    assert.equal(await page.locator('.collection-ink-badges button').count(), 0,
      'returning to a genuinely changed split composition must invalidate its stale screen ink');

    await page.locator('#brush-tool').click();
    await page.locator('.collection-markup.enabled').waitFor();
    await page.mouse.move(inkBounds.x + inkBounds.width * .25, inkY);
    await page.mouse.down();
    await page.mouse.move(inkBounds.x + inkBounds.width * .75, inkY, {steps:24});
    await page.mouse.up();
    await page.locator('.collection-shell > #surface-toolbar #surface-undo').click();
    assert.equal(await page.locator('.collection-shell > #surface-toolbar #surface-redo').isEnabled(), true,
      'undo must retain a redo copy until the scene view actually changes');
    await page.locator('.collection-shell > #surface-toolbar #surface-redo').click();
    assert.equal(await page.locator('.collection-ink-badges button').count(), 1);
    await page.locator('.collection-shell > #surface-toolbar #surface-undo').click();
    await sceneOperation(page, 'design', 'view:settings', {projection: 'orthographic'});
    await page.waitForFunction(() => document.querySelector('.collection-shell > #surface-toolbar #surface-redo')?.disabled);
    assert.equal(await page.locator('.collection-ink-badges button').count(), 0,
      'an actual visible camera change invalidates ink even when it exists only in redo history');
    await page.mouse.move(inkBounds.x + inkBounds.width * .25, inkY);
    await page.mouse.down();
    await page.mouse.move(inkBounds.x + inkBounds.width * .75, inkY, {steps:24});
    await page.mouse.up();
    assert.equal(await page.locator('.collection-ink-badges button').count(), 1);
    await page.setViewportSize({width:1400,height:800});
    await page.waitForFunction(() => document.querySelector('.collection-stage')?.clientWidth === 1400 &&
      !document.querySelector('.collection-ink-badges button'));
    assert.equal(await page.locator('.collection-shell > #surface-toolbar #surface-undo').isEnabled(), false,
      'a changed split viewport must invalidate both screen ink and its undo copies');
    assert.equal(await page.locator('.collection-shell > #surface-toolbar').isVisible(), true,
      'viewport invalidation must not leave active annotation input without its toolbar');
    await page.setViewportSize({width:800,height:640});
    await page.locator('.collection-shell.collection-single').waitFor();
    assert.equal(await page.locator('.collection-shell').evaluate(element => element.classList.contains('annotation-mode')), true,
      'resizing must retain the active scene annotation tool');
    await page.locator('.collection-shell > #surface-toolbar #surface-done').click();
    const loneCard = page.locator('.collection-card.active');
    assert.equal(await loneCard.locator('.collection-scene-label').isVisible(), false);
    assert.equal((await loneCard.boundingBox()).x, 0);

    await page.setViewportSize({width:390,height:844});
    await page.locator('.collection-shell.collection-single').waitFor();
    assert.equal((await page.locator('.collection-stage').boundingBox()).y, 0, 'scene tabs overlay the full viewport');
    assert.ok((await page.locator('.collection-stage').boundingBox()).y + (await page.locator('.collection-stage').boundingBox()).height >= 842);
    await page.getByRole('tab', {name:'Scan', exact:true}).click();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.dataset.scene === 'scan');
    await page.frameLocator('.collection-card[data-scene="scan"] iframe').locator('#loading-state').waitFor({state:'hidden'});
    await clickDisplay(page);
    assert.equal(await page.frameLocator('.collection-card[data-scene="scan"] iframe').locator('[data-observe-mode="normals"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#observe-back').click();
    await page.locator('#fit-view').click();
    await page.waitForTimeout(300);
    const mobileShare = page.waitForRequest(request => request.url().endsWith('/share') && request.method() === 'POST');
    await page.locator('#share-view').click();
    const scanUpdate = (await mobileShare).postDataJSON().updates.scan;
    assert.ok(Math.abs(scanUpdate.state.camera.target[1] - (scanUpdate.entities[0].position[1] + .5)) < .1,
      'Fit must use the restored component position after switching to tabs');
    await page.locator('.collection-share button', {hasText:'关闭'}).click();
    await page.setViewportSize({width:320,height:700});
    await page.locator('.collection-shell.collection-single').waitFor();
    const dockBounds = await page.locator('.collection-shell .review-dock').boundingBox();
    assert.ok(dockBounds.x >= 0 && dockBounds.x + dockBounds.width <= 320, 'the dock must fit at 320px');
    await page.setViewportSize({width:390,height:844});
    assert.deepEqual(errors, []);
    if (process.env.BLIND_TEST_SCREENSHOTS) {
      const {mkdir} = await import('node:fs/promises');
      await mkdir(process.env.BLIND_TEST_SCREENSHOTS, {recursive:true});
      await page.screenshot({path:join(process.env.BLIND_TEST_SCREENSHOTS,'collection-mobile.png')});
      await page.setViewportSize({width:1280,height:800});
      await page.locator('.collection-shell.collection-split').waitFor();
      await page.frameLocator('.collection-card[data-scene="design"] iframe').locator('#loading-state').waitFor({state:'hidden'});
      await page.frameLocator('.collection-card[data-scene="scan"] iframe').locator('#loading-state').waitFor({state:'hidden'});
      await page.screenshot({path:join(process.env.BLIND_TEST_SCREENSHOTS,'collection-desktop.png')});
    }
    const wideConfig = {...config, active_scene_id:'scene_1', scenes:Array.from({length:5}, (_, index) => ({
      id:`scene_${index + 1}`, title:`Scene ${index + 1}`, resources:[{path:fixture}],
    }))};
    const wide = JSON.parse(cli(['share','--config','-','--format','json'], JSON.stringify(wideConfig)));
    const widePage = await browser.newPage({viewport:{width:2400,height:1300}});
    await widePage.goto(wide.viewer_url);
    await widePage.locator('.collection-shell.collection-split').waitFor();
    assert.equal(await widePage.locator('.collection-card').count(), 5);
    await waitForCollectionReady(widePage, wideConfig.scenes.map(scene => scene.id));
    const wideBounds = await widePage.locator('.collection-card').evaluateAll(cards => cards.map(card => {
      const bounds = card.getBoundingClientRect();
      return {left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height};
    }));
    assert.ok(wideBounds.every(bounds => bounds.width >= 160 && bounds.height >= 135 && bounds.left >= 0 && bounds.top >= 0 &&
      bounds.right <= 2400 && bounds.bottom <= 1300), 'all five ready scene panes must have usable on-screen bounds');
    for (let index = 0; index < wideBounds.length; index++) for (const other of wideBounds.slice(index + 1)) {
      const bounds = wideBounds[index];
      assert.ok(bounds.right <= other.left || other.right <= bounds.left || bounds.bottom <= other.top || other.bottom <= bounds.top,
        'ready split panes must not overlap');
    }
    await widePage.close();
    const failedPage = await browser.newPage({viewport:{width:390,height:844}});
    await failedPage.route('**/api/v1/scenes/*?scene=*', route => route.abort());
    await failedPage.goto(shared.viewer_url);
    await failedPage.locator('.collection-shell').waitFor();
    await failedPage.locator('.collection-frame').first().waitFor();
    const unavailableSnapshot = await failedPage.evaluate(() => window.blind.execute('collection:scene-snapshot', {sceneId: 'design'}));
    assert.equal(unavailableSnapshot.ok, false);
    assert.equal(unavailableSnapshot.error.code, 'NOT_READY');
    let failedShareRequests = 0;
    failedPage.on('request', request => {if (request.method() === 'POST' && request.url().endsWith('/share')) failedShareRequests++;});
    const unavailableShare = await failedPage.evaluate(() => window.blind.execute('share:create', {}));
    assert.equal(unavailableShare.ok, false, 'unready children must reject sharing rather than reuse stale state');
    assert.equal(unavailableShare.error.code, 'NOT_READY');
    assert.equal(failedShareRequests, 0, 'no incomplete collection snapshot should be posted as a successful share');
    await failedPage.locator('#brush-tool').click();
    assert.equal(await failedPage.locator('.collection-shell > .review-dock').isVisible(), true,
      'failed child scenes must not hide the only touch controls');
    const failedChild = failedPage.frames().find(frame => new URL(frame.url()).searchParams.get('scene') === 'design');
    await failedChild.waitForFunction(() => !!window.blind);
    const unavailableLifecycle = await failedChild.evaluate(async () => {
      const api = window.blind;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
      const resumed = await api.execute('ui:get', {});
      const publishedAfterResume = window.blind === api;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
      return {resumed, publishedAfterResume, publishedAfterExit: !!window.blind, exited: await api.execute('ui:get', {})};
    });
    assert.equal(unavailableLifecycle.resumed.error.code, 'NOT_READY',
      'the unavailable-scene API must retain its unready state after BFcache restoration, not become disposed');
    assert.equal(unavailableLifecycle.publishedAfterResume, true);
    assert.equal(unavailableLifecycle.publishedAfterExit, false);
    assert.equal(unavailableLifecycle.exited.error.code, 'DISPOSED',
      'a persisted pagehide must not consume the unavailable-scene cleanup for the later real exit');
    await failedPage.close();

    await page.setViewportSize({width: 1280, height: 800});
    await operation(page, 'collection:set-layout', {sceneId: 'design', maximized: true});
    const designFrame = page.frames().find(frame => new URL(frame.url()).searchParams.get('scene') === 'design');
    await sceneOperation(page, 'design', 'annotation:screen-scope', {scope: 'scene'});
    await sceneOperation(page, 'design', 'annotation:open', {target: 'screen'});
    await sceneOperation(page, 'design', 'annotation:set-tool', {mode: 'screen'});
    const draftCanvas = designFrame.locator('#markup-canvas');
    await draftCanvas.waitFor({state: 'visible'});
    const draftBounds = await draftCanvas.boundingBox();
    const beforeDraft = await operation(page, 'collection:scene-snapshot', {sceneId: 'design'});
    await page.mouse.move(draftBounds.x + draftBounds.width * .2, draftBounds.y + draftBounds.height * .4);
    await page.mouse.down();
    await page.mouse.move(draftBounds.x + draftBounds.width * .4, draftBounds.y + draftBounds.height * .4, {steps: 8});
    const duringDraft = await operation(page, 'collection:scene-snapshot', {sceneId: 'design'});
    assert.deepEqual(duringDraft.state.strokes, beforeDraft.state.strokes, 'snapshot query must not commit the held pointer draft');
    await page.mouse.move(draftBounds.x + draftBounds.width * .8, draftBounds.y + draftBounds.height * .4, {steps: 16});
    await page.mouse.up();
    const afterDraft = await operation(page, 'collection:scene-snapshot', {sceneId: 'design'});
    assert.equal(afterDraft.state.strokes.length, beforeDraft.state.strokes.length + 1);
    const completedStroke = afterDraft.state.strokes.at(-1);
    assert.ok(completedStroke.points.at(-1)[0] > .7, 'drawing must continue past the snapshot query until pointer release');
    const prepared = await operation(page, 'collection:scene-prepare-snapshot', {sceneId: 'design'});
    assert.equal(prepared.state.strokes.at(-1).id, completedStroke.id);
    await sceneOperation(page, 'design', 'annotation:undo');
    assert.deepEqual((await operation(page, 'collection:scene-snapshot', {sceneId: 'design'})).state.strokes, beforeDraft.state.strokes);
    await sceneOperation(page, 'design', 'annotation:redo');
    assert.deepEqual((await operation(page, 'collection:scene-snapshot', {sceneId: 'design'})).state.strokes.at(-1), completedStroke,
      'scene undo and redo retain the stable child stroke independently of global collection history');

    await page.route('**/api/v1/scenes/*?scene=design', route => route.abort());
    await designFrame.goto(designFrame.url());
    await designFrame.waitForFunction(() => window.blind?.sceneId === 'design');
    const rejectedSnapshot = await page.evaluate(() => window.blind.execute('collection:scene-snapshot', {sceneId: 'design'}));
    assert.equal(rejectedSnapshot.ok, false, 'a failed replacement child must not return its previously saved snapshot');
    assert.equal(rejectedSnapshot.error.code, 'NOT_READY');
    let replacementShareRequests = 0;
    const countReplacementShare = request => {if (request.method() === 'POST' && request.url().endsWith('/share')) replacementShareRequests++;};
    page.on('request', countReplacementShare);
    const rejectedShare = await page.evaluate(() => window.blind.execute('share:create', {}));
    assert.equal(rejectedShare.ok, false, 'one failed replacement child prevents sharing a partial collection');
    assert.equal(rejectedShare.error.code, 'NOT_READY');
    assert.equal(replacementShareRequests, 0);
    page.off('request', countReplacementShare);

    const notes = join(directory, 'notes.txt'), panelSource = join(directory, 'reference.txt');
    await writeFile(notes, 'Board world content\n' + Array.from({length: 80}, (_, index) => `World line ${index + 1}`).join('\n'));
    await writeFile(panelSource, 'Pinned reference\n' + Array.from({length: 160}, (_, index) => `Panel line ${index + 1}`).join('\n'));
    const boardConfig = {kind: 'collection', schema_version: 1, title: 'Board with fixed panel', active_scene_id: 'notes', scenes: [
      {id: 'notes', title: 'Notes', viewport: {mode: 'board', board: {center: [0, 0], scale: 1}}, resources: [{path: notes}, {path: panelSource, placement: 'panel'}]},
      {id: 'other', title: 'Other notes', viewport: {mode: 'board'}, resources: [{path: notes}]},
    ]};
    const boardLinks = JSON.parse(cli(['share', '--config', '-', '--format', 'json'], JSON.stringify(boardConfig)));
    const boardPage = await browser.newPage({viewport: {width: 1280, height: 800}});
    // Exercise layout completion with browser work slower than the host operation round trip.
    await (await boardPage.context().newCDPSession(boardPage)).send('Emulation.setCPUThrottlingRate', {rate: 6});
    const coldContext = await browser.newContext({javaScriptEnabled: false});
    try {
      const coldChild = await coldContext.newPage();
      await coldChild.goto(`${boardLinks.viewer_url}?scene=notes&embedded=1`);
      assert.equal(await coldChild.locator('.review-dock').isVisible(), false,
        'embedded child chrome must be absent before any application script can run');
    } finally { await coldContext.close(); }
    const notesRequested = Promise.withResolvers(), releaseNotes = Promise.withResolvers();
    await boardPage.route(`**/api/v1/scenes/${boardLinks.viewer_url.split('/').at(-1)}?scene=notes`, async route => {
      notesRequested.resolve();
      await releaseNotes.promise;
      await route.continue();
    });
    await boardPage.goto(boardLinks.viewer_url, {waitUntil: 'commit'});
    await boardPage.locator('.collection-shell.collection-split').waitFor();
    await notesRequested.promise;
    const coldChildren = boardPage.frames().filter(frame => new URL(frame.url()).searchParams.has('embedded'));
    assert.equal(coldChildren.length, 2);
    assert.equal(await boardPage.locator('.review-dock').isVisible(), true,
      'the collection owns one global toolbar while child scene admission is held');
    const loadingChild = boardPage.frames().find(frame => new URL(frame.url()).searchParams.get('scene') === 'notes');
    assert.equal(await loadingChild.locator('.review-dock').isVisible(), false,
      'embedded child chrome must remain absent while scene admission is held');
    const loadingBoard = await operation(boardPage, 'collection:get');
    assert.deepEqual(loadingBoard.scenes.map(scene => scene.id), ['notes', 'other']);
    assert.equal(loadingBoard.scenes.find(scene => scene.id === 'notes').ready, false,
      'the real board child must remain unready while its scene response is held');
    const loadingEntities = await boardPage.evaluate(() => window.blind.execute('collection:scene-execute', {sceneId: 'notes', operation: 'entity:list', params: {}}));
    assert.equal(loadingEntities.ok, false);
    assert.equal(loadingEntities.error.code, 'NOT_READY');
    assert.equal(loadingEntities.error.target, 'notes');
    releaseNotes.resolve();
    const readyBoard = await waitForCollectionReady(boardPage, ['notes', 'other']);
    assert.equal(readyBoard.scenes.length, 2, 'readiness must not succeed on an empty scene catalog');
    assert.equal(readyBoard.scenes.every(scene => scene.ready), true,
      'readiness waits for the resolved operation value, not the truthiness of an async predicate Promise');
    for (const child of coldChildren) assert.equal(await child.locator('.review-dock').isVisible(), false,
      'ready embedded scenes must leave toolbar ownership with the collection');
    const boardScene = boardPage.frames().find(frame => new URL(frame.url()).searchParams.get('scene') === 'notes');
    const entities = await sceneOperation(boardPage, 'notes', 'entity:list');
    const pinned = entities.find(entity => entity.placement === 'panel');
    assert.ok(pinned, 'the board fixture must expose its real fixed panel entity');
    const world = entities.find(entity => entity.placement === 'world');
    assert.ok(world);
    assert.equal((await sceneOperation(boardPage, 'notes', 'view:get')).kind, 'board');
    await boardScene.locator('.component-fixed-panels .component-content').waitFor({state: 'visible'});
    const panelNode = await boardScene.$('.component-fixed-panels .component-content');
    assert.equal((await waitForContentReady(boardPage, 'notes', pinned.id)).ready, true);
    const globalStroke = {color: '#ff6b5e', aspect: 1.6, points: [[.2, .3], [.7, .4]]};
    assert.equal((await operation(boardPage, 'annotation:open')).active, true,
      'collection tools must open scene screen annotations, not the selected native document editor');
    await operation(boardPage, 'annotation:set-tool', {mode: 'screen'});
    await operation(boardPage, 'collection:screen-create', globalStroke);
    const beforeNativeScroll = await sceneOperation(boardPage, 'notes', 'content:get', {id: pinned.id});
    await sceneOperation(boardPage, 'notes', 'content:scroll', {id: pinned.id, x: 0, y: 80});
    await waitForCollectionInkCleared(boardPage);
    assert.notDeepEqual((await sceneOperation(boardPage, 'notes', 'content:get', {id: pinned.id})).state.reading,
      beforeNativeScroll.state.reading, 'the native reading gesture must actually move source framing');
    await operation(boardPage, 'collection:screen-create', globalStroke);
    await operation(boardPage, 'annotation:undo');
    assert.equal((await operation(boardPage, 'collection:get')).canRedo, true);
    await sceneOperation(boardPage, 'notes', 'content:scroll', {id: pinned.id, x: 0, y: 120});
    await waitForCollectionInkCleared(boardPage);
    await operation(boardPage, 'collection:screen-create', globalStroke);
    await sceneOperation(boardPage, 'notes', 'entity:set-style', {id: pinned.id, visible: true, opacity: .7});
    assert.equal((await operation(boardPage, 'collection:get')).strokes.length, 1,
      'unchanged reserved panel width must not invalidate collection ink');
    await sceneOperation(boardPage, 'notes', 'entity:set-style', {id: pinned.id, visible: false});
    await waitForCollectionInkCleared(boardPage);
    await operation(boardPage, 'collection:screen-create', globalStroke);
    await sceneOperation(boardPage, 'notes', 'entity:set-style', {id: pinned.id, visible: true, opacity: 1});
    await waitForCollectionInkCleared(boardPage);
    await sceneOperation(boardPage, 'notes', 'content:set-selection', {id: pinned.id, enabled: true});
    await sceneOperation(boardPage, 'notes', 'content:scroll', {id: pinned.id, x: 0, y: 160});
    await sceneOperation(boardPage, 'notes', 'view:set', {kind: 'board', center: [25, -10], scale: 1.25});
    const retainedView = await sceneOperation(boardPage, 'notes', 'view:get');
    const retainedPanel = await sceneOperation(boardPage, 'notes', 'content:get', {id: pinned.id});
    assert.equal(retainedPanel.state.selection, true, 'native selection is enabled before the board is parked');
    assert.ok(retainedPanel.state.reading, 'native reading state is available to retain across parking');
    await operation(boardPage, 'collection:set-layout', {sceneId: 'other', maximized: true});
    assert.equal((await operation(boardPage, 'collection:get')).scenes.find(scene => scene.id === 'notes').parked, true);
    assert.deepEqual((await sceneOperation(boardPage, 'notes', 'view:get')).camera, retainedView.camera);
    assert.deepEqual((await sceneOperation(boardPage, 'notes', 'content:get', {id: pinned.id})).state, retainedPanel.state);
    assert.equal(await panelNode.evaluate(node => node.isConnected && !!node.closest('.component-fixed-panels')), true,
      'parking a board retains the same native panel DOM rather than remounting it');
    await operation(boardPage, 'collection:select', {sceneId: 'notes'});
    await boardScene.locator('.component-fixed-panels').waitFor({state: 'visible'});
    assert.deepEqual((await sceneOperation(boardPage, 'notes', 'view:get')).camera, retainedView.camera);
    assert.deepEqual((await sceneOperation(boardPage, 'notes', 'content:get', {id: pinned.id})).state, retainedPanel.state);
    await operation(boardPage, 'collection:set-layout', {maximized: false});
    await operation(boardPage, 'collection:screen-create', globalStroke);
    await operation(boardPage, 'collection:set-layout', {sceneId: 'other', maximized: true});
    await sceneOperation(boardPage, 'other', 'view:pan', {delta: [10, 0]});
    assert.equal((await operation(boardPage, 'collection:get')).strokes.length, 1,
      'framing in the visible maximized child must not delete the parked split composition ink');
    await sceneOperation(boardPage, 'notes', 'content:scroll', {id: pinned.id, x: 0, y: 200});
    assert.equal((await operation(boardPage, 'collection:get')).strokes.length, 1,
      'native framing in a parked child defers invalidation until the split composition returns');
    await operation(boardPage, 'collection:set-layout', {maximized: false});
    await waitForCollectionInkCleared(boardPage);
    await boardPage.evaluate(() => {
      window.savedCollectionAPI = window.blind;
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
    });
    assert.equal((await operation(boardPage, 'collection:get')).scenes.every(scene => scene.ready), true);
    const resumedCamera = (await sceneOperation(boardPage, 'notes', 'view:get')).camera;
    await sceneOperation(boardPage, 'notes', 'view:pan', {delta: [10, 0]});
    assert.notDeepEqual((await sceneOperation(boardPage, 'notes', 'view:get')).camera, resumedCamera,
      'BFcache restoration must retain usable child transports, not only the root API');
    const exitedCollection = await boardPage.evaluate(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
      return {published: !!window.blind, result: await window.savedCollectionAPI.execute('collection:get', {})};
    });
    assert.equal(exitedCollection.published, false);
    assert.equal(exitedCollection.result.error.code, 'DISPOSED',
      'a persisted collection pagehide must preserve destructive cleanup for the later real exit');
    await panelNode.dispose();
    await boardPage.close();
  } finally {
    await browser?.close();
    if (server) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(directory,{recursive:true,force:true});
  }
});
