import type { SceneComponent, ComponentUpdate } from "./scene-components";
export type MeshFormat = 'ply' | 'stl' | 'obj' | 'pts';
export type MeshQuality = 'lod' | 'raw';
export type Shading = 'smooth' | 'flat' | 'wire';
export type Projection = 'perspective' | 'orthographic';
export type Background = 'dark' | 'light';
export type RenderMode = 'matte' | 'raking' | 'normals';
export interface LightSettings { azimuth: number; elevation: number; intensity: number }

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  zoom: number;
  orthographic_height: number;
}

export interface ScreenStroke {
  label?: string;
  color: string;
  aspect: number;
  points: Array<[number, number]>;
}

export type Vec3 = [number, number, number];
export interface SurfaceAnnotation {
  id: string;
  mesh: number;
  revision: string;
  kind: 'point' | 'line';
  label: string;
  color: string;
  visible: boolean;
  closed: boolean;
  points: Vec3[];
  normals: Vec3[];
  controls: number[];
}

export interface ViewState {
  selected: number;
  focused_component_id?: string | null;
  shading: Shading;
  render_mode?: RenderMode;
  light?: LightSettings;
  projection: Projection;
  background: Background;
  axes: boolean;
  frame: { width: number; height: number };
  camera: CameraState | null;
  strokes: ScreenStroke[];
  annotations?: SurfaceAnnotation[];
}

export interface PublicMesh {
  name: string;
  format: MeshFormat;
  revision: string;
  byte_size: number;
  color: string;
  opacity: number;
  visible: boolean;
  quality: MeshQuality;
  source_url: string;
  translation?: Vec3;
  label?: MeshLabel | null;
}

export interface MeshLabel {
  text: string;
  anchor?: [number, number, number];
}

export interface MeshLabelGroup {
  text: string;
  meshes: number[];
}

export interface PublicScene {
  components?: SceneComponent[];
  ttl_days?: number;
  source?: { id: string; name: string; host: string; user: string } | null;
  title: string;
  meshes: PublicMesh[];
  label_groups: MeshLabelGroup[];
  state: ViewState;
  owner: boolean;
  attachments?: Array<{id: string; label: string; byte_size: number | null; url: string | null; unavailable: string | null}>;
  warnings?: Array<{code: string; message: string; resource_id?: string}>;
}

export interface CollectionOverview {
  kind: 'collection';
  title: string;
  active_scene_id: string;
  scenes: Array<{id: string; title: string}>;
  strokes: ScreenStroke[];
  layout?: CollectionLayout | null;
  owner: boolean;
  ttl_days: number;
}

export interface CollectionLayout { width: number; height: number; columns: number; }

export interface ShareLinks {
  ttl_days?: number;
  viewer_url: string;
  image_url: string;
  owner_url?: string;
  full_text?: string;
}

export interface HostCandidate {
  origin: string;
  address: string;
  scope: 'configured' | 'current' | 'private' | 'global' | 'local';
  interface: string;
  primary: boolean;
}

export interface ShareResponse extends ShareLinks {
  /** Origin used to compose the links. */
  origin: string;
  hosts: HostCandidate[];
}

export interface SceneUpdate {
  components?: ComponentUpdate[];
  meshes: Array<{ color: string; opacity: number; visible: boolean; quality: MeshQuality; label?: MeshLabel | null }>;
  state: ViewState;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function headers(owner?: string): HeadersInit {
  return owner ? { Authorization: `Bearer ${owner}` } : {};
}

export async function loadScene(token: string, owner?: string): Promise<PublicScene> {
  const selected = new URLSearchParams(location.search).get('scene');
  const response = await fetch(`api/v1/scenes/${token}${selected ? `?scene=${encodeURIComponent(selected)}` : ''}`, { headers: headers(owner), cache: 'no-store' });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<PublicScene>;
}

export async function loadCollection(token: string, owner?: string): Promise<CollectionOverview> {
  const response = await fetch(`api/v1/scenes/${token}`, {headers: headers(owner), cache: 'no-store'});
  if (!response.ok) throw await apiError(response);
  const payload = await response.json() as CollectionOverview;
  if (payload.kind !== 'collection') throw new Error('This link is not a scene collection');
  return payload;
}

export async function shareCollection(token: string, activeSceneId: string, updates: Record<string, SceneUpdate>, strokes: ScreenStroke[], layout: CollectionLayout, owner?: string, origin?: string): Promise<ShareResponse> {
  const response = await fetch(`api/v1/scenes/${token}/share`, {
    method: 'POST', headers: {'Content-Type':'application/json', ...headers(owner)},
    body: JSON.stringify({active_scene_id: activeSceneId, updates, strokes, layout, ...(origin ? {origin} : {})}), cache: 'no-store',
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<ShareResponse>;
}

export async function shareScene(token: string, update: SceneUpdate, owner?: string, origin?: string): Promise<ShareResponse> {
  const response = await fetch(`api/v1/scenes/${token}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(owner) },
    body: JSON.stringify({ ...update, ...(origin ? { origin } : {}) }),
    cache: 'no-store',
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<ShareResponse>;
}

export async function apiError(response: Response): Promise<ApiError> {
  const payload = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
  return new ApiError(response.status, payload.error ?? response.statusText);
}
