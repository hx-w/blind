import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const web = fileURLToPath(new URL('../', import.meta.url));

test('shared graph consumer uses real same-origin workers, rejects expansion, stays responsive and indexes labels once', {timeout:180000}, async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'], {cwd:web,stdio:'pipe'});
  let browser;
  try {
    for (let attempt=0;attempt<100;attempt++) {
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (attempt===99) throw new Error('Vite did not become ready');
      await new Promise(resolve => setTimeout(resolve,100));
    }
    browser = await chromium.launch({headless:true,executablePath:process.env.BLIND_TEST_CHROMIUM || undefined});
    const page = await browser.newPage();
    await page.route(`${origin}/`, route => route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'"},body:'<!doctype html><html><body></body></html>'}));
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const {renderDiagram,graphTargets} = await import('/src/graph.ts');
      const NativeWorker = window.Worker;
      const workers = [];
      window.Worker = class extends NativeWorker {
        constructor(url, options) { super(url, options); this.record = {url:String(url),terminated:false}; workers.push(this.record); }
        terminate() { this.record.terminated = true; super.terminate(); }
      };
      let ticks = 0;
      const heartbeat = setInterval(() => ticks++, 1);
      try {
        const valid = [];
        for (const source of [
          'digraph {a -> b}',
          'digraph {subgraph cluster_team {a b} a -> b}',
          'digraph {"quoted id" -> b [label="an edge"]}',
          'digraph {a [label=<<TABLE><TR><TD>HTML</TD></TR></TABLE>>]; a -> b}',
          'graph {a -- b}',
        ]) {
          const svg = await renderDiagram('dot',source);
          valid.push(svg.querySelectorAll('g.node').length);
        }
        const names = (prefix,count) => Array.from({length:count},(_,i)=>`${prefix}${i}`).join(' ');
        const expansion = [];
        for (const source of [
          `digraph {{${names('a',101)}} -> {${names('b',100)}}}`,
          `digraph {subgraph "s" {${names('a',100)}} subgraph s {a100} subgraph s {} -> {${names('b',100)}}}`,
        ]) {
          try { await renderDiagram('dot',source); expansion.push('unexpected layout'); }
          catch (error) { expansion.push(error.message); }
        }
        const abort = new AbortController();
        const cancellation = renderDiagram('dot','digraph {a -> b}',abort.signal).catch(error=>error.name);
        abort.abort();
        const cancelled = await cancellation;
        const recovered = await renderDiagram('dot','digraph {recovered -> safely}');

        const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.id = 'labels'; svg.setAttribute('viewBox','0 0 200 200');
        svg.innerHTML = Array.from({length:100},(_,i)=>`<path id="edge${i}" class="flowchart-link" d="M 0 ${i} L 100 ${i}"/><g class="edgeLabel"><text data-id="edge${i}" x="50" y="${i}">label ${i}</text></g>`).join('');
        document.body.append(svg);
        const query = svg.querySelectorAll.bind(svg);
        let labelScans = 0;
        svg.querySelectorAll = selector => {if(selector==='g.edgeLabel') labelScans++; return query(selector);};
        const targets = graphTargets(svg,'mermaid').targets;
        return {valid,expansion,cancelled,recovered:recovered.querySelectorAll('g.node').length,ticks,workers,labelScans,labels:targets.map(target=>target.related.length)};
      } finally {clearInterval(heartbeat); window.Worker = NativeWorker;}
    });
    assert.deepEqual(result.valid,[2,2,2,2,2]);
    for (const error of result.expansion) assert.match(error,/10000/);
    assert.equal(result.cancelled,'AbortError');
    assert.equal(result.recovered,2);
    assert.ok(result.ticks>0,'main-thread heartbeat continues while Viz runs');
    assert.ok(result.workers.every(worker=>worker.terminated),'all success, rejected and cancelled workers are disposed');
    assert.ok(result.workers.every(worker=>new URL(worker.url).origin===origin),'no CDN or blob worker');
    assert.equal(result.labelScans,1);
    assert.deepEqual(result.labels,Array(100).fill(1));
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise(resolve=>server.once('exit',resolve));
      server.kill('SIGTERM');
      await exited;
    }
  }
});
