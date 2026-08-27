import * as THREE from 'three';
import { ArcballControls } from 'three/addons/controls/ArcballControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { apiError } from './api';
import type { PublicMesh, PublicScene, SceneUpdate, ViewState } from './api';
import { createMatteMaterial, updateMatteMaterial } from './material';

const DARK_BACKGROUND = '#292c32';
const LIGHT_BACKGROUND = '#e7e9ec';

interface Model {
  info: PublicMesh;
  object: THREE.Object3D;
}

export class MeshViewer {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly perspective = new THREE.PerspectiveCamera(34, 1, 0.001, 1_000_000);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1_000_000);
  private readonly controls: ArcballControls & { target: THREE.Vector3 };
  private readonly axes = new THREE.AxesHelper(1);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly resizeObserver: ResizeObserver;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private models: Model[] = [];
  private state!: ViewState;
  private selected = 0;
  private dirty = true;
  private pointerStart: { x: number; y: number } | null = null;
  private lastTap = { index: -1, time: 0 };
  onSelectionChange?: (index: number) => void;

  constructor(private readonly root: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.root.append(this.renderer.domElement);
    this.camera = this.perspective;
    this.controls = new ArcballControls(
      this.camera,
      this.renderer.domElement,
      this.scene,
    ) as ArcballControls & { target: THREE.Vector3 };
    this.controls.enableAnimations = false;
    this.controls.enableFocus = false;
    this.controls.enableGrid = false;
    this.controls.adjustNearFar = false;
    this.controls.setGizmosVisible(false);
    this.controls.minDistance = 0.0001;
    this.controls.maxDistance = 1_000_000;
    setHelperOpacity(this.axes, 0.78);
    this.scene.add(this.axes);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.controls.addEventListener('change', () => { this.updateClipping(); this.dirty = true; });
    this.animate();
  }

  async load(scene: PublicScene): Promise<void> {
    this.disposeModels();
    this.state = structuredClone(scene.state);
    this.selected = Math.min(scene.state.selected, Math.max(scene.meshes.length - 1, 0));
    const objects = await Promise.all(scene.meshes.map(loadObject));
    objects.forEach((object, index) => {
      const info = scene.meshes[index];
      object.userData.modelIndex = index;
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.userData.modelIndex = index;
        const geometry = child.geometry as THREE.BufferGeometry;
        normalizeGeometry(geometry);
        // Review the geometry itself rather than trusting optional exporter normals,
        // which are frequently quantized or face-split in scan files.
        geometry.deleteAttribute('normal');
        geometry.computeVertexNormals();
        child.material = createMatteMaterial({
          color: info.color,
          opacity: info.opacity,
          flat: scene.state.shading === 'flat',
          wireframe: scene.state.shading === 'wire',
          layer: index,
        });
      });
      this.models.push({ info: { ...info }, object });
      this.scene.add(object);
    });
    this.applyState();
    this.resize();
    await settledLayout();
    if (scene.state.camera) this.restoreCamera(scene.state);
    else this.fitAll(true);
    this.resizeHelpers();
  }

  get modelCount(): number { return this.models.length; }
  get selectedIndex(): number { return this.selected; }
  get selectedModel(): PublicMesh | undefined { return this.models[this.selected]?.info; }
  get modelInfos(): PublicMesh[] { return this.models.map((model) => model.info); }
  get currentState(): ViewState { return this.exportState(); }

  select(index: number): void {
    if (!this.models[index]) return;
    this.selected = index;
    this.applyMaterials();
    this.onSelectionChange?.(index);
  }

  setVisible(index: number, visible: boolean): void {
    const model = this.models[index];
    if (!model) return;
    model.info.visible = visible;
    model.object.visible = visible;
    this.resizeHelpers();
    this.updateClipping();
    this.dirty = true;
  }

  setColor(color: string): void { const model = this.models[this.selected]; if (model) { model.info.color = color; this.applyMaterials(); } }
  setOpacity(opacity: number): void { const model = this.models[this.selected]; if (model) { model.info.opacity = opacity; this.applyMaterials(); } }
  setShading(shading: ViewState['shading']): void { this.state.shading = shading; this.applyMaterials(); }
  setAxes(visible: boolean): void { this.state.axes = visible; this.axes.visible = visible; this.dirty = true; }
  setBackground(background: ViewState['background']): void {
    this.state.background = background;
    this.scene.background = new THREE.Color(background === 'light' ? LIGHT_BACKGROUND : DARK_BACKGROUND);
    document.documentElement.dataset.theme = background;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background === 'light' ? LIGHT_BACKGROUND : DARK_BACKGROUND);
    this.dirty = true;
  }

  setProjection(projection: ViewState['projection']): void {
    if (projection === this.state.projection) return;
    const position = this.camera.position.clone();
    const target = this.controls.target.clone();
    if (projection === 'orthographic') {
      const distance = position.distanceTo(target);
      this.orthographic.position.copy(position); this.orthographic.up.copy(this.camera.up);
      this.orthographic.zoom = 1; this.orthographic.userData.height = distance * 1.05;
      this.camera = this.orthographic;
    } else {
      this.perspective.position.copy(position); this.perspective.up.copy(this.camera.up);
      this.camera = this.perspective;
    }
    this.state.projection = projection;
    this.controls.target.copy(target);
    this.resize(); this.syncCamera();
  }

  fitAll(animate = true): void {
    const box = this.visibleBounds();
    if (box.isEmpty()) return;
    this.fitBox(box, animate);
  }

  focusSelected(): void {
    const model = this.models[this.selected];
    if (!model) return;
    this.fitBox(new THREE.Box3().setFromObject(model.object), true);
  }

  setCanonicalView(code: string): void {
    const box = this.visibleBounds(); if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const distance = box.getSize(new THREE.Vector3()).length() * 1.8;
    const directions: Record<string, THREE.Vector3> = {
      px: new THREE.Vector3(1, 0, 0), nx: new THREE.Vector3(-1, 0, 0),
      py: new THREE.Vector3(0, 1, 0), ny: new THREE.Vector3(0, -1, 0),
      pz: new THREE.Vector3(0, 0, 1), nz: new THREE.Vector3(0, 0, -1),
    };
    const direction = directions[code]; if (!direction) return;
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.camera.up.set(0, 1, 0);
    if (Math.abs(direction.y) > 0.9) this.camera.up.set(0, 0, direction.y > 0 ? -1 : 1);
    this.controls.target.copy(center); this.syncCamera();
  }

  exportUpdate(): SceneUpdate {
    return {
      meshes: this.models.map(({ info }) => ({ color: info.color, opacity: info.opacity, visible: info.visible })),
      state: this.exportState(),
    };
  }

  resize(): void {
    const width = Math.max(this.root.clientWidth, 1); const height = Math.max(this.root.clientHeight, 1); const aspect = width / height;
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = aspect; this.perspective.updateProjectionMatrix();
    const orthographicHeight = this.orthographic.userData.height ?? 2;
    this.orthographic.left = -orthographicHeight * aspect / 2; this.orthographic.right = orthographicHeight * aspect / 2;
    this.orthographic.top = orthographicHeight / 2; this.orthographic.bottom = -orthographicHeight / 2; this.orthographic.updateProjectionMatrix();
    this.updateClipping();
    this.dirty = true;
  }

  private applyState(): void {
    this.state.grid = false;
    this.setBackground(this.state.background); this.axes.visible = this.state.axes;
    this.models.forEach((model) => { model.object.visible = model.info.visible; });
    if (this.state.projection === 'orthographic') { this.state.projection = 'perspective'; this.setProjection('orthographic'); }
    this.applyMaterials();
  }

  private applyMaterials(): void {
    this.models.forEach((model, index) => model.object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      updateMatteMaterial(child.material as THREE.ShaderMaterial, {
        color: model.info.color,
        opacity: model.info.opacity,
        flat: this.state.shading === 'flat',
        wireframe: this.state.shading === 'wire',
        layer: index,
      });
    }));
    this.dirty = true;
  }

  private restoreCamera(state: ViewState): void {
    const saved = state.camera; if (!saved) return;
    this.camera.position.fromArray(saved.position); this.camera.up.fromArray(saved.up); this.controls.target.fromArray(saved.target);
    this.perspective.fov = saved.fov; this.perspective.updateProjectionMatrix();
    this.orthographic.zoom = saved.zoom; this.orthographic.userData.height = saved.orthographic_height;
    this.resize(); this.syncCamera();
  }

  private exportState(): ViewState {
    return {
      selected: this.selected, shading: this.state.shading, projection: this.state.projection,
      background: this.state.background, grid: false, axes: this.axes.visible,
      frame: { width: Math.round(this.root.clientWidth), height: Math.round(this.root.clientHeight) },
      camera: {
        position: this.camera.position.toArray() as [number, number, number],
        target: this.controls.target.toArray() as [number, number, number],
        up: this.camera.up.toArray() as [number, number, number],
        fov: this.perspective.fov, zoom: this.orthographic.zoom,
        orthographic_height: this.orthographic.userData.height ?? 2,
      },
    };
  }

  private fitBox(box: THREE.Box3, animate: boolean): void {
    const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3()); const radius = size.length() * 0.5;
    const verticalFov = THREE.MathUtils.degToRad(this.perspective.fov);
    const aspect = Math.max(this.root.clientWidth / Math.max(this.root.clientHeight, 1), 0.1);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const fitFov = Math.min(verticalFov, horizontalFov);
    const distance = Math.max(radius / Math.sin(fitFov / 2), 0.001) * 1.15;
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(direction.x) || direction.lengthSq() < 1e-12) {
      direction.set(1, 0.7, 1).normalize();
    }
    const destination = center.clone().addScaledVector(direction, distance);
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const startPosition = this.camera.position.clone(); const startTarget = this.controls.target.clone(); const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / 260, 1); const eased = 1 - Math.pow(1 - t, 4);
        this.camera.position.lerpVectors(startPosition, destination, eased); this.controls.target.lerpVectors(startTarget, center, eased); this.syncCamera();
        if (t < 1) requestAnimationFrame(tick);
      }; requestAnimationFrame(tick);
    } else { this.camera.position.copy(destination); this.controls.target.copy(center); this.syncCamera(); }
    this.orthographic.userData.height = Math.max(size.y, size.x / Math.max(this.root.clientWidth / this.root.clientHeight, 0.2)) * 1.25;
    this.resize();
  }

  private updateClipping(): void {
    const box = this.visibleBounds();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1e-6);
    const distance = this.camera.position.distanceTo(center);
    const near = Math.max(radius * 1e-4, distance - radius * 4);
    const far = Math.max(near * 100, distance + radius * 4);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
  }

  private syncCamera(): void {
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld();
    this.updateClipping();
    this.controls.setCamera(this.camera);
    this.controls.setGizmosVisible(false);
    this.dirty = true;
  }

  private visibleBounds(): THREE.Box3 { const box = new THREE.Box3(); for (const model of this.models) if (model.info.visible) box.expandByObject(model.object); return box; }
  private resizeHelpers(): void {
    const box = this.visibleBounds(); if (box.isEmpty()) return; const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
    this.axes.scale.setScalar(size * 0.09); this.axes.position.copy(box.min);
    this.dirty = true;
  }
  private pointerDown = (event: PointerEvent): void => { this.pointerStart = { x: event.clientX, y: event.clientY }; };
  private pointerUp = (event: PointerEvent): void => {
    if (!this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.models.map((model) => model.object), true)[0];
    const index = hit?.object.userData.modelIndex as number | undefined; if (index === undefined) return;
    const now = performance.now(); if (this.lastTap.index === index && now - this.lastTap.time < 320) this.focusSelected();
    this.lastTap = { index, time: now }; this.select(index);
  };
  private disposeModels(): void { for (const model of this.models) { this.scene.remove(model.object); model.object.traverse((child) => { if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose(); } }); } this.models = []; }
  private animate = (): void => {
    requestAnimationFrame(this.animate);
    if (this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  };
}

async function loadObject(info: PublicMesh): Promise<THREE.Object3D> {
  const response = await fetch(info.source_url, { cache: 'no-store' }); if (!response.ok) throw await apiError(response);
  const buffer = await response.arrayBuffer();
  if (info.format === 'ply') return new THREE.Mesh(new PLYLoader().parse(buffer));
  if (info.format === 'stl') return new THREE.Mesh(new STLLoader().parse(buffer));
  return new OBJLoader().parse(new TextDecoder().decode(buffer));
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
