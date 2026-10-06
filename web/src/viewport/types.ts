import type { MeshViewer } from '../viewer';
import type { BoardViewport } from './board';

/** Common members are deliberately only real viewport behavior; geometry requires kind narrowing. */
export type SceneViewport = MeshViewer | BoardViewport;
