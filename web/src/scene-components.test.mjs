import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentRegistry, sceneComponents, componentGroups, componentUpdate, effectiveVisibility } from './scene-components.ts';

test('legacy mesh and PTS scenes enter the same component contract', () => {
  const specs = sceneComponents({meshes: [{name:'jaw', format:'ply', visible:true, opacity:.3}, {name:'margin', format:'pts', visible:false, opacity:1}], label_groups: [{text:'result', meshes:[0,1]}]});
  assert.deepEqual(specs.map(c => [c.component,c.group,c.source]), [['mesh','result',{kind:'mesh',index:0}],['points','result',{kind:'mesh',index:1}]]);
  assert.equal(specs[0].opacity,.3);
});
test('a new renderer registers without branches in scene UI', () => {
  const registry = new ComponentRegistry();
  const runtime = {dispose(){}};
  registry.register({type:'custom.image',capabilities:{presentations:['spatial'],movable:false,resizable:false,input:{spatial:'scene',focus:'content',fullscreen:'content'}},create:()=>runtime});
  assert.equal(registry.get('custom.image').create(),runtime);
  assert.throws(()=>registry.register({type:'custom.image'}),/Duplicate/);
  assert.throws(()=>registry.get('unknown'),/Unsupported/);
});
test('groups are flat, ordered and can mix all component types', () => {
  const elements = [{id:'1',group:'first',component:'mesh'}, {id:'2',group:'second',component:'trace'}, {id:'3',group:'first',component:'text'}];
  assert.deepEqual([...componentGroups(elements)].map(([name,items])=>[name,items.map(i=>i.id)]), [['first',['1','3']],['second',['2']]]);
});
test('updates exclude source and implementation props; visibility combines opacity and toggle', () => {
  const spec = {id:'log',position:[1,2,3],size:[110,70],visible:true,opacity:0,source:{kind:'attachment',index:0},component:'text'};
  const update = componentUpdate(spec); assert.equal('source' in update,false); assert.equal('component' in update,false);
  assert.equal(effectiveVisibility(spec),false); assert.equal(effectiveVisibility({...spec,opacity:.3}),true); assert.equal(effectiveVisibility({...spec,opacity:.3,visible:false}),false);
  update.position[0]=500; assert.equal(spec.position[0],1);
});
