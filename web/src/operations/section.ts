import {defineOperation,OperationError,s,type Operation,type OperationHost,type Schema} from './core';
import type {SectionSnapshot,SectionViewer} from '../section-viewer';
import type {MeshViewer} from '../viewer';
import type {SectionState} from '../api';
import type {PlanePoint,PlaneSegment,OppositeHit} from '../section-plot';
export interface SectionSnapResult {point:PlanePoint;index:number;opposite:OppositeHit|null}
export interface SectionContour {entityId:string;color:string;segments:PlaneSegment[]}
const empty=s.object({}),id=s.string({min:1,max:256}),revision=s.string({min:1}),finite=s.number(),vec3=s.tuple([finite,finite,finite]),planePoint=s.tuple([finite,finite]),point=s.tuple([s.number({min:-1e9,max:1e9}),s.number({min:-1e9,max:1e9})]);
const target=s.object({entityId:id,revision}),targets=s.array(target,{min:1,unique:true}),measurement=s.object({a:point,b:point,opposite:s.optional(point)}),color=s.string({pattern:'^#[0-9a-fA-F]{6}$'});
export const sectionStateSchema:Schema<SectionState>=s.object({entity_id:id,mesh:s.number({integer:true,min:0}),revision,origin:vec3,normal:vec3,axis:vec3,radius:s.number({min:0}),offset:finite,fit:s.boolean(),pan:s.optional(planePoint),targets:s.optional(s.array(s.object({entity_id:id,mesh:s.number({integer:true,min:0}),revision}))),panel_size:s.optional(s.tuple([s.number({min:160,max:1200}),s.number({min:160,max:1200})])),measurements:s.optional(s.array(measurement,{max:2}))});
export const sectionContourSchema:Schema<SectionContour>=s.object({entityId:id,color,segments:s.array(s.object({a:planePoint,b:planePoint}))});
export const sectionSnapshotSchema:Schema<SectionSnapshot>=s.object({active:s.boolean(),drawing:s.boolean(),measuring:s.boolean(),state:s.nullable(sectionStateSchema),plot:s.nullable(s.object({radius:s.number({min:0}),pan:planePoint})),targets:s.array(s.object({entityId:id,revision,name:s.string(),visible:s.boolean()})),contours:s.array(sectionContourSchema),measurements:s.array(s.object({a:point,b:point,opposite:s.optional(point),distance:s.number({min:0}),oppositeDistance:s.optional(s.number({min:0}))}),{max:2})});
export const sectionSnapSchema:Schema<SectionSnapResult>=s.object({point:planePoint,index:s.number({integer:true,min:-1}),opposite:s.nullable(s.object({point:planePoint,distance:s.number({min:0})}))});
function sectionOperation<P,R>(name:string,description:string,params:Schema<P>,result:Schema<R>,readOnly=false):Operation<P,R>{return defineOperation<P,R>(name,description,params,{permission:readOnly?'scene.read':'section.write',readOnly,result:result.json});}
export const sectionOperations={
 get:sectionOperation('section:get','Read section lifecycle, plane, targets, plot and measurements; no draft completion',empty,sectionSnapshotSchema,true),
 contours:sectionOperation('section:contours','Read actual intersected contour segments in plane-local source length units',empty,s.array(sectionContourSchema),true),
 snap:sectionOperation('section:snap','Snap a plane-local point to real contours and query opposite contour; index -1 and opposite null mean no contour within tolerance',s.object({point,tolerance:s.number({min:0})}),sectionSnapSchema,true),
 open:sectionOperation('section:open','Open section drawing idempotently; requires a visible selected Mesh',empty,sectionSnapshotSchema),
 redraw:sectionOperation('section:redraw','Begin replacing the section plane by a new drawing; preserves existing plane until drawing commits',empty,sectionSnapshotSchema),
 close:sectionOperation('section:close','Close and clear active section idempotently',empty,sectionSnapshotSchema),
 cancel:sectionOperation('section:cancel','Cancel drawing or ruler draft while preserving existing section',empty,sectionSnapshotSchema),
 setPlane:sectionOperation('section:set-plane','Set explicit source-revision-bound plane and Mesh targets; normal and axis must be unit perpendicular vectors; radius positive',s.object({entityId:id,revision,origin:vec3,normal:vec3,axis:vec3,radius:s.number({min:0}),offset:s.optional(finite),targets:s.optional(targets)}),sectionSnapshotSchema),
 setTargets:sectionOperation('section:set-targets','Set explicit visible Mesh entity/revision targets; clears rulers and fits contours when changed',s.object({targets}),sectionSnapshotSchema),
 setOffset:sectionOperation('section:set-offset','Set plane offset along its normal in source length units; clears rulers when changed',s.object({offset:finite}),sectionSnapshotSchema),
 setPlot:sectionOperation('section:set-plot','Set fitted or explicit plot bounds: center pan and positive half-extent radius in plane units',s.object({fit:s.optional(s.boolean()),radius:s.optional(s.number({min:0})),pan:s.optional(planePoint)}),sectionSnapshotSchema),
 setRuler:sectionOperation('section:set-ruler','Set ruler interaction state idempotently',s.object({active:s.boolean()}),sectionSnapshotSchema),
 setMeasurements:sectionOperation('section:set-measurements','Set up to two rulers with explicit plane-local endpoints and optional opposite endpoint',s.object({measurements:s.array(measurement,{max:2})}),sectionSnapshotSchema),
 setPanelSize:sectionOperation('section:set-panel-size','Set panel width and plot height in CSS pixels',s.object({size:s.tuple([s.number({min:160,max:1200}),s.number({min:160,max:1200})])}),sectionSnapshotSchema),
};
export function registerSectionOperations(host:OperationHost,section:SectionViewer|undefined,meshViewer:MeshViewer|undefined):void {
 section?.bindOperations(host);
 const available=()=>!!section&&!!meshViewer;
 const requireSection=():SectionViewer=>{if(!section||!meshViewer)throw new OperationError('UNSUPPORTED','Sections require a spatial Mesh viewport; board does not support sections');return section;};
 const loadTargets=async(targets:readonly {entityId:string;revision?:string}[])=>{
  requireSection();
  const indices=targets.map(target=>{
   const index=meshViewer!.getMeshIndex(target.entityId),info=index===undefined?undefined:meshViewer!.modelInfos[index];
   if(index===undefined||!info)throw new OperationError('UNKNOWN_ENTITY','Mesh entity does not exist',{target:target.entityId});
   if(target.revision!==undefined&&info.revision!==target.revision)throw new OperationError('CONFLICT','Section source revision changed',{field:'revision',target:target.entityId});
   if(info.format==='pts')throw new OperationError('UNSUPPORTED','Point clouds have no section surface',{target:target.entityId});
   if(!info.visible||info.opacity===0)throw new OperationError('CONFLICT','Section target must be visible with nonzero opacity',{target:target.entityId});
   return index;
  });
  await meshViewer!.ensureLoaded(indices);
 };
 host.register(sectionOperations.get,()=>requireSection().snapshot(),available);
 host.register(sectionOperations.contours,()=>requireSection().snapshot().contours,available);
 host.register(sectionOperations.snap,({point,tolerance})=>requireSection().snap(point,tolerance),available);
 host.register(sectionOperations.open,async()=>{const current=requireSection();await current.open();return current.snapshot();},available);
 host.register(sectionOperations.redraw,async()=>{const current=requireSection();await current.startDraw();return current.snapshot();},available);
 host.register(sectionOperations.close,()=>{const current=requireSection();current.close();return current.snapshot();},available);
 host.register(sectionOperations.cancel,()=>{const current=requireSection();current.cancel();return current.snapshot();},available);
 host.register(sectionOperations.setPlane,async input=>{const current=requireSection();await loadTargets([input,...input.targets??[]]);current.setPlane(input);return current.snapshot();},available);
 host.register(sectionOperations.setTargets,async({targets})=>{const current=requireSection();await loadTargets(targets);current.setTargets(targets);return current.snapshot();},available);
 host.register(sectionOperations.setOffset,({offset})=>{const current=requireSection();current.setOffset(offset);return current.snapshot();},available);
 host.register(sectionOperations.setPlot,input=>{const current=requireSection();current.setPlot(input);return current.snapshot();},available);
 host.register(sectionOperations.setRuler,({active})=>{const current=requireSection();current.setMeasuring(active);return current.snapshot();},available);
 host.register(sectionOperations.setMeasurements,({measurements})=>{const current=requireSection();current.setMeasurements(measurements);return current.snapshot();},available);
 host.register(sectionOperations.setPanelSize,({size})=>{const current=requireSection();current.setPanelSize(size);return current.snapshot();},available);
}
