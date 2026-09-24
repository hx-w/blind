import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

async function clickDisplay(page) {
  if (await page.locator('.dock-observe').getAttribute('aria-hidden') === 'true') await page.locator('#observe-trigger').click();
  if (await page.locator('[data-observe-category="light"]').getAttribute('aria-expanded') === 'false') await page.locator('[data-observe-category="light"]').click();
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

test('collection layout, focused toolbar, independent rendering, and tab state', async () => {
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
    await childPage.close();
    assert.equal(await page.locator('.collection-shell .topbar').count(), 0);
    assert.equal(await page.locator('.collection-shell .review-dock #share-view').count(), 1);
    assert.ok((await page.locator('.collection-stage').boundingBox()).y <= 10);
    assert.ok((await page.locator('.collection-stage').boundingBox()).y + (await page.locator('.collection-stage').boundingBox()).height >= 798);
    await page.locator('.collection-frame').first().waitFor();
    assert.equal(await page.locator('.collection-frame').count(), 2);
    assert.equal(await page.locator('.collection-card.active').getAttribute('data-scene'), 'design');
    assert.equal(await page.locator('#fullscreen-view').count(), 0);
    const scan = page.frameLocator('.collection-card[data-scene="scan"] iframe');
    const design = page.frameLocator('.collection-card[data-scene="design"] iframe');
    await scan.locator('#loading-state').waitFor({state:'hidden'});
    await design.locator('#loading-state').waitFor({state:'hidden'});
    await scan.locator('#viewer').focus();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.getAttribute('data-scene') === 'scan');
    await design.locator('#viewer').focus();
    await page.waitForFunction(() => document.querySelector('.collection-card.active')?.getAttribute('data-scene') === 'design');

    await page.locator('.collection-card[data-scene="scan"] .collection-card-title').click();
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
    await page.locator('.collection-card[data-scene="design"] .collection-card-title').click();
    await scan.locator('.section-panel').waitFor({state:'hidden'});
    await page.locator('.collection-card[data-scene="scan"] .collection-card-title').click();
    await scan.locator('.section-panel').waitFor({state:'visible'});
    await scan.locator('button[aria-label="关闭剖面观察"]').click();
    await page.locator('[data-observe-category="shading"]').click();
    await page.locator('.collection-shell [data-shading="wire"]').click();
    await page.waitForFunction(() => document.querySelector('.collection-card[data-scene="scan"] iframe')?.contentDocument?.querySelector('[data-shading="wire"]')?.classList.contains('active'));
    await clickDisplay(page);
    await page.locator('.collection-shell .review-dock [data-observe-mode="normals"]').click();
    await page.locator('.collection-card[data-scene="design"] .collection-card-title').click();
    await clickDisplay(page);
    assert.equal(await design.locator('[data-observe-mode="matte"]').getAttribute('aria-pressed'), 'true');

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
    let releaseShare;
    const sharePaused = new Promise(resolve => { releaseShare = resolve; });
    const sharePattern = '**/api/v1/scenes/*/share';
    await page.route(sharePattern, async route => {
      await sharePaused;
      await route.continue();
    });
    await page.locator('.collection-card[data-scene="design"] .collection-card-title').focus();
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
    await page.mouse.move(inkBounds.x + inkBounds.width * .75, inkY, {steps:24});
    await page.mouse.up();
    const inkShare = page.waitForResponse(response => response.url().endsWith('/share') && response.request().method() === 'POST');
    await page.locator('.collection-shell > #surface-toolbar #share-view').click();
    const inkResponse = await inkShare;
    const inkPayload = inkResponse.request().postDataJSON();
    assert.equal(inkPayload.strokes.length, 1);
    assert.ok(inkPayload.strokes[0].points[0][0] < .5 && inkPayload.strokes[0].points.at(-1)[0] > .5);
    assert.equal(inkPayload.layout.columns, 2);
    const inkLinks = await inkResponse.json();
    const inkToken = inkLinks.viewer_url.split('/').at(-1);
    assert.equal((await (await fetch(`${origin}/api/v1/scenes/${inkToken}`)).json()).strokes.length, 1);
    const inkImage = Buffer.from(await (await fetch(inkLinks.image_url)).arrayBuffer());
    assert.equal(inkImage.readUInt32BE(16), Math.round(inkBounds.width));
    assert.equal(inkImage.readUInt32BE(20), Math.round(inkBounds.height));
    await page.locator('.collection-share button', {hasText:'关闭'}).click();
    await page.setViewportSize({width:800,height:800});
    await page.locator('.collection-shell.collection-tabbed').waitFor();
    assert.equal(await page.locator('.collection-shell').evaluate(element => element.classList.contains('annotation-mode')), false);
    assert.equal(await page.locator('.collection-shell .review-dock').isVisible(), true);
    const loneCard = page.locator('.collection-card.active');
    assert.equal(await loneCard.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    assert.equal(await loneCard.evaluate(element => getComputedStyle(element).borderRadius), '0px');
    assert.equal(await loneCard.locator('.collection-card-title').isVisible(), false);
    assert.equal((await loneCard.boundingBox()).x, 0);

    await page.setViewportSize({width:390,height:844});
    await page.locator('.collection-shell.collection-tabbed').waitFor();
    assert.ok((await page.locator('.collection-stage').boundingBox()).y <= 56, 'mobile tabs and share should occupy one top row');
    assert.equal(await page.locator('.collection-shell .review-dock .dock-main .dock-tool').count(), 4);
    assert.equal(await page.locator('.collection-shell .review-dock .dock-observe .observe-primary .dock-tool').count(), 6);
    assert.ok((await page.locator('.collection-stage').boundingBox()).y + (await page.locator('.collection-stage').boundingBox()).height >= 842);
    await page.waitForFunction(() => document.querySelectorAll('.collection-frame').length === 1);
    await page.locator('.collection-tabs [data-scene="scan"]').click();
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
    await page.locator('.collection-shell.collection-tabbed').waitFor();
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
    await widePage.close();
    const failedPage = await browser.newPage({viewport:{width:390,height:844}});
    await failedPage.route('**/api/v1/scenes/*?scene=*', route => route.abort());
    await failedPage.goto(shared.viewer_url);
    await failedPage.locator('.collection-shell').waitFor();
    await failedPage.locator('#brush-tool').click();
    assert.equal(await failedPage.locator('.collection-shell > .review-dock').isVisible(), true,
      'failed child scenes must not hide the only touch controls');
    await failedPage.close();
  } finally {
    await browser?.close();
    if (server) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await rm(directory,{recursive:true,force:true});
  }
});
