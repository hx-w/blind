import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast, disposeBoundsTree } from 'three-mesh-bvh';
import { ArcballControls } from 'three/addons/controls/ArcballControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { apiError, type LightSettings, type MeshLabelGroup, type MeshQuality, type PublicMesh, type PublicScene, type RenderMode, type SceneUpdate, type ScreenStroke, type SectionState, type ViewState } from './api';
import { createObjectMaterial, updateObjectMaterial } from './material';
import { MeshLabels } from './labels';
import { SurfaceInk } from './surface-render';
import type { SurfaceAnnotation, Vec3 } from './api';
import { mapConcurrent } from './load-queue';
import shader from '../../shaders/matte.json';

const LOAD_CONCURRENCY = 4;
const RAW_FALLBACK_BYTES = 32 * 1024 * 1024;
const RAW_FALLBACK_SCENE_BYTES = 64 * 1024 * 1024;

// Arcball's public target is stale after pan/cursor zoom. The pinned Three.js
// version exposes its live rotation pivot only through the internal gizmo.
declare module 'three/addons/controls/ArcballControls.js' {
  interface ArcballControls {
    target: THREE.Vector3;
    readonly _gizmos: THREE.Group;
  }
}

export interface ViewerMesh extends PublicMesh {
  raw_bytes: number;
  lod_bytes?: number;
  loading: boolean;
  lod_error?: string;
}

interface Model {
  info: ViewerMesh;
  object: THREE.Object3D;
  bounds: THREE.Box3;
}

interface LoadedObject {
  object: THREE.Object3D;
  payloadBytes: number;
  rawBytes?: number;
}

export interface MeshLoadProgress {
  completed: number;
  total: number;
  rawFallbacks: number;
  failed: number;
}

