import type { Box3 } from 'three';
import type { PublicScene, Vec3 } from './api';

export type Presentation = 'spatial' | 'focus' | 'fullscreen';
export interface SceneEntity {
  id: string;
  component: string;
  renderer?: {plugin:string; revision:string; name:string; frame_origins?: string[]; capabilities: Omit<ComponentCapabilities, "input">};
  state?: unknown;
  source: {kind: 'mesh' | 'attachment'; index: number};
  label: string;
  group: string | null;
  position: Vec3 | null;
  size: [number, number] | null;
  visible: boolean;
  opacity: number;
}
export type EntityUpdate = Pick<SceneEntity, 'id' | 'label' | 'position' | 'size' | 'visible' | 'opacity' | 'state'>;
export interface ComponentCapabilities {
  presentations: readonly Presentation[];
  movable: boolean;
  resizable: boolean;
  /** The shell owns navigation in space; content owns input when expanded. */
  input: Readonly<Record<Presentation, 'scene' | 'content'>>;
  /** Additional controls exposed only by geometric component definitions. */
  geometry?: 'mesh' | 'points';
}
export interface ComponentRuntime {
  readonly bounds: Box3;
  readonly ready?: Promise<void>;
  readonly element?: HTMLElement;
  setPosition(position: Vec3): void;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  setLabel(label: string): void;
  setPresentation(mode: Presentation): void;
  select(): void;
  focus(): void;
  dispose(): void;
}
export interface ComponentDefinition<Context> {
  type: string;
  capabilities: ComponentCapabilities;
  create(spec: SceneEntity, context: Context): ComponentRuntime;
}
/** Renderers register here; tree, grouping and sharing have no component-specific branches. */
export class ComponentRegistry<Context> {
  private definitions = new Map<string, ComponentDefinition<Context>>();
  register(definition: ComponentDefinition<Context>): this {
    if (this.definitions.has(definition.type)) throw new Error(`Duplicate component: ${definition.type}`);
    this.definitions.set(definition.type, definition);
    return this;
  }
  get(type: string): ComponentDefinition<Context> {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`Unsupported component: ${type}`);
    return definition;
  }
}
export function sceneEntities(scene: PublicScene): SceneEntity[] {
  if (scene.entities?.length) return structuredClone(scene.entities);
  if (scene.components?.length) return structuredClone(scene.components);
  return scene.meshes.map((mesh, index) => ({
    id: `mesh-${index}`, component: mesh.format === 'pts' ? 'points' : 'mesh', source: {kind: 'mesh', index},
    label: mesh.label?.text ?? mesh.name,
    group: scene.label_groups?.find(g => g.meshes.includes(index))?.text ?? null,
    position: mesh.translation ?? [0, 0, 0], size: null, visible: mesh.visible, opacity: mesh.opacity,
  }));
}
export function entityUpdate(spec: SceneEntity): EntityUpdate {
  return {...(spec.state === undefined ? {} : {state:spec.state}), id: spec.id, label:spec.label, position: spec.position ? [...spec.position] : null, size: spec.size ? [...spec.size] : null, visible: spec.visible, opacity: spec.opacity};
}
/** Insertion order is stable. A scene has one flat list of groups, never nested scenes. */
export function componentGroups(components: readonly SceneEntity[]): Map<string, SceneEntity[]> {
  const groups = new Map<string, SceneEntity[]>();
  for (const component of components) {
    const key = component.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(component);
  }
  return groups;
}
export function effectiveVisibility(spec: Pick<SceneEntity, 'visible' | 'opacity'>): boolean {
  return spec.visible && spec.opacity > 0;
}
