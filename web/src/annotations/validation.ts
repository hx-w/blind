import type {ScreenStroke,SurfaceAnnotation} from '../api';
import {OperationError} from '../operations/core';
export function invalid(field:string,message:string):never {throw new OperationError('INVALID_ARGUMENT',message,{field});}
export function validateColor(color:string):void {if(!/^#[0-9a-fA-F]{6}$/.test(color))invalid('color','Use a six-digit hexadecimal color');}
export function validateLabel(label:string|undefined):void {if(label!==undefined && [...label].length>120)invalid('label','At most 120 characters are allowed');}
export function validateScreens(strokes:ScreenStroke[]):void {
 if(strokes.length>64)invalid('strokes','At most 64 screen strokes are allowed');
 if(strokes.reduce((n,s)=>n+s.points.length,0)>4096)invalid('points','At most 4096 screen samples are allowed');
 const ids=new Set<string>();for(const stroke of strokes){if(!/^[A-Za-z0-9_-]{1,128}$/.test(stroke.id)||ids.has(stroke.id))invalid('id','Screen stroke IDs must be unique and contain 1–128 ASCII letters, digits, hyphens or underscores');ids.add(stroke.id);validateColor(stroke.color);validateLabel(stroke.label);
 if(!Number.isFinite(stroke.aspect)||stroke.aspect<.1||stroke.aspect>10)invalid('aspect','Aspect must be between 0.1 and 10');
 if(stroke.points.length<2||stroke.points.length>512)invalid('points','A screen stroke requires 2–512 samples');
 if(stroke.points.some(p=>p.length!==2||p.some(v=>!Number.isFinite(v)||v<0||v>1)))invalid('points','Screen samples must be finite normalized coordinates');}
}
export function validateSurfaces(marks:SurfaceAnnotation[]):void {
 if(marks.length>64||marks.reduce((n,m)=>n+m.points.length,0)>16384)invalid('annotations','Surface annotation limits are 64 marks and 16384 total samples');
 const ids=new Set<string>();for(const m of marks){if(!m.id||m.id.length>64||ids.has(m.id))invalid('id','Surface IDs must be unique and contain 1–64 characters');ids.add(m.id);validateLabel(m.label);validateColor(m.color);
 if(!m.points.length||m.points.length>4096||m.points.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e9)))invalid('points','Surface samples require 1–4096 finite coordinates within ±1e9');
 if(m.normals.length!==m.points.length||m.normals.some(p=>p.length!==3||p.some(v=>!Number.isFinite(v))||p.reduce((n,v)=>n+v*v,0)<.5||p.reduce((n,v)=>n+v*v,0)>1.5))invalid('normals','One approximately unit normal is required per sample');
 if(m.controls[0]!==0||m.controls.at(-1)!==m.points.length-1||m.controls.some((v,i)=>!Number.isInteger(v)||v<0||v>=m.points.length||(i>0&&v<=m.controls[i-1])))invalid('controls','Controls must be strictly increasing sample indices including both endpoints');
 if(m.kind==='point'&&(m.points.length!==1||m.closed))invalid('kind','Points require one sample and cannot be closed');
 if(m.kind==='line'&&(m.points.length<2||(m.closed&&m.controls.length<3)))invalid('points','Lines require two samples; closed lines require three controls');}
}
