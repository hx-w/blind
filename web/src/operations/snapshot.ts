import type {SceneUpdate} from '../api';
import {s, type Schema} from './core';
import {screenStrokeSchema, surfaceAnnotationSchema} from './annotations';
import {sectionStateSchema} from './section';

const vec3 = s.tuple([s.number(), s.number(), s.number()]);
const vec2 = s.tuple([s.number(), s.number()]);
const label = s.object({text:s.string(),anchor:s.optional(vec3)});
const camera = s.object({position:vec3,target:vec3,up:vec3,fov:s.number(),zoom:s.number(),orthographic_height:s.number()});
const quality = s.enum(['raw','lod']);
export const sceneUpdateSchema: Schema<SceneUpdate> = s.object({
  entities:s.optional(s.array(s.object({id:s.string(),label:s.string(),placement:s.enum(['world','panel']),position:s.nullable(vec3),size:s.nullable(vec2),visible:s.boolean(),opacity:s.number({min:0,max:1}),state:s.optional(s.json('Host-reserved opaque component state; not part of entity/content discovery.'))}))),
  meshes:s.array(s.object({color:s.string(),opacity:s.number({min:0,max:1}),visible:s.boolean(),quality,label:s.optional(s.nullable(label))})),
  state:s.object({selected:s.number({integer:true}),viewport:s.object({mode:s.enum(['auto','board','spatial']),board:s.optional(s.object({center:vec2,scale:s.number({min:Number.MIN_VALUE})}))}),focused_component_id:s.optional(s.nullable(s.string())),shading:s.enum(['smooth','flat','wire']),render_mode:s.optional(s.enum(['matte','raking','normals'])),light:s.optional(s.object({azimuth:s.number({min:-180,max:180}),elevation:s.number({min:0,max:90}),intensity:s.number({min:0,max:2})})),projection:s.enum(['perspective','orthographic']),background:s.enum(['dark','light']),axes:s.boolean(),frame:s.object({width:s.number({min:0}),height:s.number({min:0})}),camera:s.nullable(camera),strokes:s.array(screenStrokeSchema,{max:64}),annotations:s.optional(s.array(surfaceAnnotationSchema,{max:64})),section:s.optional(s.nullable(sectionStateSchema))}),
});
