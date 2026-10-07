import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const js = ts.transpileModule(readFileSync(new URL('./operations/core.ts', import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const coreUrl = `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
const {OperationHost, OperationError, defineOperation, s, assertContentAccess} = await import(coreUrl);
const transportJs = ts.transpileModule(readFileSync(new URL('./operations/transport.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'./core'",`'${coreUrl}'`);
const {servePortOperations} = await import(`data:text/javascript;base64,${Buffer.from(transportJs).toString('base64')}`);
async function operationModule(path, imports = {}) {
  let source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  for (const [specifier, url] of Object.entries(imports)) source = source.replaceAll(`'${specifier}'`, `'${url}'`);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return {url, exports:await import(url)};
}
const viewModule = await operationModule('./operations/view.ts', {'./core':coreUrl});
const {exports:{entityOperations}} = await operationModule('./operations/entities.ts', {'./core':coreUrl,'./view':viewModule.url});
const annotationModule = await operationModule('./operations/annotations.ts', {'./core':coreUrl});
const {annotationOperations,screenStrokeSchema,surfaceAnnotationSchema} = annotationModule.exports;
const sectionModule = await operationModule('./operations/section.ts', {'./core':coreUrl});
const {sectionOperations} = sectionModule.exports;
const {exports:{sceneUpdateSchema}} = await operationModule('./operations/snapshot.ts', {'./core':coreUrl,'./annotations':annotationModule.url,'./section':sectionModule.url});
const {exports:{validateScreens}} = await operationModule('./annotations/validation.ts', {'../operations/core':coreUrl});
const params = s.object({ids:s.array(s.string({min:1}),{unique:true}), opacity:s.optional(s.number({min:0,max:1}))});
const show = defineOperation('scene:show','Set visibility',params,{permission:'scene.write'});
const hostActor = {kind:'host'};

test('request validation and permission checks precede any mutation', async () => {
  const host = new OperationHost({sceneId:'review',ready:()=>true});
  let visible = ['a'];
  host.register(show, request => {for (const id of request.ids) if (!['a','b'].includes(id)) throw new OperationError('UNKNOWN_ENTITY','Unknown',{target:id}); visible=request.ids;return visible;});
  for (const request of [{ids:['b'],opacity:2},{ids:['b','b']},{ids:['b'],unexpected:true},{ids:['b'],opacity:NaN}]) {
    await assert.rejects(host.execute(show.name,request,hostActor),{code:'INVALID_ARGUMENT'});
    assert.deepEqual(visible,['a']);
  }
  await assert.rejects(host.execute(show.name,{ids:['b','missing']},hostActor),{code:'UNKNOWN_ENTITY'});
  await assert.rejects(host.execute(show.name,{ids:['b']},{kind:'component',entityId:'controller',grants:['scene.read']}),{code:'FORBIDDEN'});
  assert.deepEqual(visible,['a']);
  assert.deepEqual(await host.execute(show.name,{ids:['b']},{kind:'component',entityId:'controller',grants:['scene.write']}),['b']);
});

test('catalog distinguishes readiness, capability, export and authorization', async () => {
  let ready=false;
  const host=new OperationHost({sceneId:'board',ready:()=>ready});
  host.register(show,()=>null,()=>false);
  const actor={kind:'component',entityId:'controller',grants:['scene.read']};
  let descriptor=(await host.execute('operations:catalog',{},actor)).find(item=>item.name===show.name);
  assert.equal(descriptor.allowed,false);assert.equal(descriptor.available,false);
  await assert.rejects(host.execute(show.name,{ids:[]},hostActor),{code:'NOT_READY'});
  ready=true;
  await assert.rejects(host.execute(show.name,{ids:[]},hostActor),{code:'UNSUPPORTED'});
  const exporting=new OperationHost({sceneId:'export',ready:()=>true,exporting:true});
  let changed=false;exporting.register(show,()=>{changed=true;return null;});
  await assert.rejects(exporting.run(show,{ids:[]}),{code:'FORBIDDEN'});assert.equal(changed,false);
});

test('own-content authorization and subscriptions do not expose sibling content', () => {
  const host=new OperationHost({sceneId:'review',ready:()=>true});
  const actor={kind:'component',entityId:'controller',grants:['scene.read','content.read']};
  assert.throws(()=>assertContentAccess({actor,sceneId:'review',revision:0},'document'),{code:'FORBIDDEN'});
  const events=[];const unsubscribe=host.subscribe(event=>events.push(event),actor);
  host.notify('content',{entityId:'document',content:{reading:'private'}});
  host.notify('content',{entityId:'controller',content:{reading:'own'}});
  host.notify('view',{kind:'board'});
  assert.deepEqual(events.map(event=>event.domain),['content','view']);
  assert.deepEqual(events.map(event=>event.revision),[2,3]);
  unsubscribe();host.notify('view');assert.equal(events.length,2);
  const authorized={...actor,grants:[...actor.grants,'content.read-scene']};
  assertContentAccess({actor:authorized,sceneId:'review',revision:3},'document');
});

test('disposal rejects outstanding completion and new requests', async () => {
  const host=new OperationHost({sceneId:'review',ready:()=>true});
  const completion=Promise.withResolvers();host.register(show,()=>completion.promise);
  const pending=host.run(show,{ids:[]});host.dispose();completion.resolve(['a']);
  await assert.rejects(pending,{code:'DISPOSED'});
  await assert.rejects(host.execute('operations:catalog',{},hostActor),{code:'DISPOSED'});
});

test('opaque plugin JSON enforces serializable finite size and depth boundaries', () => {
  const state=s.json();
  for (const value of [undefined,{value:Infinity},{value:()=>0},{value:BigInt(1)},new Date(),{value:'x'.repeat(65536)}]) assert.throws(()=>state.parse(value),{code:'INVALID_ARGUMENT'});
  let nested=null;for(let i=0;i<66;i++) nested={nested};
  assert.throws(()=>state.parse(nested),{code:'INVALID_ARGUMENT'});
  assert.deepEqual(state.parse({value:['a',1,null]}),{value:['a',1,null]});
});

test('private renderer port binds scene and actor instead of trusting request authority', async t => {
  const host=new OperationHost({sceneId:'review',ready:()=>true});
  let visible=['a'];host.register(show,request=>{visible=request.ids;return visible;});
  const channel=new MessageChannel();
  const disconnect=servePortOperations(host,channel.port1,{kind:'component',entityId:'controller',grants:['scene.read']});
  t.after(()=>{disconnect();channel.port1.close();channel.port2.close();host.dispose();});
  async function send(sceneId,operation,params) {
    const requestId=crypto.randomUUID();
    const {promise,resolve}=Promise.withResolvers();
    const receive=event=>{if(event.data.type==='blind:operation-result'&&event.data.requestId===requestId){channel.port2.removeEventListener('message',receive);resolve(event.data);}};
    channel.port2.addEventListener('message',receive);channel.port2.start();
    channel.port2.postMessage({type:'blind:operation-request',version:1,sceneId,requestId,operation,params,actor:{kind:'host'}});
    return promise;
  }
  const wrongScene=await send('other','operations:catalog',{});
  assert.equal(wrongScene.error.code,'UNKNOWN_SCENE');
  const denied=await send('review','scene:show',{ids:['b']});
  assert.equal(denied.error.code,'FORBIDDEN');assert.deepEqual(visible,['a']);
  const catalog=await send('review','operations:catalog',{});
  assert.equal(catalog.ok,true);
  assert.equal(catalog.value.find(item=>item.name==='scene:show').allowed,false);
});

test('declared string bounds count Unicode characters, not UTF-16 code units', () => {
  const name=s.string({min:1,max:2});
  assert.equal(name.parse('😀😀'),'😀😀');
  assert.throws(()=>name.parse('😀😀😀'),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>name.parse(''),{code:'INVALID_ARGUMENT'});
});

test('scene visibility and coordinate requests reject missing numeric indices before invoking mutations', async () => {
  const host = new OperationHost({sceneId:'review',ready:()=>true});
  const scene = [{id:'a',visible:true,opacity:.5},{id:'b',visible:false,opacity:1}];
  const original = structuredClone(scene);
  let mutations = 0;
  host.register(entityOperations.show, ({ids,opacity}) => {
    mutations++;
    for (const entity of scene) {entity.visible=ids.includes(entity.id);if(entity.visible&&opacity!==undefined)entity.opacity=opacity;}
    return structuredClone(scene);
  });
  for (const ids of [new Array(1), ['b', ,], Object.assign(new Array(1), {extra:'b'})]) {
    await assert.rejects(host.run(entityOperations.show,{ids,opacity:.25}),{code:'INVALID_ARGUMENT'});
    assert.deepEqual(scene,original);
  }
  host.register(sectionOperations.setPlane, () => {mutations++;});
  const plane = {entityId:'a',revision:'revision',origin:[0,0,0],normal:[0,0,1],axis:[1,0,0],radius:1};
  for (const origin of [new Array(3), [0, ,0]]) {
    await assert.rejects(host.run(sectionOperations.setPlane,{...plane,origin}),{code:'INVALID_ARGUMENT'});
  }
  // Even an optional tuple member cannot make an absent array index valid.
  assert.throws(()=>s.tuple([s.optional(s.number())]).parse(new Array(1)),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>s.array(s.optional(s.number())).parse(new Array(1)),{code:'INVALID_ARGUMENT'});
  assert.equal(mutations,0);
  await host.run(entityOperations.show,{ids:['b'],opacity:.25});
  assert.deepEqual(scene,[{id:'a',visible:false,opacity:.5},{id:'b',visible:true,opacity:.25}]);
});

test('annotation and section boundaries distinguish screen IDs, surface IDs and entity references', async () => {
  const stroke = {id:'s'.repeat(128),color:'#abcdef',aspect:1,points:[[0,0],[1,1]]};
  const host = new OperationHost({sceneId:'review',ready:()=>true});
  let saved = structuredClone(stroke);
  host.register(annotationOperations.editScreen, ({id,...patch}) => {
    assert.equal(id,saved.id);
    const edited={...saved,...patch};
    validateScreens([edited]);
    saved=edited;
    return structuredClone(saved);
  });
  const edited = await host.run(annotationOperations.editScreen,{id:stroke.id,label:'reviewed',color:'#123456'});
  assert.deepEqual(edited,{...stroke,label:'reviewed',color:'#123456'});
  assert.deepEqual(screenStrokeSchema.parse(edited),saved);
  for (const id of ['s'.repeat(129),'not valid','é']) {
    await assert.rejects(host.run(annotationOperations.editScreen,{id,label:'bad'}),{code:'INVALID_ARGUMENT'});
    assert.throws(()=>validateScreens([{...stroke,id}]),{code:'INVALID_ARGUMENT'});
  }
  assert.deepEqual(saved,edited);
  const surface = {id:'m'.repeat(64),mesh:0,revision:'revision',kind:'point',label:'',color:'#abcdef',visible:true,closed:false,points:[[0,0,0]],normals:[[0,0,1]],controls:[0]};
  assert.deepEqual(surfaceAnnotationSchema.parse(surface),surface);
  assert.throws(()=>surfaceAnnotationSchema.parse({...surface,id:'m'.repeat(65)}),{code:'INVALID_ARGUMENT'});
  for (const length of [65,71,256]) {
    const entityId = `plugin-${'a'.repeat(length-7)}`;
    const plane = {entityId,revision:'revision',origin:[0,0,0],normal:[0,0,1],axis:[1,0,0],radius:1,targets:[{entityId,revision:'revision'}]};
    assert.deepEqual(sectionOperations.setPlane.params.parse(plane),plane);
    assert.equal(sectionOperations.setTargets.params.parse({targets:plane.targets}).targets[0].entityId,entityId);
    const create = {entityId,revision:'revision',kind:'point',label:'',color:'#abcdef',visible:true,closed:false,points:[[0,0,0]],normals:[[0,0,1]],controls:[0]};
    assert.deepEqual(annotationOperations.createSurface.params.parse(create),create);
    assert.deepEqual(annotationOperations.pick.params.parse({entityId,point:[1,2]}),{entityId,point:[1,2]});
  }
  assert.throws(()=>annotationOperations.pick.params.parse({entityId:'a'.repeat(257),point:[1,2]}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>sectionOperations.setTargets.params.parse({targets:[{entityId:'a'.repeat(257),revision:'revision'}]}),{code:'INVALID_ARGUMENT'});
});

test('snapshot consumers accept pane preferences and reject invalid heights or source replacement', () => {
  const entity = {id:'notes',label:'Review',placement:'panel',position:null,size:[110,70],visible:true,opacity:1,panel_height:700};
  const snapshot = {entities:[entity],meshes:[],state:{selected:0,viewport:{mode:'board',board:{center:[0,0],scale:1}},shading:'flat',projection:'perspective',background:'dark',axes:false,frame:{width:1200,height:800},camera:null,strokes:[]}};
  const parsed = sceneUpdateSchema.parse(snapshot);
  assert.equal(parsed.entities[0].panel_height,700);
  assert.deepEqual(parsed.entities[0].size,[110,70]);
  assert.equal(sceneUpdateSchema.parse({...snapshot,entities:[{...entity,panel_height:null}]}).entities[0].panel_height,null);
  for (const height of [0,-1,NaN,Infinity,'700px']) {
    assert.throws(() => sceneUpdateSchema.parse({...snapshot,entities:[{...entity,panel_height:height}]}),{code:'INVALID_ARGUMENT'});
  }
  assert.throws(() => sceneUpdateSchema.parse({...snapshot,entities:[{...entity,source:{kind:'attachment',index:1}}]}),{code:'INVALID_ARGUMENT'});
});