export class MeshViewer {
  private readonly scene = new THREE.Scene();
  private readonly surfaceInk = new SurfaceInk();
  private annotationSelection?: string;
  private annotationPreview?: Vec3;
  private interactionEnabled = true;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: MeshLabels;
  private readonly perspective = new THREE.PerspectiveCamera(shader.camera.fov_degrees, 1, 0.001, 1_000_000);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1_000_000);
  private readonly controls: ArcballControls;
  private readonly axes = new THREE.AxesHelper(1);
  private readonly sectionLines = new THREE.Group();
  private readonly sectionFill = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private readonly visibleBounds = new THREE.Box3();
  private readonly componentBounds = new THREE.Box3();
  readonly renderListeners = new Set<() => void>();
  entityUpdates?: () => SceneUpdate['entities'];
  get activeCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera { return this.camera; }
  invalidate(): void {
    this.dirty = true;
    if (!this.frameRequested) {
      this.frameRequested = true;
      requestAnimationFrame(this.animate);
    }
  }
  navigatePointer(event: PointerEvent): void { this.renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', event)); }
  navigateWheel(event: WheelEvent): void { this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', event)); }
  renderGeometryBand(canvas: HTMLCanvasElement, minZ: number, maxZ: number): void {
    const inBand = (bounds: THREE.Box3) => !bounds.isEmpty() && bounds.max.z >= minZ && bounds.min.z < maxZ;
    const geometry = new Set(this.models.filter(model => model.info.visible && model.info.opacity > 0 && inBand(model.bounds)).map(model => model.object));
    // Keep the same clipping contract for mesh annotations and scene helpers.
    for (const object of [this.axes, this.surfaceInk.object, this.sectionFill, this.sectionLines]) {
      if (object.visible && inBand(new THREE.Box3().setFromObject(object))) geometry.add(object);
    }
    if (!geometry.size) {
      // Empty depth intervals need no viewport-sized bitmap. Release any buffer
      // retained from a previous camera/visibility arrangement as well.
      if (canvas.width) canvas.width = 0;
      if (canvas.height) canvas.height = 0;
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (canvas.width !== size.x) canvas.width = size.x;
    if (canvas.height !== size.y) canvas.height = size.y;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    context.clearRect(0, 0, size.x, size.y);
    const clippingPlanes = [];
    if (Number.isFinite(minZ)) clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -minZ));
    // Half-open bands assign coplanar geometry to exactly one canvas. A small
    // float-precision inset makes the upper boundary exclusive on the GPU too.
    if (Number.isFinite(maxZ)) clippingPlanes.push(new THREE.Plane(new THREE.Vector3(0, 0, -1), maxZ - Math.max(1e-7, Math.abs(maxZ) * 1e-7)));
    const previousClipping = this.renderer.clippingPlanes;
    const previousTarget = this.renderer.getRenderTarget();
    const clearColor = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    const visibility = this.scene.children.map(object => ({object, visible: object.visible}));
    try {
      for (const {object} of visibility) object.visible = geometry.has(object);
      this.renderer.clippingPlanes = clippingPlanes;
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0, 0);
      this.renderer.render(this.scene, this.camera);
      // Copy immediately while the WebGL drawing buffer is valid. The browser
      // performs the canvas transfer without a CPU pixel readback.
      context.drawImage(this.renderer.domElement, 0, 0);
    } finally {
      for (const {object, visible} of visibility) object.visible = visible;
      this.renderer.clippingPlanes = previousClipping;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(clearColor, clearAlpha);
    }
  }
  meshBounds(index: number): THREE.Box3 { return this.models[index]?.bounds.clone() ?? new THREE.Box3(); }
  setMeshPosition(index: number, position: Vec3): void {
    const model = this.models[index]; if (!model) return;
    const delta = new THREE.Vector3().fromArray(position).sub(model.object.position);
    // Annotations are world-space and travel with their component.
    for (const mark of this.annotations.filter(mark => mark.mesh === index)) {
      mark.points = mark.points.map(point => new THREE.Vector3().fromArray(point).add(delta).toArray() as Vec3);
    }
    if (model.info.label?.anchor) model.info.label.anchor = new THREE.Vector3().fromArray(model.info.label.anchor).add(delta).toArray() as Vec3;
    model.info.translation = [...position]; model.object.position.fromArray(position);
    model.bounds.setFromObject(model.object); this.labels.invalidateLayout(); this.relayout();
  }
  setMeshOpacity(index: number, opacity: number): void {
    const model = this.models[index]; if (!model) return;
    const wasVisible = model.info.opacity > 0;
    model.info.opacity = opacity; this.applyMaterials();
    if (wasVisible !== (opacity > 0)) this.onModelChange?.();
  }
  setComponentBounds(bounds: THREE.Box3): void { this.componentBounds.copy(bounds); this.relayout(); }
  focusBounds(bounds: THREE.Box3): void { if (!bounds.isEmpty()) this.fitBox(bounds, false); }

  private readonly rendererSize = new THREE.Vector2();
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private models: Model[] = [];
  private entityIdsByMesh = new Map<number, string>();
  private labelGroups: MeshLabelGroup[] = [];
  private state!: ViewState;
  private selected = 0;
  private dirty = false;
  private frameRequested = false;
  private fitAnimation?: number;
  private pointerStart: { x: number; y: number } | null = null;
  private lastTap = { index: -1, time: 0 };
  onSelectionChange?: (index: number) => void;
  onModelChange?: () => void;
  onLoadProgress?: (progress: MeshLoadProgress) => void;
  onViewChangeStart?: () => void;
  onRender?: () => void;

  constructor(private readonly root: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.root.append(this.renderer.domElement);
    this.labels = new MeshLabels(this.root, (meshes, animate) => this.focusLabelGroup(meshes, animate));
    this.camera = this.perspective;
    this.camera.position.fromArray(shader.camera.default_view_direction);
    this.raycaster.firstHitOnly = true;
    this.controls = new ArcballControls(this.camera, this.renderer.domElement, this.scene);
    this.controls.enableAnimations = false;
    this.controls.enableFocus = false;
    this.controls.enableGrid = false;
    this.controls.adjustNearFar = false;
    this.controls.setGizmosVisible(false);
    this.controls.minDistance = 0.0001;
    this.controls.maxDistance = 1_000_000;
    setHelperOpacity(this.axes, 0.78);
    this.sectionLines.visible = false;
    this.sectionFill.visible = false;
    this.scene.add(this.axes, this.surfaceInk.object, this.sectionFill, this.sectionLines);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.controls.addEventListener('start', () => { this.cancelFit(); this.prepareOrbit(); this.onViewChangeStart?.(); });
    this.controls.addEventListener('change', () => { this.updateClipping(); this.invalidate(); });
    this.invalidate();
  }

  async load(scene: PublicScene, skipHidden = false): Promise<void> {
    this.disposeModels();
    const entities = scene.entities;
    this.entityIdsByMesh = new Map(entities.filter(entity => entity.source.kind === 'mesh').map(entity => [entity.source.index, entity.id]));
    this.labelGroups = scene.label_groups;
    this.state = structuredClone(scene.state);
    this.state.render_mode ??= 'matte';
    this.state.light ??= {azimuth: 45, elevation: 20, intensity: 1};
    this.state.strokes ??= [];
    this.state.annotations ??= [];
    this.selected = Math.min(scene.state.selected, Math.max(scene.meshes.length - 1, 0));
    let completed = 0;
    let rawFallbacks = 0;
    let rawFallbackBytes = 0;
    let failed = 0;
    this.onLoadProgress?.({ completed, total: scene.meshes.length, rawFallbacks, failed });
    const loaded = await mapConcurrent(scene.meshes, LOAD_CONCURRENCY, async (info) => {
      let result;
      const requestedQuality = this.annotations.some(mark => mark.mesh === scene.meshes.indexOf(info)) ? 'raw' : info.quality ?? 'lod';
      if (skipHidden && (!info.visible || info.opacity === 0)) {
        completed += 1;
        this.onLoadProgress?.({ completed, total: scene.meshes.length, rawFallbacks, failed });
        return {quality: requestedQuality};
      }
      try {
        result = { quality: requestedQuality, asset: await loadObject(info, requestedQuality) };
      } catch (error) {
        const lodError = error instanceof Error ? error.message : 'Mesh 不可用';
        if (
          requestedQuality === 'lod'
          && info.byte_size <= RAW_FALLBACK_BYTES
          && rawFallbackBytes + info.byte_size <= RAW_FALLBACK_SCENE_BYTES
        ) {
          rawFallbackBytes += info.byte_size;
          try {
            result = { quality: 'raw' as const, asset: await loadObject(info, 'raw'), lodError };
            rawFallbacks += 1;
          } catch (rawError) {
            failed += 1;
            result = { quality: requestedQuality, lodError: rawError instanceof Error ? rawError.message : lodError };
          }
        } else {
          failed += 1;
          result = { quality: requestedQuality, lodError };
        }
      }
      completed += 1;
      this.onLoadProgress?.({ completed, total: scene.meshes.length, rawFallbacks, failed });
      return result;
    });
    loaded.forEach(({ quality, asset, lodError }, index) => {
      const source = scene.meshes[index];
      const info: ViewerMesh = { ...source, raw_bytes: source.byte_size, loading: false, lod_error: lodError };
      const object = asset?.object ?? new THREE.Group();
      if (asset) this.applyLoadedInfo(info, quality, asset);
      this.prepareObject(object, index, info);
      this.models.push({ info, object, bounds: new THREE.Box3().setFromObject(object) });
      this.scene.add(object);
    });
    this.applyState();
    this.refreshVisibleBounds();
    this.resize();
    await settledLayout();
    if (scene.state.camera) this.restoreCamera(scene.state);
    else this.fitAll(false);
    this.labels.invalidateLayout();
    this.resizeHelpers();
  }

  get selectedIndex(): number { return this.selected; }
  get selectedModel(): ViewerMesh | undefined { return this.models[this.selected]?.info; }
  get modelInfos(): ViewerMesh[] { return this.models.map((model) => model.info); }
  get currentState(): ViewState { return this.exportState(); }
  sectionSource(index: number): {object: THREE.Object3D; bounds: THREE.Box3; revision: string; name: string; entityId: string} | null {
    const model = this.models[index];
    return model && this.hasSurface(index)
      ? {object: model.object, bounds: model.bounds.clone(), revision: model.info.revision, name: model.info.label?.text ?? model.info.name, entityId: this.entityIdsByMesh.get(index) ?? `mesh-${index}`}
      : null;
  }
  sectionTarget(index: number): ReturnType<MeshViewer['sectionSource']> {
    const info = this.models[index]?.info;
    return info?.visible && info.opacity > 0 ? this.sectionSource(index) : null;
  }
  sectionPick(index: number, x: number, y: number): THREE.Vector3 | null {
    const target = this.sectionTarget(index); if (!target) return null;
    const rect = this.root.getBoundingClientRect();
    this.pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObject(target.object, true)[0]?.point.clone() ?? null;
  }
  sectionCameraBasis(): {right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3} {
    return {
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion),
      forward: this.camera.getWorldDirection(new THREE.Vector3()),
    };
  }
  sectionWorldPerPixel(point: THREE.Vector3): number {
    const height = Math.max(this.root.clientHeight, 1);
    if (this.camera instanceof THREE.OrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / height;
    const depth = Math.max(point.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())), this.camera.near);
    return depth * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / this.camera.zoom / height;
  }
  revealSection(normal: THREE.Vector3, axis: THREE.Vector3): void {
    if (Math.abs(this.camera.getWorldDirection(new THREE.Vector3()).dot(normal)) > .24) return;
    this.cancelFit();
    const pivot = this.captureCameraPose().target;
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), THREE.MathUtils.degToRad(24));
    this.camera.position.sub(pivot).applyQuaternion(rotation).add(pivot);
    this.camera.up.applyQuaternion(rotation);
    this.controls.target.copy(pivot);
    this.syncCamera();
  }
  setSection(section: SectionState | null): void {
    const prior = this.state.section;
    this.state.section = section;
    if (!section || prior?.entity_id !== section.entity_id || prior.mesh !== section.mesh) this.setSectionSegments([]);
  }
  setSectionSegments(sections: readonly {segments: readonly {a: THREE.Vector3; b: THREE.Vector3}[]; caps: readonly THREE.BufferGeometry[]; color: string}[]): void {
    for (const group of [this.sectionLines, this.sectionFill]) {
      for (const child of group.children) {
        (child as THREE.Mesh).geometry.dispose();
        const material = (child as THREE.Mesh).material;
        for (const item of Array.isArray(material) ? material : [material]) item.dispose();
      }
      group.clear();
    }
    for (const {segments, caps, color} of sections) {
      const positions = new Float32Array(segments.length * 6);
      segments.forEach(({a, b}, index) => positions.set([a.x, a.y, a.z, b.x, b.y, b.z], index * 6));
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color, transparent:true, opacity:.95, depthTest:false}));
      lines.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      lines.renderOrder = 20; this.sectionLines.add(lines);
      const fillColor = new THREE.Color(color).lerp(new THREE.Color(0xffffff), .35);
      for (const geometry of caps) {
        const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({color:fillColor, transparent:true, opacity:.36, side:THREE.DoubleSide, depthTest:false, depthWrite:false}));
        fill.renderOrder = 19; this.sectionFill.add(fill);
      }
    }
    this.sectionLines.visible = !!this.state.section && this.sectionLines.children.length > 0;
    this.sectionFill.visible = !!this.state.section && this.sectionFill.children.length > 0;
    this.invalidate();
  }
  get focusedComponentId(): string | undefined { return this.state.focused_component_id ?? undefined; }
  setFocusedComponent(id: string): void { this.state.focused_component_id = id; }

  setInteractionEnabled(enabled: boolean): void { this.controls.enabled = enabled; this.interactionEnabled = enabled; this.pointerStart = null; }
  get annotations(): SurfaceAnnotation[] { return this.state?.annotations ?? []; }
  setAnnotations(marks: SurfaceAnnotation[], selected?: string, preview?: Vec3): void {
    this.state.annotations = marks; this.annotationSelection = selected; this.annotationPreview = preview; this.invalidate();
  }
  hasSurface(index: number): boolean {
    let found = false;
    if (this.models[index]?.info.format === 'pts') return false;
    this.models[index]?.object.traverse(child => { if (child instanceof THREE.Mesh && child.geometry.getAttribute('position')?.count) found = true; });
    return found;
  }
  projectSurface(point: Vec3): {x: number; y: number; visible: boolean} {
    const p = new THREE.Vector3(...point).project(this.camera), rect = this.root.getBoundingClientRect();
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2, visible: p.z > -1 && p.z < 1 };
  }
  pickSurface(x: number, y: number, target?: number): {point: Vec3; normal: Vec3; mesh: number} | null {
    const rect = this.root.getBoundingClientRect();
    this.pointer.set((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.models.filter(m => m.info.visible && m.info.opacity > 0).map(m => m.object), true)[0];
    if (!hit || (target !== undefined && hit.object.userData.modelIndex !== target) || !(hit.object instanceof THREE.Mesh) || !hit.face) return null;
    return {mesh: hit.object.userData.modelIndex, point: hit.point.toArray() as Vec3, normal: hit.face.normal.clone().transformDirection(hit.object.matrixWorld).toArray() as Vec3};
  }
  geometryOccludes(x: number, y: number, point: Vec3): boolean {
    // Input must follow painted coverage, including wireframe gaps and points.
    // Sample geometry alone before the content plane; DOM backdrops and holes
    // must not count as occluders. Annotation picking remains triangle based.
    const rect = this.root.getBoundingClientRect();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const px = Math.floor((x - rect.left) / rect.width * size.x);
    const py = Math.floor((y - rect.top) / rect.height * size.y);
    if (px < 0 || py < 0 || px >= size.x || py >= size.y) return false;
    const camera = this.camera.clone();
    const depth = -new THREE.Vector3(...point).applyMatrix4(camera.matrixWorldInverse).z;
    camera.far = Math.min(camera.far, depth - Math.max(depth * 1e-6, 1e-7));
    if (camera.far <= camera.near) return false;
    camera.setViewOffset(size.x, size.y, px, py, 1, 1);
    const target = new THREE.WebGLRenderTarget(1, 1, {samples: 4});
    const previousTarget = this.renderer.getRenderTarget();
    const clearColor = this.renderer.getClearColor(new THREE.Color());
    const clearAlpha = this.renderer.getClearAlpha();
    const geometry = new Set(this.models.filter(m => m.info.visible && m.info.opacity > 0).map(m => m.object));
    const visibility = this.scene.children.map(object => ({object, visible: object.visible}));
    const pixel = new Uint8Array(4);
    try {
      for (const {object} of visibility) object.visible = geometry.has(object);
      this.renderer.setRenderTarget(target);
      this.renderer.setClearColor(0, 0);
      this.renderer.render(this.scene, camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      return pixel[3] > 0;
    } finally {
      for (const {object, visible} of visibility) object.visible = visible;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(clearColor, clearAlpha);
      target.dispose();
    }
  }
  surfacePointVisible(point: Vec3, target: number): boolean {
    const p = this.projectSurface(point); if (!p.visible) return false;
    const hit = this.pickSurface(p.x, p.y, target); if (!hit) return false;
    const tolerance = this.models[target].bounds.getSize(new THREE.Vector3()).length() * 0.002;
    return new THREE.Vector3(...hit.point).distanceTo(new THREE.Vector3(...point)) <= tolerance;
  }
  focusAnnotation(mark: SurfaceAnnotation): void {
    const i = Math.floor(mark.points.length / 2), point = mark.points[i];
    const screen = this.projectSurface(point), rect = this.root.getBoundingClientRect();
    if (this.surfacePointVisible(point, mark.mesh) && screen.x > rect.left+40 && screen.x < rect.right-40 && screen.y > rect.top+90 && screen.y < rect.bottom-280) return;
    this.onViewChangeStart?.();
    const anchor = new THREE.Vector3(...point), normal = new THREE.Vector3(...mark.normals[i]).normalize();
    const distance = Math.max(this.camera.position.distanceTo(this.controls.target), this.surfaceScale(mark.mesh));
    this.camera.position.copy(anchor).addScaledVector(normal, distance);
    this.controls.target.copy(anchor);
    if (Math.abs(normal.dot(this.camera.up)) > 0.95) this.camera.up.set(0,0,1);
    this.syncCamera();
  }
  surfaceScale(index: number): number { return this.models[index]?.bounds.getSize(new THREE.Vector3()).length() ?? 1; }

  // Takes ownership of the array handed over by MarkupCanvas.exportStrokes().
  setStrokes(strokes: ScreenStroke[]): void { this.state.strokes = strokes; }

  select(index: number): void {
    if (!this.models[index]) return;
    this.selected = index;
    this.applyMaterials();
    this.onSelectionChange?.(index);
  }

  setVisible(index: number, visible: boolean): void {
    const model = this.models[index];
    if (!model) return;
    if (model.info.visible === visible && model.object.visible === visible) return;
    model.info.visible = visible;
    model.object.visible = visible;
    this.relayout();
    this.onModelChange?.();
  }

  private readonly qualityLoads = new Map<number, Promise<void>>();
  async setQuality(index: number, quality: MeshQuality): Promise<void> {
    while(this.qualityLoads.has(index)) await this.qualityLoads.get(index)!.catch(()=>{});
    const request=this.loadQuality(index,quality); this.qualityLoads.set(index,request);
    try {await request;} finally {if(this.qualityLoads.get(index)===request)this.qualityLoads.delete(index);}
  }
  private async loadQuality(index: number, quality: MeshQuality): Promise<void> {
    if (quality === 'lod' && this.annotations.some(mark => mark.mesh === index)) throw new Error('含表面标记的 Mesh 保持 Raw，以保证位置一致');
    const model = this.models[index];
    if (!model || model.info.quality === quality || model.info.loading) return;
    model.info.loading = true;
    model.info.lod_error = undefined;
    this.onModelChange?.();
    try {
      const loaded = await loadObject(model.info, quality);
      if(quality==='lod' && this.annotations.some(mark=>mark.mesh===index)) {
        disposeObject(loaded.object); throw new Error('含表面标记的 Mesh 保持 Raw，以保证位置一致');
      }
      this.prepareObject(loaded.object, index, model.info);
      loaded.object.visible = model.info.visible;
      this.scene.add(loaded.object);
      this.scene.remove(model.object);
      disposeObject(model.object);
      model.object = loaded.object;
      model.bounds.setFromObject(loaded.object);
      this.applyLoadedInfo(model.info, quality, loaded);
      this.relayout();
    } catch (error) {
      if (quality === 'lod') {
        model.info.lod_error = error instanceof Error ? error.message : 'LOD 不可用';
      }
      throw error;
    } finally {
      model.info.loading = false;
      this.onModelChange?.();
    }
  }

  setMeshColor(index: number, color: string): void {
    const model = this.models[index]; if (!model || model.info.color === color) return;
    model.info.color = color; this.applyMaterials(); this.onModelChange?.();
  }
  setLabelAt(index: number, text: string): void {
    const model = this.models[index];
    if (!model) return;
    model.info.label = text.trim() && text !== model.info.name ? { ...model.info.label, text } : null;
    this.refreshLabels();
  }

  refreshLabels(): void { this.labels.invalidateLayout(); this.invalidate(); }
  setOpacity(opacity: number): void { const model = this.models[this.selected]; if (model) { model.info.opacity = opacity; this.applyMaterials(); this.onModelChange?.(); } }
  setShading(shading: ViewState['shading']): void { this.state.shading = shading; this.applyMaterials(); }
  get renderMode(): RenderMode { return this.state.render_mode ?? 'matte'; }
  get lightSettings(): LightSettings { return {...(this.state.light ?? {azimuth: 45, elevation: 20, intensity: 1})}; }
  setRenderMode(mode: RenderMode): void { this.state.render_mode = mode; this.applyMaterials(); }
  setLight(settings: LightSettings): void { this.state.light = {...settings}; this.applyMaterials(); }
  setAxes(visible: boolean): void { this.state.axes = visible; this.axes.visible = visible; this.invalidate(); }
  setBackground(background: ViewState['background']): void {
    this.state.background = background;
    const theme = background === 'light' ? shader.background_light : shader.background_dark;
    this.scene.background = null;
    this.renderer.setClearColor(theme, 0);
    this.root.style.backgroundColor = theme;
    document.documentElement.dataset.theme = background;
    document.documentElement.style.setProperty('--scene-background', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme);
    this.invalidate();
  }

  setProjection(projection: ViewState['projection']): void {
    if (projection === this.state.projection) return;
    this.cancelFit(); this.onViewChangeStart?.();
    const { position, target, up } = this.captureCameraPose();
    if (projection === 'orthographic') {
      const distance = position.distanceTo(target);
      this.orthographic.position.copy(position); this.orthographic.up.copy(up);
      this.orthographic.zoom = 1; this.orthographic.userData.height = distance * 1.05;
      this.camera = this.orthographic;
    } else {
      this.perspective.position.copy(position); this.perspective.up.copy(up);
      this.camera = this.perspective;
    }
    this.state.projection = projection;
    this.controls.target.copy(target);
    this.resize(); this.syncCamera();
  }

  fitAll(animate = true): void {
    if (this.visibleBounds.isEmpty()) return;
    this.fitBox(this.visibleBounds, animate);
  }

  focusSelected(): void {
    const model = this.models[this.selected];
    if (!model) return;
    this.fitBox(model.bounds, true);
  }

  focusLabelGroup(indices: number[], animate = true): void {
    const bounds = new THREE.Box3();
    for (const index of indices) {
      const model = this.models[index];
      if (model?.info.visible) bounds.union(model.bounds);
    }
    if (!bounds.isEmpty()) this.fitBox(bounds, animate);
  }

  setCanonicalView(code: string): void {
    const box = this.visibleBounds; if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const distance = box.getSize(new THREE.Vector3()).length() * 1.8;
    const directions: Record<string, THREE.Vector3> = {
      px: new THREE.Vector3(1, 0, 0), nx: new THREE.Vector3(-1, 0, 0),
      py: new THREE.Vector3(0, 1, 0), ny: new THREE.Vector3(0, -1, 0),
      pz: new THREE.Vector3(0, 0, 1), nz: new THREE.Vector3(0, 0, -1),
    };
    const direction = directions[code]; if (!direction) return;
    this.onViewChangeStart?.();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.up.set(0, 1, 0);
    if (Math.abs(direction.y) > 0.9) this.camera.up.set(0, 0, direction.y > 0 ? -1 : 1);
    this.controls.target.copy(center); this.syncCamera();
  }

  exportUpdate(): SceneUpdate {
    return {
      meshes: this.models.map(({ info }) => ({ color: info.color, opacity: info.opacity, visible: info.visible, quality: info.quality, label: info.label ?? null })),
      state: this.exportState(),
      entities: this.entityUpdates?.(),
    };
  }

  resize(): void {
    const width = Math.max(this.root.clientWidth, 1); const height = Math.max(this.root.clientHeight, 1); const aspect = width / height;
    this.perspective.aspect = aspect; this.perspective.updateProjectionMatrix();
    const orthographicHeight = this.orthographic.userData.height ?? 2;
    this.orthographic.left = -orthographicHeight * aspect / 2; this.orthographic.right = orthographicHeight * aspect / 2;
    this.orthographic.top = orthographicHeight / 2; this.orthographic.bottom = -orthographicHeight / 2; this.orthographic.updateProjectionMatrix();
    this.updateClipping();
    this.invalidate();
  }

  // Single bookkeeping point for both load paths, so the raw/LOD accounting
  // cannot drift between them. Raw quality keeps a previously measured
  // lod_bytes so the panel can keep reporting the saving.
  private applyLoadedInfo(info: ViewerMesh, quality: MeshQuality, loaded: LoadedObject): void {
    info.quality = quality;
    info.raw_bytes = loaded.rawBytes ?? info.raw_bytes;
    if (quality === 'lod') info.lod_bytes = loaded.payloadBytes;
  }

  // Refresh the derived view state after a model's geometry or visibility changes.
  private relayout(): void {
    this.refreshVisibleBounds();
    this.resizeHelpers();
    this.prepareOrbit();
    this.updateClipping();
    this.invalidate();
  }

  private applyState(): void {
    this.setBackground(this.state.background); this.axes.visible = this.state.axes;
    this.models.forEach((model) => { model.object.visible = model.info.visible; });
    if (this.state.projection === 'orthographic') { this.state.projection = 'perspective'; this.setProjection('orthographic'); }
    this.applyMaterials();
    this.setSection(this.state.section ?? null);
  }

  private prepareObject(object: THREE.Object3D, index: number, info: ViewerMesh): void {
    object.position.fromArray(info.translation ?? [0, 0, 0]);
    object.updateMatrixWorld(true);
    object.userData.modelIndex = index;
    // Equal-depth samples use resource order; separated surfaces retain real depth.
    object.renderOrder = index;
    object.traverse((child) => {
      if (!isDrawable(child)) return;
      child.userData.modelIndex = index;
      child.renderOrder = index;
      const geometry = child.geometry as THREE.BufferGeometry;
      normalizeGeometry(geometry);
      child.material = createObjectMaterial(child, {
        color: info.color,
        opacity: info.opacity,
        flat: info.format !== 'pts' && this.state.shading === 'flat',
        wireframe: info.format !== 'pts' && this.state.shading === 'wire',
        curve: info.format === 'pts',
        renderMode: this.renderMode,
        light: this.lightSettings,
      }, this.renderer.getPixelRatio());
      if (child instanceof THREE.Points) return;
      // Review the geometry itself rather than trusting optional exporter normals,
      // which are frequently quantized or face-split in scan files.
      geometry.deleteAttribute('normal');
      geometry.computeVertexNormals();
      // Raw meshes are immutable. Keep source triangle order while accelerating
      // surface hits and annotation occlusion queries for every camera frame.
      if (child instanceof THREE.Mesh) {
        geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
        child.raycast = acceleratedRaycast;
      }
    });
  }

  private applyMaterials(): void {
    this.models.forEach((model) => model.object.traverse((child) => {
      if (!isDrawable(child)) return;
      updateObjectMaterial(child, {
        color: model.info.color,
        opacity: model.info.opacity,
        flat: model.info.format !== 'pts' && this.state.shading === 'flat',
        wireframe: model.info.format !== 'pts' && this.state.shading === 'wire',
        curve: model.info.format === 'pts',
        renderMode: this.renderMode,
        light: this.lightSettings,
      });
    }));
    this.invalidate();
  }

  private restoreCamera(state: ViewState): void {
    const saved = state.camera; if (!saved) return;
    this.camera.position.fromArray(saved.position); this.camera.up.fromArray(saved.up); this.controls.target.fromArray(saved.target);
    this.perspective.fov = saved.fov; this.perspective.updateProjectionMatrix();
    this.orthographic.zoom = saved.zoom; this.orthographic.userData.height = saved.orthographic_height;
    this.resize(); this.syncCamera();
  }

  private exportState(): ViewState {
    const cameraPose = this.captureCameraPose();
    return {
      selected: this.selected, focused_component_id: this.state.focused_component_id, shading: this.state.shading, render_mode: this.renderMode, light: this.lightSettings, projection: this.state.projection,
      background: this.state.background, axes: this.axes.visible,
      frame: { width: Math.round(this.root.clientWidth), height: Math.round(this.root.clientHeight) },
      camera: {
        position: cameraPose.position.toArray() as [number, number, number],
        target: cameraPose.target.toArray() as [number, number, number],
        up: cameraPose.up.toArray() as [number, number, number],
        fov: this.perspective.fov, zoom: this.orthographic.zoom,
        orthographic_height: this.orthographic.userData.height ?? 2,
      },
      strokes: this.state.strokes,
      annotations: this.annotations,
      section: this.state.section ?? null,
    };
  }

  private captureCameraPose(): { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } {
    const position = this.camera.position.clone();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    // Reconstructing this from scene depth preserves the image but changes the
    // orbit center. Keep the actual pivot for safety corrections and saved views.
    const target = this.controls._gizmos.position.clone();
    return { position, target, up };
  }

  private cancelFit(): void {
    if (this.fitAnimation !== undefined) cancelAnimationFrame(this.fitAnimation);
    this.fitAnimation = undefined;
  }

  private fitBox(box: THREE.Box3, animate: boolean): void {
    // Every fit resets framing, including double-tap and component/group focus.
    // Keep the actual camera basis (including roll), independent of old zoom.
    this.cancelFit(); this.onViewChangeStart?.();
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const direction = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const aspect = Math.max(this.root.clientWidth / Math.max(this.root.clientHeight, 1), 0.1);
    const fov = shader.camera.fov_degrees;
    const verticalFov = THREE.MathUtils.degToRad(fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const distance = Math.max(size.length() * 0.5 / Math.sin(Math.min(verticalFov, horizontalFov) / 2), 0.001) * shader.camera.fit_padding;
    const projectedSpan = (axis: THREE.Vector3) => Math.abs(axis.x)*size.x + Math.abs(axis.y)*size.y + Math.abs(axis.z)*size.z;
    const height = Math.max(projectedSpan(up), projectedSpan(right) / aspect, 0.001) * shader.camera.fit_padding;
    const destination = center.clone().addScaledVector(direction, distance);
    const startPosition = this.camera.position.clone(), startTarget = this.captureCameraPose().target;
    const startHeight = (this.orthographic.userData.height ?? height) / this.orthographic.zoom;
    const startFov = this.perspective.fov;
    this.orthographic.zoom = 1; this.perspective.zoom = 1;
    this.camera.up.copy(up);
    const apply = (t: number) => {
      this.camera.position.lerpVectors(startPosition, destination, t);
      this.controls.target.lerpVectors(startTarget, center, t);
      this.orthographic.userData.height = THREE.MathUtils.lerp(startHeight, height, t);
      this.perspective.fov = THREE.MathUtils.lerp(startFov, fov, t);
      this.resize(); this.syncCamera();
    };
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const start = performance.now();
      apply(0);
      const tick = (now: number) => {
        const t = Math.min((now - start) / 260, 1);
        apply(1 - Math.pow(1 - t, 4));
        this.fitAnimation = t < 1 ? requestAnimationFrame(tick) : undefined;
      };
      this.fitAnimation = requestAnimationFrame(tick);
    } else apply(1);
  }

  // A pan changes Arcball's internal pivot without changing controls.target.
  // Preserve that framing when bounds change or before a new gesture starts.
  private prepareOrbit(): void {
    if (!(this.camera instanceof THREE.OrthographicCamera)) return;
    const pose = this.captureCameraPose();
    if (this.ensureOrbitDistance(pose.target)) {
      this.controls.target.copy(pose.target); this.camera.up.copy(pose.up);
      this.syncCamera();
    }
  }

  // Move the orthographic eye before a gesture or when framing/bounds change,
  // never during a drag: resetting Arcball there replaces its baseline but retains the cursor
  // origin, applying the accumulated rotation again on the next pointer move.
  private ensureOrbitDistance(target: THREE.Vector3): boolean {
    if (!(this.camera instanceof THREE.OrthographicCamera) || this.visibleBounds.isEmpty()) return false;
    const center = this.visibleBounds.getCenter(new THREE.Vector3());
    const radius = Math.max(this.visibleBounds.getSize(new THREE.Vector3()).length() * 0.5, 1e-6);
    const offset = this.camera.position.clone().sub(target);
    const distance = offset.length();
    const safeDistance = center.distanceTo(target) + radius * (1 + shader.camera.clip_padding_factor);
    if (distance >= safeDistance) return false;
    if (distance < 1e-9) offset.set(0, 0, 1);
    this.camera.position.copy(target).addScaledVector(offset.normalize(), safeDistance);
    return true;
  }

  // Cross-renderer contract with clip_planes in src/render.rs; change both in lockstep.
  private updateClipping(): void {
    const box = this.visibleBounds;
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const radius = Math.max(half.length(), 1e-6);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    // Corner depths span the center depth by the summed per-axis projections.
    const span = Math.abs(half.x * forward.x) + Math.abs(half.y * forward.y) + Math.abs(half.z * forward.z);
    const centerDepth = center.sub(this.camera.position).dot(forward);
    const padding = Math.max(radius * shader.camera.clip_padding_factor, 1e-6);
    const near = Math.max(radius * shader.camera.near_floor_factor, centerDepth - span - padding);
    // far must clear near by a full slack window even when the near floor wins.
    const far = Math.max(near + padding * 2, centerDepth + span + padding);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  private syncCamera(): void {
    this.ensureOrbitDistance(this.controls.target);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld();
    this.updateClipping();
    this.controls.setCamera(this.camera);
    // setCamera calculates its radius before moving the gizmo to the new
    // target. Refresh via the public API so the first drag matches later zooms.
    this.controls.update();
    this.invalidate();
  }

  // Refresh the cached joint bounds; only visibility and model changes alter them.
  private refreshVisibleBounds(): void {
    this.visibleBounds.copy(this.componentBounds);
    for (const model of this.models) if (model.info.visible) this.visibleBounds.union(model.bounds);
  }
  private resizeHelpers(): void {
    const box = this.visibleBounds; if (box.isEmpty()) return; const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
    this.axes.scale.setScalar(size * 0.09); this.axes.position.copy(box.min);
    this.invalidate();
  }
  private pointerDown = (event: PointerEvent): void => { this.pointerStart = { x: event.clientX, y: event.clientY }; };
  private pointerUp = (event: PointerEvent): void => {
    if (!this.interactionEnabled || !this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (this.labels.focusAt(event.clientX, event.clientY, () => {
      // Picking triangles cannot distinguish a wireframe hole from a surface.
      // Read one freshly rendered pixel only when a group label was hit.
      this.renderer.render(this.scene, this.camera);
      const gl = this.renderer.getContext();
      const pixel = new Uint8Array(4);
      const x = Math.floor((event.clientX - rect.left) * gl.drawingBufferWidth / rect.width);
      const y = gl.drawingBufferHeight - 1 - Math.floor((event.clientY - rect.top) * gl.drawingBufferHeight / rect.height);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return pixel[3] > 0;
    })) return;
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.models.filter(model => model.info.visible && model.info.opacity > 0).map(model => model.object), true)[0];
    const index = hit?.object.userData.modelIndex as number | undefined;
    if (index === undefined) return;
    const now = performance.now(); if (this.lastTap.index === index && now - this.lastTap.time < 320) this.focusSelected();
    this.lastTap = { index, time: now }; this.select(index);
  };
  private disposeModels(): void { for (const model of this.models) { this.scene.remove(model.object); disposeObject(model.object); } this.models = []; }
  private animate = (): void => {
    this.frameRequested = false;
    if (!this.dirty) return;
    this.dirty = false;
    const width = Math.max(this.root.clientWidth, 1); const height = Math.max(this.root.clientHeight, 1);
    this.renderer.getSize(this.rendererSize);
    // Resizing clears the drawing buffer, even at the same size. Do it only
    // when needed, immediately before rendering, never in ResizeObserver.
    if (this.rendererSize.x !== width || this.rendererSize.y !== height) this.renderer.setSize(width, height, false);
    this.surfaceInk.update(this.annotations, this.camera, width, height, index => !!this.models[index]?.info.visible && this.models[index].info.opacity > 0, (point, index) => this.surfacePointVisible(point, index), this.annotationSelection, this.annotationPreview);
    for (const render of this.renderListeners) render();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.models, this.labelGroups, this.camera, this.selected);
    this.onRender?.();
  };
}

function meshUrl(info: PublicMesh, quality: MeshQuality): string {
  if (quality !== 'lod') return info.source_url;
  const [path, query] = info.source_url.split('?', 2);
  return `${path}/lod${query ? `?${query}` : ''}`;
}

async function loadObject(info: PublicMesh, quality: MeshQuality): Promise<LoadedObject> {
  const response = await fetch(meshUrl(info, quality), { cache: 'no-store' }); if (!response.ok) throw await apiError(response);
  const buffer = await response.arrayBuffer();
  // The server owns the container decision — LOD and PTS raw ship as binary
  // PLY — so pick the loader from the response content type instead of
  // mirroring those rules here.
  const type = response.headers.get('content-type')?.split(';')[0];
  let object: THREE.Object3D;
  if (type === 'model/stl') object = new THREE.Mesh(new STLLoader().parse(buffer));
  else if (type === 'model/obj') object = new OBJLoader().parse(new TextDecoder().decode(buffer));
  else {
    const geometry = new PLYLoader().parse(buffer);
    object = geometry.index?.count ? new THREE.Mesh(geometry) : new THREE.Points(geometry);
  }
  return {
    object,
    payloadBytes: buffer.byteLength,
    rawBytes: quality === 'lod' ? numberHeader(response, 'x-blind-raw-bytes') : buffer.byteLength,
  };
}

function numberHeader(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!isDrawable(child)) return;
    disposeBoundsTree.call(child.geometry);
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

type Drawable = THREE.Mesh | THREE.Points;

function isDrawable(child: THREE.Object3D): child is Drawable {
  return child instanceof THREE.Mesh || child instanceof THREE.Points;
}

function settledLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function normalizeGeometry(geometry: THREE.BufferGeometry): void {
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if (!(attribute instanceof THREE.BufferAttribute)) continue;
    if (attribute.array instanceof Float64Array) {
      geometry.setAttribute(
        name,
        new THREE.BufferAttribute(
          new Float32Array(attribute.array),
          attribute.itemSize,
          attribute.normalized,
        ),
      );
    }
  }
}

function setHelperOpacity(helper: THREE.LineSegments, opacity: number): void {
  const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
  materials.forEach((material) => { material.transparent = true; material.opacity = opacity; });
}
