import test from 'node:test';
import assert from 'node:assert/strict';
import {packGroups, panelHeights} from './component-layout.ts';
test('wide stages stack in reading order without forcing small loop groups into a giant cell',()=>{
 const sizes=[[340,80],[340,80],[90,80]], points=packGroups(sizes,1.3);
 assert.equal(points[0][1],-40);assert.ok(points[1][1]<points[0][1]);assert.ok(points[2][1]<points[1][1]);
 assert.equal(points[0][0]-170,points[2][0]-45);
});
test('mixed restoration counts fit narrow and wide viewports without overlaps',()=>{
 const sizes=[[400,180],[400,180],[110,90]];
 for(const aspect of [.55,1.5,3]) {
  const points=packGroups(sizes,aspect);
  for(let i=0;i<sizes.length;i++)for(let j=i+1;j<sizes.length;j++)assert.ok(Math.abs(points[i][0]-points[j][0]) >= (sizes[i][0]+sizes[j][0])/2 || Math.abs(points[i][1]-points[j][1]) >= (sizes[i][1]+sizes[j][1])/2);
 }
 assert.deepEqual(packGroups([],1),[]);
});

test('automatic fixed panes fill actual space, sharing only what preferred panes leave', () => {
 assert.deepEqual(panelHeights([null], 776, 12), {min:240,max:776,heights:[776]});
 assert.deepEqual(panelHeights([null,undefined], 776, 12).heights, [382,382]);
 assert.deepEqual(panelHeights([300,null], 776, 12).heights, [300,464]);
 assert.deepEqual(panelHeights([null,300,null], 1000, 12).heights, [338,300,338]);
});

test('pane bounds preserve requested heights and allow sidebar overflow rather than crushing content', () => {
 const preferred = [700,null];
 assert.deepEqual(panelHeights(preferred, 456, 12).heights, [456,240]);
 assert.deepEqual(preferred,[700,null]);
 assert.deepEqual(panelHeights(preferred, 776, 12).heights, [700,240]);
 assert.deepEqual(panelHeights([null,null], 180, 12), {min:180,max:180,heights:[180,180]});
 assert.deepEqual(panelHeights([10,900], 776, 12).heights, [240,776]);
 assert.deepEqual(panelHeights([null], 0, 12), {min:0,max:0,heights:[0]});
});
