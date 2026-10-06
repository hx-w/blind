import {defineOperation,OperationError,s,type Operation,type OperationHost,type Schema} from './core';
import type {AnnotationEditor,AnnotationToolbarState} from '../annotations/editor';
import type {ScreenStroke,SurfaceAnnotation,Vec3,MeshQuality} from '../api';
import type {SceneViewport} from '../viewport/types';
import type {MarkupCanvas} from '../markup';

export interface AnnotationList {surface:Array<SurfaceAnnotation & {entityId:string|null}>;screen:ScreenStroke[]}
export type AnnotationCoordinates = {id:string;space:'normalized-screen';aspect:number;points:Array<[number,number]>;displayPoints:Array<[number,number]>}|{id:string;entityId:string|null;revision:string;space:'source-world';points:Vec3[];normals:Vec3[];controls:number[];displayPoints:Array<{x:number;y:number;visible:boolean}>};
export interface AnnotationSurfacePick {entityId:string|null;revision:string;quality:MeshQuality;space:'source-world';point:Vec3;normal:Vec3}
const empty=s.object({}),surfaceId=s.string({min:1,max:64}),screenId=s.string({min:1,max:128,pattern:'^[A-Za-z0-9_-]+$'}),entityId=s.string({min:1,max:256}),color=s.string({pattern:'^#[0-9a-fA-F]{6}$'}),kind=s.enum(['surface','screen'] as const),mode=s.enum(['select','point','line','screen'] as const);
const markReference=s.union([s.object({kind:s.literal('surface'),id:surfaceId}),s.object({kind:s.literal('screen'),id:screenId})]);
const label:Schema<string>={json:{type:'string',maxLength:120},parse(value:unknown,path='label'):string {const text=s.string().parse(value,path);if([...text].length>120)throw new OperationError('INVALID_ARGUMENT','At most 120 Unicode characters are allowed',{field:path});return text;}};
const coord=s.number({min:-1e9,max:1e9}),vec3=s.tuple([coord,coord,coord]),normal=s.tuple([s.number(),s.number(),s.number()]),pixel=s.tuple([s.number(),s.number()]);
const screenPoints=s.array(s.tuple([s.number({min:0,max:1}),s.number({min:0,max:1})]),{min:2,max:512}),points=s.array(vec3,{min:1,max:4096}),normals=s.array(normal,{min:1,max:4096}),controls=s.array(s.number({integer:true,min:0,max:4095}),{min:1,max:4096});
export const annotationToolbarSchema:Schema<AnnotationToolbarState>=s.object({active:s.boolean(),mode,color,selection:s.nullable(markReference),label,canUndo:s.boolean(),canRedo:s.boolean(),canClose:s.boolean(),closed:s.boolean(),canFinishLine:s.boolean(),busy:s.boolean(),status:s.string(),supportsSurface:s.boolean()});
const screenFields={label:s.optional(label),color,aspect:s.number({min:.1,max:10}),points:screenPoints};
export const screenStrokeSchema:Schema<ScreenStroke>=s.object({id:screenId,...screenFields});
const surfaceFields={id:surfaceId,mesh:s.number({integer:true,min:0}),revision:s.string({min:1}),kind:s.enum(['point','line'] as const),label,color,visible:s.boolean(),closed:s.boolean(),points,normals,controls};
export const surfaceAnnotationSchema:Schema<SurfaceAnnotation>=s.object(surfaceFields);
export const annotationListSchema:Schema<AnnotationList>=s.object({surface:s.array(s.object({...surfaceFields,entityId:s.nullable(entityId)}),{max:64}),screen:s.array(screenStrokeSchema,{max:64})});
export const annotationCoordinatesSchema:Schema<AnnotationCoordinates>=s.union([
 s.object({id:screenId,space:s.literal('normalized-screen'),aspect:s.number({min:.1,max:10}),points:screenPoints,displayPoints:s.array(pixel,{min:2,max:512})}),
 s.object({id:surfaceId,entityId:s.nullable(entityId),revision:s.string({min:1}),space:s.literal('source-world'),points,normals,controls,displayPoints:s.array(s.object({x:s.number(),y:s.number(),visible:s.boolean()}),{min:1,max:4096})}),
]);
export const annotationPickSchema:Schema<AnnotationSurfacePick|null>=s.nullable(s.object({entityId:s.nullable(entityId),revision:s.string({min:1}),quality:s.enum(['raw','lod'] as const),space:s.literal('source-world'),point:vec3,normal}));
function annotationOperation<P,R>(name:string,description:string,params:Schema<P>,result:Schema<R>,readOnly=false):Operation<P,R> {return defineOperation<P,R>(name,description,params,{permission:readOnly?'scene.read':'annotation.write',readOnly,result:result.json});}
export const annotationOperations={
 get:annotationOperation('annotation:get','Read the annotation toolbar without finishing drafts',empty,annotationToolbarSchema,true),
 list:annotationOperation('annotation:list','List surface or view-scoped screen marks with stable IDs; includes unfinished surface drafts',s.object({kind:s.optional(kind)}),annotationListSchema,true),
 coordinates:annotationOperation('annotation:coordinates','Query frozen source samples and projected CSS client pixel coordinates without finishing drafts',markReference,annotationCoordinatesSchema,true),
 pick:annotationOperation('annotation:pick','Query a visible Mesh surface hit at CSS client pixels; null means no hit; does not load Raw or finish drafts',s.object({point:pixel,entityId:s.optional(entityId)}),annotationPickSchema,true),
 setTool:annotationOperation('annotation:set-tool','Set the active annotation tool; board supports select and screen',s.object({mode}),annotationToolbarSchema),
 setColor:annotationOperation('annotation:set-color','Set brush color and selected mark color',s.object({color}),annotationToolbarSchema),
 select:annotationOperation('annotation:select','Select an existing mark by stable ID',markReference,annotationToolbarSchema),
 createScreen:annotationOperation('annotation:create-screen','Create a view-scoped screen stroke from normalized samples',s.object(screenFields),screenStrokeSchema),
 editScreen:annotationOperation('annotation:edit-screen','Edit a screen stroke while preserving its ID',s.object({id:screenId,label:s.optional(label),color:s.optional(color),aspect:s.optional(s.number({min:.1,max:10})),points:s.optional(screenPoints)}),screenStrokeSchema),
 createSurface:annotationOperation('annotation:create-surface','Create frozen point/line samples bound to a Mesh entity and source revision; prepares Raw geometry',s.object({entityId,revision:s.string({min:1}),kind:s.enum(['point','line'] as const),label,color,visible:s.boolean(),closed:s.boolean(),points,normals,controls}),surfaceAnnotationSchema),
 editSurface:annotationOperation('annotation:edit-surface','Edit frozen surface samples or metadata; validates the resulting mark',s.object({id:surfaceId,label:s.optional(label),color:s.optional(color),visible:s.optional(s.boolean()),closed:s.optional(s.boolean()),points:s.optional(points),normals:s.optional(normals),controls:s.optional(controls)}),surfaceAnnotationSchema),
 remove:annotationOperation('annotation:remove','Remove one mark by kind and stable ID',markReference,annotationToolbarSchema),
 clear:annotationOperation('annotation:clear','Clear screen, surface or all annotations',s.object({kind:s.optional(kind)}),annotationToolbarSchema),
 undo:annotationOperation('annotation:undo','Undo the last annotation edit using shared history',empty,annotationToolbarSchema),
 redo:annotationOperation('annotation:redo','Redo an annotation edit',empty,annotationToolbarSchema),
 finish:annotationOperation('annotation:finish','Finish active screen stroke and surface line before a share snapshot',empty,annotationToolbarSchema),
 cancel:annotationOperation('annotation:cancel','Cancel active stroke or surface draft without finishing it',empty,annotationToolbarSchema),
 setClosed:annotationOperation('annotation:set-closed','Set surface line closure idempotently using surface sampling',s.object({id:surfaceId,closed:s.boolean()}),annotationToolbarSchema),
};
export function registerAnnotationOperations(host:OperationHost,editor:AnnotationEditor,viewport:SceneViewport,markup:MarkupCanvas):void {
 const surfaceAvailable=()=>!!editor.surface&&viewport.kind==='spatial';
 host.register(annotationOperations.get,()=>editor.toolbarState);
 host.register(annotationOperations.list,({kind})=>({surface:kind==='screen'?[]:editor.surfaceAnnotations().map(mark=>({...mark,entityId:viewport.kind==='spatial'?viewport.sectionSource(mark.mesh)?.entityId??null:null})),screen:kind==='surface'?[]:markup.exportStrokes()}));
 host.register(annotationOperations.coordinates,({kind,id}):AnnotationCoordinates=>{
   if(kind==='screen'){
     const strokes=markup.exportStrokes(),index=strokes.findIndex(stroke=>stroke.id===id);
     if(index<0)throw new OperationError('INVALID_ARGUMENT','Screen mark not found',{target:id});
     return {id,space:'normalized-screen',aspect:strokes[index].aspect,points:strokes[index].points,displayPoints:markup.displayPoints(index)};
   }
   if(viewport.kind!=='spatial')throw new OperationError('UNSUPPORTED','Board has no surface coordinates');
   const mark=editor.surfaceAnnotations().find(mark=>mark.id===id);
   if(!mark)throw new OperationError('INVALID_ARGUMENT','Surface mark not found',{target:id});
   return {id,entityId:viewport.sectionSource(mark.mesh)?.entityId??null,revision:mark.revision,space:'source-world',points:mark.points,normals:mark.normals,controls:mark.controls,displayPoints:mark.points.map(point=>viewport.projectSurface(point))};
 });
 host.register(annotationOperations.pick,({point,entityId})=>{
   if(viewport.kind!=='spatial')throw new OperationError('UNSUPPORTED','Board has no Mesh surface picking');
   const mesh=entityId===undefined?undefined:viewport.getMeshIndex(entityId);
   if(entityId!==undefined&&mesh===undefined)throw new OperationError('UNKNOWN_ENTITY','Mesh entity does not exist',{target:entityId});
   if(mesh!==undefined&&viewport.modelInfos[mesh]?.format==='pts')throw new OperationError('UNSUPPORTED','Point clouds have no annotatable surface',{target:entityId});
   const hit=viewport.pickSurface(point[0],point[1],mesh);
   return hit?{entityId:viewport.sectionSource(hit.mesh)?.entityId??null,revision:viewport.modelInfos[hit.mesh].revision,quality:viewport.modelInfos[hit.mesh].quality,space:'source-world',point:hit.point,normal:hit.normal}:null;
 },()=>viewport.kind==='spatial');
 host.register(annotationOperations.setTool,({mode})=>{editor.setTool(mode);return editor.toolbarState;});
 host.register(annotationOperations.setColor,({color})=>{editor.setColor(color);return editor.toolbarState;});
 host.register(annotationOperations.select,({kind,id})=>{editor.select(kind,id);return editor.toolbarState;});
 host.register(annotationOperations.createScreen,input=>editor.createScreen(input));
 host.register(annotationOperations.editScreen,({id,...patch})=>editor.editScreen(id,patch));
 host.register(annotationOperations.createSurface,input=>{if(!editor.surface)throw new OperationError('UNSUPPORTED','Board has no surface annotations');return editor.surface.create(input);},surfaceAvailable);
 host.register(annotationOperations.editSurface,({id,...patch})=>{if(!editor.surface)throw new OperationError('UNSUPPORTED','Board has no surface annotations');return editor.surface.edit(id,patch);},surfaceAvailable);
 host.register(annotationOperations.remove,({kind,id})=>{editor.removeAnnotation(kind,id);return editor.toolbarState;});
 host.register(annotationOperations.clear,({kind})=>{editor.clearAnnotations(kind);return editor.toolbarState;});
 host.register(annotationOperations.undo,async()=>{await editor.undo();return editor.toolbarState;});
 host.register(annotationOperations.redo,async()=>{await editor.redo();return editor.toolbarState;});
 host.register(annotationOperations.finish,()=>{editor.finish();return editor.toolbarState;});
 host.register(annotationOperations.cancel,()=>{editor.cancel();return editor.toolbarState;});
 host.register(annotationOperations.setClosed,({id,closed})=>{editor.setClosed(id,closed);return editor.toolbarState;},surfaceAvailable);
}
