import type { ScreenStroke, SurfaceAnnotation } from '../api';
export type AnnotationMode = 'select' | 'point' | 'line' | 'screen';
export type AnnotationSelection = {kind:'surface'|'screen';id:string};
export interface AnnotationToolbarState {active:boolean;mode:AnnotationMode;color:string;selection:AnnotationSelection|null;label:string;canUndo:boolean;canRedo:boolean;canClose:boolean;closed:boolean;canFinishLine:boolean;busy:boolean;status:string;supportsSurface:boolean}
export interface SurfaceAnnotationMethods {
  create(input:Omit<SurfaceAnnotation,'id'|'mesh'> & {entityId:string}):Promise<SurfaceAnnotation>;
  edit(id:string,patch:Partial<Pick<SurfaceAnnotation,'label'|'color'|'visible'|'points'|'normals'|'controls'|'closed'>>):SurfaceAnnotation;
}
export interface AnnotationEditor {
  readonly isActive:boolean;
  readonly toolbarState:AnnotationToolbarState;
  readonly surface?:SurfaceAnnotationMethods;
  enter(id?:string):Promise<void>; exit():void; load():void; finishForShare():void; invalidateScreenHistory():void; refreshList():void; suspend():void; resume():void; setExternalScreenMarkup(external:boolean):void;
  setTool(mode:AnnotationMode):void; setColor(color:string):void; select(kind:'surface'|'screen',id:string):void;
  createScreen(stroke:Omit<ScreenStroke,'id'>):ScreenStroke; editScreen(id:string,patch:Partial<Omit<ScreenStroke,'id'>>):ScreenStroke;
  removeAnnotation(kind:'surface'|'screen',id:string):void; clearAnnotations(kind?:'surface'|'screen'):void;
  undo():Promise<void>|void; redo():Promise<void>|void; finish():void; cancel():void;
  setClosed(id:string,closed:boolean):void;
  surfaceAnnotations():SurfaceAnnotation[];
}
export class AnnotationHistory<T> {
  readonly past:T[]=[]; readonly future:T[]=[];
  remember(snapshot:T):void {this.past.push(snapshot);if(this.past.length>40)this.past.shift();this.future.length=0;}
  clear():void {this.past.length=0;this.future.length=0;}
}
