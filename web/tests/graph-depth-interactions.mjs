import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {chromium} from 'playwright';

test('depth edge anchors and DOT arrows follow transformed SVG paths in both directions', async () => {
  const source = stripTypeScriptTypes(await readFile(new URL('../src/graph-depth.ts', import.meta.url), 'utf8'), {mode:'transform'});
  const browser = await chromium.launch({headless:true, executablePath:process.env.BLIND_TEST_CHROMIUM || undefined});
  try {
    const page = await browser.newPage();
    const failures = await page.evaluate(async moduleSource => {
      const moduleUrl = URL.createObjectURL(new Blob([moduleSource], {type:'text/javascript'}));
      const {GraphDepth} = await import(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      const failures = [];
      const check = (condition, message) => { if (!condition) failures.push(message); };
      const close = (a,b) => Math.hypot(a.x-b.x,a.y-b.y)<.02;
      const ns = 'http://www.w3.org/2000/svg';
      for (const [name, d, transform, samePlane] of [
        ['vertical','M 0 0 L 0 200','matrix(1 0 0 1 80 40)',false],
        ['horizontal','M 0 0 L 200 0','matrix(1 0 0 1 80 40)',false],
        ['curved','M 0 0 C 100 -70 -60 160 120 200','matrix(1.3 .2 .4 .8 80 40)',false],
        ['same-plane','M 0 0 C 100 -70 -60 160 120 200','matrix(1.3 .2 .4 .8 80 40)',true],
      ]) {
        const svg = document.createElementNS(ns,'svg');
        svg.setAttribute('viewBox','-100 -100 700 700');
        svg.setAttribute('width','700'); svg.setAttribute('height','700');
        document.body.append(svg);
        const edgeElement = document.createElementNS(ns,'g');
        edgeElement.setAttribute('transform',transform);
        const path = document.createElementNS(ns,'path');
        path.setAttribute('d',d); path.setAttribute('fill','none');
        edgeElement.append(path); svg.append(edgeElement);
        const sourceMatrix = svg.getCTM().inverse().multiply(path.getCTM());
        const length = path.getTotalLength();
        const at = fraction => path.getPointAtLength(length*fraction).matrixTransform(sourceMatrix);
        const endpoints = [at(0),at(1)];
        for (const fraction of [0,1]) {
          const endpoint = path.getPointAtLength(length*fraction);
          const adjacent = path.getPointAtLength(length*(fraction===0?.0001:.9999));
          const dx=endpoint.x-adjacent.x, dy=endpoint.y-adjacent.y, norm=Math.hypot(dx,dy);
          const ux=dx/norm, uy=dy/norm;
          const polygon=document.createElementNS(ns,'polygon');
          polygon.setAttribute('points',`${endpoint.x+ux*8},${endpoint.y+uy*8} ${endpoint.x+ux*2-uy*3},${endpoint.y+uy*2+ux*3} ${endpoint.x+ux*2+uy*3},${endpoint.y+uy*2-ux*3}`);
          edgeElement.append(polygon);
        }
        const label=document.createElementNS(ns,'text');
        label.textContent='A deliberately wide edge label'; label.setAttribute('x','-60'); label.setAttribute('y','100');
        edgeElement.append(label);
        const makeTarget = (id,kind,element) => {
          const b=element.getBBox(), m=svg.getCTM().inverse().multiply(element.getCTM());
          const corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y])=>new DOMPoint(x,y).matrixTransform(m));
          const x=Math.min(...corners.map(p=>p.x)), y=Math.min(...corners.map(p=>p.y));
          return {id,kind,label:id,element,related:[],box:{x,y,width:Math.max(...corners.map(p=>p.x))-x,height:Math.max(...corners.map(p=>p.y))-y}};
        };
        const nodes=[],groups=[];
        for (let i=0;i<2;i++) {
          const p=endpoints[i];
          for (const kind of ['node','group']) {
            const rect=document.createElementNS(ns,'rect');
            const radius=kind==='node'?3:15;
            rect.setAttribute('x',String(p.x-radius)); rect.setAttribute('y',String(p.y-radius));
            rect.setAttribute('width',String(radius*2)); rect.setAttribute('height',String(radius*2));
            svg.append(rect);
            (kind==='node'?nodes:groups).push(makeTarget(`${kind}:${i}`,kind,rect));
          }
        }
        const edge=makeTarget('edge:a->b','edge',edgeElement);
        const layers=groups.map((group,i)=>({id:group.id,label:group.id,members:new Set(samePlane?(i===0?nodes.map(n=>n.id):[]):[nodes[i].id])}));
        const depth=new GraphDepth(svg,[...nodes,...groups,edge],layers,{x:-100,y:-100,width:700,height:700});
        depth.setEnabled(true);
        const projectedPath=edge.element.querySelector('path');
        const projectedMatrix=svg.getCTM().inverse().multiply(projectedPath.getCTM());
        const projectedLength=projectedPath.getTotalLength();
        for (const fraction of [.1,.35,.7,.9]) {
          const original=at(fraction);
          const expected=projectedPath.getPointAtLength(fraction*projectedLength).matrixTransform(projectedMatrix);
          const located=depth.project(edge.id,original,0);
          check(close(located,expected),`${name}: source anchor ${fraction} follows the projected path`);
          const restored=depth.unproject(edge.id,expected);
          check(close(restored,original),`${name}: depth anchor ${fraction} maps to its source path`);
          check(close(depth.project(edge.id,restored,restored.offset??0),expected),`${name}: depth/source/depth round trip ${fraction}`);
          depth.setEnabled(false);
          check(close(depth.project(edge.id,restored,0),original),`${name}: flat restoration ${fraction}`);
          depth.setEnabled(true);
        }
        const polygons=edge.element.querySelectorAll('polygon');
        for (let index=0;index<polygons.length;index++) {
          const polygon=polygons[index], matrix=svg.getCTM().inverse().multiply(polygon.getCTM());
          const vertices=Array.from(polygon.points,point=>new DOMPoint(point.x,point.y).matrixTransform(matrix));
          const tip=vertices[0], base={x:(vertices[1].x+vertices[2].x)/2,y:(vertices[1].y+vertices[2].y)/2};
          const endpoint=projectedPath.getPointAtLength(index===0?0:projectedLength).matrixTransform(projectedMatrix);
          const adjacent=projectedPath.getPointAtLength(projectedLength*(index===0?.0001:.9999)).matrixTransform(projectedMatrix);
          const tangent={x:endpoint.x-adjacent.x,y:endpoint.y-adjacent.y};
          const alignment=((tip.x-base.x)*tangent.x+(tip.y-base.y)*tangent.y)/(Math.hypot(tip.x-base.x,tip.y-base.y)*Math.hypot(tangent.x,tangent.y));
          check(alignment>.9999,`${name}: ${index===0?'start':'end'} arrow follows endpoint tangent`);
          const oldPolygon=edgeElement.querySelectorAll('polygon')[index];
          const oldTip=new DOMPoint(oldPolygon.points[0].x,oldPolygon.points[0].y).matrixTransform(sourceMatrix);
          const originalMark={x:(oldTip.x+endpoints[index].x)/2,y:(oldTip.y+endpoints[index].y)/2};
          const projectedMark={x:(tip.x+endpoint.x)/2,y:(tip.y+endpoint.y)/2};
          check(close(depth.project(edge.id,originalMark,0),projectedMark),`${name}: arrowhead mark follows the rotated decoration`);
          check(close(depth.unproject(edge.id,projectedMark),originalMark),`${name}: depth arrowhead mark returns to the source decoration`);
          check(Math.abs(Math.hypot(tip.x-endpoint.x,tip.y-endpoint.y)-Math.hypot(oldTip.x-endpoints[index].x,oldTip.y-endpoints[index].y))<.02,`${name}: arrow retains endpoint gap`);
          for (const vertex of vertices) check(vertex.x>=depth.bounds.x&&vertex.y>=depth.bounds.y&&vertex.x<=depth.bounds.x+depth.bounds.width&&vertex.y<=depth.bounds.y+depth.bounds.height,`${name}: transformed arrow lies inside depth bounds`);
        }
        svg.remove();
      }
      return failures;
    },source);
    assert.deepEqual(failures,[]);
  } finally { await browser.close(); }
});
