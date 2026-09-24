import test from 'node:test';
import assert from 'node:assert/strict';
import { entityUpdate, effectiveVisibility } from './scene-components.ts';

test('updates exclude source and implementation props; visibility combines opacity and toggle', () => {
  const spec = {id:'log',label:'Worker log',position:[1,2,3],size:[110,70],visible:true,opacity:0,source:{kind:'attachment',index:0},component:'text'};
  const update = entityUpdate(spec); assert.equal('source' in update,false); assert.equal('component' in update,false); assert.equal(update.label,'Worker log');
  assert.equal(effectiveVisibility(spec),false); assert.equal(effectiveVisibility({...spec,opacity:.3}),true); assert.equal(effectiveVisibility({...spec,opacity:.3,visible:false}),false);
  update.position[0]=500; assert.equal(spec.position[0],1);
});
