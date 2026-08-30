export type MeshFormat = 'ply' | 'stl' | 'obj' | 'pts';
export type MeshQuality = 'lod' | 'raw';
export type Shading = 'smooth' | 'flat' | 'wire';
export type Projection = 'perspective' | 'orthographic';
export type Background = 'dark' | 'light';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
  zoom: number;
  orthographic_height: number;
}

export interface ScreenStroke {
  color: string;
  aspect: number;
  points: Array<[number, number]>;
}

export interface ViewState {
  selected: number;
  shading: Shading;
  projection: Projection;
  background: Background;
  axes: boolean;
  frame: { width: number; height: number };
  camera: CameraState | null;
  strokes: ScreenStroke[];
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
}

export interface PublicScene {
  title: string;
  meshes: PublicMesh[];
  state: ViewState;
  owner: boolean;
}

export interface ShareLinks {
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
  meshes: Array<{ color: string; opacity: number; visible: boolean; quality: MeshQuality }>;
  state: ViewState;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function headers(owner?: string): HeadersInit {
  return owner ? { Authorization: `Bearer ${owner}` } : {};
}

export async function loadScene(token: string, owner?: string): Promise<PublicScene> {
  const response = await fetch(`/api/v1/scenes/${token}`, { headers: headers(owner), cache: 'no-store' });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<PublicScene>;
}

export async function shareScene(token: string, update: SceneUpdate, owner?: string, origin?: string): Promise<ShareResponse> {
  const response = await fetch(`/api/v1/scenes/${token}/share`, {
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
