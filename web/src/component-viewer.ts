import * as THREE from 'three';
import { packGroups } from './component-layout';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import type { PublicScene, Vec3 } from './api';
import { MeshViewer } from './viewer';
import { ComponentRegistry, componentGroups, componentUpdate, effectiveVisibility, sceneComponents, type ComponentCapabilities, type ComponentRuntime, type Presentation, type SceneComponent } from './scene-components';
import { textContent, pluginContent, htmlContent, imageContent, type ContentFactory } from './component-content';
import './components.css';

interface Context { viewer: MeshViewer; host: ComponentViewer; scene: PublicScene }
interface Entry { spec: SceneComponent; runtime: ComponentRuntime; capabilities: ComponentCapabilities }
const sceneInput = {spatial: 'scene', focus: 'scene', fullscreen: 'scene'} as const;
const contentInput = {spatial: 'scene', focus: 'content', fullscreen: 'content'} as const;
export function builtInComponents(): ComponentRegistry<Context> {
  const registry = new ComponentRegistry<Context>();
  for (const type of ['mesh', 'points']) registry.register({type,
    capabilities: {presentations: ['spatial', 'focus', 'fullscreen'], movable: false, resizable: false, input: sceneInput},
    create(spec, {viewer}) {
      const index = spec.source.index;
      return {
        get bounds() { return viewer.meshBounds(index); },
        setPosition: p => viewer.setMeshPosition(index, p),
        setVisible: v => viewer.setVisible(index, v),
        setOpacity: v => viewer.setMeshOpacity(index, v),
        setPresentation: () => {}, select: () => viewer.select(index),
        focus: () => viewer.focusLabelGroup([index], false), dispose: () => {},
      };
    },
  });
  for (const [type, content] of Object.entries({text: textContent, html: htmlContent, image: imageContent})) {
    registry.register({type, capabilities: {presentations: ['spatial', 'focus', 'fullscreen'], movable: false, resizable: true, input: contentInput},
      create: (spec, context) => new SurfaceRuntime(spec, context, content)});
  }
  return registry;
}

export class ComponentViewer {
  readonly layer = new THREE.Scene();
  private readonly compositor = document.createElement('div');
  private readonly planes = new Map<number, {scene: THREE.Scene; renderer: CSS3DRenderer}>();
  private readonly bands: HTMLCanvasElement[] = [];
  private readonly entries: Entry[] = [];
  private readonly tree = document.createElement('aside');
  private treeResize?: ResizeObserver;
  private readonly rows = new Map<string, {button: HTMLButtonElement; check: HTMLInputElement}>();
  private readonly toggle = document.createElement('button');
  private readonly dialog = document.createElement('dialog');
  private readonly expandedContent = document.createElement('div');
  private readonly dialogTitle = document.createElement('h2');
  private readonly groupLabels = document.createElement('div');
  private readonly captions: {element: HTMLElement; entries: Entry[]}[] = [];
  private readonly viewport = matchMedia('(min-width: 1100px) and (min-height: 600px)');
  private expanded?: Entry;
  private returnFocus?: HTMLElement;
  private selected?: Entry;
  private opened = this.viewport.matches;
  private syncing = false;
  onSelect?: (component: SceneComponent) => void;
  onChange?: () => void;
  get selectedComponent(): SceneComponent | undefined { return this.selected?.spec; }
  get components(): readonly SceneComponent[] { return this.entries.map(e => e.spec); }
  selectById(id: string): void { const entry = this.entries.find(e => e.spec.id === id); if (entry) this.select(entry.spec); }
  setSelectedOpacity(opacity: number): void {
    if (!this.selected) return;
    this.applyStyle(this.selected, opacity > 0, opacity);
  }
  setSelectedVisible(visible: boolean): void { if (this.selected) this.setVisible(this.selected, visible); }
  private applyStyle(entry: Entry, visible: boolean, opacity: number): void {
    this.syncing = true;
    entry.spec.visible = visible; entry.spec.opacity = opacity;
    entry.runtime.setOpacity(opacity); entry.runtime.setVisible(visible && opacity > 0);
    this.syncing = false; this.sync(); this.onChange?.();
  }

  constructor(readonly root: HTMLElement, private readonly viewer: MeshViewer, readonly scene: PublicScene, registry = builtInComponents()) {
    this.compositor.className = 'component-compositor'; root.append(this.compositor);
    this.groupLabels.className = 'component-group-labels'; root.append(this.groupLabels);
    const customTypes = new Set<string>();
    for (const spec of sceneComponents(scene)) {
      if (spec.renderer && !customTypes.has(spec.component)) {
        registry.register({type:spec.component,capabilities:{...spec.renderer.capabilities,movable:false,input:contentInput},create:(spec,context)=>new SurfaceRuntime(spec,context,pluginContent)});
        customTypes.add(spec.component);
      }
      const definition = registry.get(spec.component);
      this.entries.push({spec, capabilities: definition.capabilities, runtime: definition.create(spec, {viewer, host: this, scene})});
    }
    if (this.entries.some(e => e.runtime.element)) {
      root.classList.add('has-spatial-content');
      root.addEventListener('pointerdown', this.routePointer, true);
      root.addEventListener('click', this.routeClick, true);
      root.addEventListener('wheel', this.routeWheel, {capture: true, passive: false});
    }
    this.layout(); this.buildTree(); this.buildDialog(); this.sync();
    viewer.renderListeners.add(this.render); this.viewport.addEventListener('change', this.viewportChanged);
    viewer.componentUpdates = () => scene.components?.length ? this.entries.map(e => componentUpdate(e.spec)) : undefined;
    this.refreshBounds();
    if (!scene.state.camera && scene.components?.length) { viewer.setCanonicalView('pz'); viewer.fitAll(false); }
    if (this.entries[0]) this.select(this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === viewer.selectedIndex)?.spec ?? this.entries[0].spec, false);
    this.render();
  }
  async ready(): Promise<void> { await Promise.all(this.entries.filter(e => effectiveVisibility(e.spec)).map(e => e.runtime.ready)); this.render(); }
  // Geometry bands do not intercept DOM events. Route their covered pixels
  // to geometry, while exposed content controls remain interactive.
  private occluded(event: MouseEvent): boolean {
    const element = event.target instanceof Element ? event.target.closest('.scene-surface') : null;
    const entry = this.entries.find(e => e.runtime.element === element);
    return entry?.runtime instanceof SurfaceRuntime && entry.runtime.occludedAt(event.clientX, event.clientY);
  }
  private routePointer = (event: PointerEvent): void => {
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigatePointer(event);
      // Picking listens for pointerup on the canvas. Keep the native gesture
      // there after redirecting its start, even though DOM content receives hits.
      this.root.querySelector('canvas')?.setPointerCapture(event.pointerId);
    }
  };
  private routeClick = (event: MouseEvent): void => {
    if (this.occluded(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private routeWheel = (event: WheelEvent): void => {
    if (event.target === this.root || this.occluded(event)) {
      event.preventDefault(); event.stopImmediatePropagation(); this.viewer.navigateWheel(event);
    }
  };
  private layout(): void {
    // Explicit positions are absolute world coordinates. Only unpositioned components are tiled.
    const originals = new Map(sceneComponents(this.scene).map(c => [c.id, c]));
    const groups = [...componentGroups(this.entries.map(e => e.spec)).entries()];
    const plans = groups.map(([label, specs]) => {
      const entries = specs.map(s => this.entries.find(e => e.spec === s)!);
      const geometry = entries.filter(e => !e.runtime.element);
      const geometryBounds = new THREE.Box3(); geometry.forEach(e => geometryBounds.union(e.runtime.bounds));
      const center = geometryBounds.getCenter(new THREE.Vector3());
      const size = geometryBounds.getSize(new THREE.Vector3());
      const automaticGeometry = geometry.filter(e => !e.spec.position);
      automaticGeometry.forEach(e => this.position(e, new THREE.Vector3().fromArray(this.viewer.modelInfos[e.spec.source.index].translation ?? [0, 0, 0]).sub(center).toArray() as Vec3));
      let x = geometry.length ? Math.max(size.x / 2, 30) + 18 : 0;
      for (const entry of entries.filter(e => e.runtime.element && !e.spec.position)) {
        const [w] = entry.spec.size ?? [110, 70];
        this.position(entry, [x + w / 2, 0, 0]); x += w + 14;
      }
      const bounds = new THREE.Box3(); entries.forEach(e => bounds.union(e.runtime.bounds));
      return {label, entries, bounds};
    });
    const packed = packGroups(plans.map(p => {const size = p.bounds.getSize(new THREE.Vector3());return [size.x,size.y] as const;}),this.root.clientWidth / Math.max(1,this.root.clientHeight));
    plans.forEach((plan, index) => {
      const center = plan.bounds.getCenter(new THREE.Vector3());
      const offset = new THREE.Vector3(...packed[index],0).sub(center);
      for (const entry of plan.entries) {
        const original = originals.get(entry.spec.id)!;
        if (!original.position) this.position(entry, new THREE.Vector3().fromArray(entry.spec.position ?? [0, 0, 0]).add(offset).toArray() as Vec3);
      }
      if (plan.label) {
        const caption = document.createElement('span'); caption.textContent = plan.label; this.groupLabels.append(caption);
        this.captions.push({element: caption, entries: plan.entries});
      }
    });
  }
  private position(entry: Entry, position: Vec3): void { entry.spec.position = position; entry.runtime.setPosition(position); }
  refreshBounds(): void {
    const box = new THREE.Box3();
    this.entries.filter(e => e.runtime.element && effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
    this.viewer.setComponentBounds(box);
  }
  select(spec: SceneComponent, notify = true): void {
    const entry = this.entries.find(e => e.spec === spec); if (!entry) return;
    this.selected = entry;
    if (notify) { entry.runtime.select(); this.onSelect?.(spec); }
    for (const e of this.entries) { const selected = e === entry; this.rows.get(e.spec.id)?.button.setAttribute('aria-pressed', String(selected)); e.runtime.element?.classList.toggle('selected', selected); }
  }
  selectMesh(index: number): void { const entry = this.entries.find(e => e.spec.source.kind === 'mesh' && e.spec.source.index === index); if (entry) this.select(entry.spec, false); }
  sync(): void {
    if (this.syncing) return; this.syncing = true;
    for (const entry of this.entries) {
      const {spec, runtime} = entry;
      if (spec.source.kind === 'mesh') {
        const info = this.viewer.modelInfos[spec.source.index]; if (info) { spec.visible = info.visible; spec.opacity = info.opacity; spec.label = info.label?.text ?? info.name; }
      }
      runtime.setVisible(effectiveVisibility(spec));
      const row = this.rows.get(spec.id);
      if (row) { row.check.checked = effectiveVisibility(spec); row.button.textContent = spec.label; row.button.style.setProperty('--element-opacity', String(effectiveVisibility(spec) ? Math.max(.45, spec.opacity) : .35)); }
    }
    this.syncing = false; this.refreshBounds();
  }
  private setVisible(entry: Entry, visible: boolean): void {
    this.applyStyle(entry, visible, visible && entry.spec.opacity === 0 ? 1 : entry.spec.opacity);
  }
  private setVisibility(visible: (entry: Entry) => boolean): void {
    this.syncing = true;
    try {
      for (const entry of this.entries) {
        entry.spec.visible = visible(entry);
        if (entry.spec.visible && entry.spec.opacity === 0) {
          entry.spec.opacity = 1;
          entry.runtime.setOpacity(1);
        }
        entry.runtime.setVisible(effectiveVisibility(entry.spec));
      }
    } finally { this.syncing = false; }
    this.sync(); this.onChange?.();
  }

  present(spec: SceneComponent, mode: Presentation): void {
    const entry = this.entries.find(e => e.spec === spec); if (!entry || !entry.capabilities.presentations.includes(mode)) return;
    this.select(spec);
    if (!entry.runtime.element) {
      entry.runtime.focus();
      if (mode === 'fullscreen') void this.root.parentElement?.requestFullscreen?.().catch(() => {});
      return;
    }
    if (this.expanded && this.expanded !== entry) this.close();
    if (!this.expanded) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.expanded = entry; this.dialogTitle.textContent = spec.label;
      moveElement(this.expandedContent, entry.runtime.element);
      this.viewer.setInteractionEnabled(false); this.dialog.showModal();
    }
    entry.runtime.setPresentation(mode);
    if (mode === 'fullscreen' && this.dialog.requestFullscreen) void this.dialog.requestFullscreen().catch(() => { entry.runtime.setPresentation('focus'); });
  }
  private close = (): void => {
    if (!this.expanded) return;
    const entry = this.expanded; this.expanded = undefined;
    if (document.fullscreenElement === this.dialog) void document.exitFullscreen();
    entry.runtime.setPresentation('spatial'); this.dialog.close(); this.viewer.setInteractionEnabled(true);
    this.returnFocus?.focus({preventScroll: true}); this.viewer.invalidate();
  };
  private buildDialog(): void {
    this.dialog.className = 'component-dialog'; this.dialog.setAttribute('aria-labelledby', 'component-dialog-title');
    this.dialogTitle.id = 'component-dialog-title'; const heading = document.createElement('header');
    const fullscreen = button('全屏', () => { if (this.expanded) this.present(this.expanded.spec, 'fullscreen'); });
    const close = button('返回场景', this.close); heading.append(this.dialogTitle, fullscreen, close);
    this.expandedContent.className = 'component-expanded-content'; this.dialog.append(heading, this.expandedContent);
    document.querySelector('#app-shell')!.append(this.dialog);
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.close(); });
    this.dialog.addEventListener('close', this.close);
  }
  private buildTree(): void {
    this.tree.className = 'scene-tree'; this.tree.id = 'scene-tree'; this.tree.setAttribute('aria-label', '场景元素'); this.tree.dataset.labelObstacle = '';
    const heading = document.createElement('header'); const title = document.createElement('h2'); title.textContent = '场景';
    const close = button('收起', () => this.setOpen(false)); heading.append(title, close); this.tree.append(heading);
    const actions = document.createElement('div'); actions.className = 'scene-tree-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '场景显示');
    actions.append(button('全部显示', () => this.setVisibility(() => true)), button('全部隐藏', () => this.setVisibility(() => false))); this.tree.append(actions);
    const list = document.createElement('div'); list.className = 'scene-tree-list'; list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', '场景元素列表'); this.tree.append(list);
    const content = document.createElement('div'); list.append(content);
    const updateEdges = () => {
      list.style.setProperty('--scroll-fade-top', `${Math.min(16, Math.max(0, list.scrollTop))}px`);
      list.style.setProperty('--scroll-fade-bottom', `${Math.min(16, Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop))}px`);
    };
    list.addEventListener('scroll', updateEdges, {passive: true});
    this.treeResize = new ResizeObserver(updateEdges); this.treeResize.observe(list); this.treeResize.observe(content);
    for (const [group, specs] of componentGroups(this.entries.map(e => e.spec))) {
      if (group) { const label = document.createElement('h3'); label.textContent = group; content.append(label); }
      for (const spec of specs) {
        const entry = this.entries.find(e => e.spec === spec)!;
        const row = document.createElement('div'); row.className = 'scene-tree-row';
        const select = button(spec.label, () => this.select(spec)); select.setAttribute('aria-pressed', 'false'); select.title = `${spec.label} · 双击仅显示此元素`;
        select.addEventListener('dblclick', () => { this.setVisibility(candidate => candidate === entry); entry.runtime.focus(); });
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = effectiveVisibility(spec); check.setAttribute('aria-label', `显示 ${spec.label}`);
        check.addEventListener('change', () => this.setVisible(entry, check.checked)); row.append(select, check); content.append(row); this.rows.set(spec.id, {button: select, check});
      }
    }
    this.toggle.className = 'icon-button'; this.toggle.type = 'button'; this.toggle.id = 'scene-tree-toggle'; this.toggle.setAttribute('aria-label', '场景元素'); this.toggle.setAttribute('aria-controls', this.tree.id);
    this.toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M8 12h12M8 19h12M4 5v14h1"/></svg>';
    this.toggle.onclick = () => this.setOpen(!this.opened);
    document.querySelector('.top-actions')!.prepend(this.toggle); document.querySelector('#scene-panels')!.prepend(this.tree); this.setOpen(this.opened);
    this.tree.addEventListener('keydown', event => { if (event.key === 'Escape') this.setOpen(false); });
  }
  private setOpen(open: boolean): void { this.opened = open; this.tree.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open)); document.querySelector('#app-shell')!.classList.toggle('tree-open', open); if (!open && this.tree.contains(document.activeElement)) this.toggle.focus(); }
  private viewportChanged = (): void => this.setOpen(this.viewport.matches);
  private renderLayers(): void {
    const runtimes = this.entries.flatMap(entry => entry.runtime instanceof SurfaceRuntime ? [entry.runtime] : []);
    const objects = runtimes.map(runtime => runtime.object);
    const surfaces = runtimes.flatMap(runtime => runtime.spatialObject ? [runtime.spatialObject] : []);
    const allDepths = [...new Set(objects.map(object => object.position.z))];
    const depths = [...new Set(surfaces.map(object => object.position.z))].sort((a,b) => a-b);
    this.root.classList.toggle('composited-content', depths.length > 0);
    this.compositor.hidden = depths.length === 0;
    for (const [z, plane] of this.planes) {
      if (allDepths.includes(z)) continue;
      for (const object of [...plane.scene.children]) this.layer.add(object);
      plane.renderer.domElement.remove(); this.planes.delete(z);
    }
    for (const z of allDepths) {
      let plane = this.planes.get(z);
      if (!plane) {
        plane = {scene: new THREE.Scene(), renderer: new CSS3DRenderer()};
        plane.renderer.domElement.className = 'component-layer';
        this.planes.set(z, plane); this.compositor.append(plane.renderer.domElement);
      }
      // Keep hidden wrappers connected so visibility toggles do not reload
      // plugin frames or discard content state.
      plane.renderer.domElement.hidden = !depths.includes(z);
      for (const object of objects.filter(object => object.position.z === z)) if (object.parent !== plane.scene) plane.scene.add(object);
      plane.renderer.setSize(this.root.clientWidth, this.root.clientHeight);
      plane.renderer.render(plane.scene, this.viewer.activeCamera);
    }
    if (!depths.length) return;
    while (this.bands.length < depths.length + 1) {
      const canvas = document.createElement('canvas'); canvas.className = 'component-geometry';
      this.bands.push(canvas); this.compositor.append(canvas);
    }
    while (this.bands.length > depths.length + 1) this.bands.pop()!.remove();
    let order = 0;
    const band = (index: number) => {
      const canvas = this.bands[index]; canvas.style.zIndex = String(order++);
      this.viewer.renderGeometryBand(canvas, depths[index-1] ?? -Infinity, depths[index] ?? Infinity);
    };
    const plane = (index: number) => { this.planes.get(depths[index])!.renderer.domElement.style.zIndex = String(order++); };
    const camera = this.viewer.activeCamera;
    if (camera instanceof THREE.OrthographicCamera) {
      if (camera.getWorldDirection(new THREE.Vector3()).z <= 0) {
        for (let i=0;i<=depths.length;i++) { band(i); if(i<depths.length) plane(i); }
      } else {
        for (let i=depths.length;i>=0;i--) { band(i); if(i>0) plane(i-1); }
      }
    } else {
      // If the eye lies between planes, rays on opposite sides never share a
      // pixel. Paint both far branches first, then the band containing the eye.
      const split = depths.findIndex(z => z > camera.position.z);
      const middle = split < 0 ? depths.length : split;
      for (let i=0;i<middle;i++) { band(i); plane(i); }
      for (let i=depths.length;i>middle;i--) { band(i); plane(i-1); }
      band(middle);
    }
  }
  private render = (): void => {
    this.renderLayers();
    for (const caption of this.captions) {
      const box = new THREE.Box3(); caption.entries.filter(e => effectiveVisibility(e.spec)).forEach(e => box.union(e.runtime.bounds));
      caption.element.hidden = box.isEmpty(); if (box.isEmpty()) continue;
      const p = new THREE.Vector3(box.min.x, box.max.y + 5, box.max.z).project(this.viewer.activeCamera);
      caption.element.hidden = p.z < -1 || p.z > 1;
      // Reserve a screen-space header above geometry assembly captions.
      caption.element.style.transform = `translate(${(p.x + 1) * this.root.clientWidth / 2}px,${(1 - p.y) * this.root.clientHeight / 2 - 32}px)`;
    }
  };
  dispose(): void { this.root.classList.remove('has-spatial-content'); this.root.removeEventListener('pointerdown', this.routePointer, true); this.root.removeEventListener('click', this.routeClick, true); this.root.removeEventListener('wheel', this.routeWheel, true); this.close(); this.treeResize?.disconnect(); this.entries.forEach(e => e.runtime.dispose()); this.viewer.renderListeners.delete(this.render); this.viewport.removeEventListener('change', this.viewportChanged); this.viewer.componentUpdates = undefined; this.root.classList.remove('composited-content'); this.compositor.remove(); this.planes.clear(); this.bands.length = 0; this.groupLabels.remove(); this.tree.remove(); this.toggle.remove(); this.dialog.remove(); }
}

class SurfaceRuntime implements ComponentRuntime {
  readonly element = document.createElement('section');
  private readonly wrapper = document.createElement('div');
  readonly object = new CSS3DObject(this.wrapper);
  get spatialObject(): CSS3DObject | undefined { return this.mode === 'spatial' && this.object.visible ? this.object : undefined; }
  private readonly content;
  private mode: Presentation = 'spatial';
  constructor(private readonly spec: SceneComponent, private readonly context: Context, factory: ContentFactory) {
    const {host, scene} = context; this.element.className = 'scene-surface'; this.element.dataset.component = spec.component;
    const header = document.createElement('header'); header.className = 'component-handle'; header.title = spec.label;
    const label = document.createElement('span'); label.textContent = spec.label;
    const capabilities = spec.renderer?.capabilities;
    header.append(label);
    if (!capabilities || capabilities.presentations.includes('focus')) header.append(button('展开', () => host.present(spec, 'focus')));
    if (!capabilities || capabilities.presentations.includes('fullscreen')) header.append(button('全屏', () => host.present(spec, 'fullscreen')));
    const source = scene.attachments?.[spec.source.index];
    this.content = source?.url ? factory(source.url, spec.label, spec) : {element: document.createElement('p'), ready: Promise.reject(new Error('资源不可用')), dispose() {}};
    void this.content.ready.catch(() => {});
    if (!source?.url) this.content.element.textContent = source?.unavailable ?? '资源不可用';
    const body = document.createElement('div'); body.className = 'component-body'; body.append(this.content.element);
    const enter = button(`打开 ${spec.label}`, () => host.present(spec, 'focus')); enter.className = 'component-enter'; enter.setAttribute('aria-label', `展开 ${spec.label}`); enter.textContent = ''; body.append(enter);
    // The same orbit/pan/zoom gestures work over content previews. Only a tap opens content.
    let navigating = false;
    let gesture: AbortController | undefined;
    enter.onclick = event => { if (event.detail === 0 || !navigating) host.present(spec, 'focus'); };
    enter.addEventListener('pointerdown', event => {
      if (event.isPrimary) {
        gesture?.abort(); gesture = new AbortController(); navigating = false;
        const x = event.clientX, y = event.clientY;
        window.addEventListener('pointermove', move => { if (Math.hypot(move.clientX - x, move.clientY - y) > 6) navigating = true; }, {signal: gesture.signal});
        window.addEventListener('pointerup', () => gesture?.abort(), {once: true, signal: gesture.signal});
        window.addEventListener('pointercancel', () => { navigating = true; gesture?.abort(); }, {once: true, signal: gesture.signal});
      } else navigating = true;
      host.select(spec); context.viewer.navigatePointer(event);
    });
    enter.addEventListener('wheel', event => { event.preventDefault(); context.viewer.navigateWheel(event); }, {passive: false});
    this.content.element.inert = true;
    this.element.append(header, body); this.wrapper.append(this.element); host.layer.add(this.object);
    this.setPosition(spec.position ?? [0, 0, 0]); this.setOpacity(spec.opacity); this.size();
    header.addEventListener('pointerdown', event => {
      if (!(event.target as Element).closest('button')) context.viewer.navigatePointer(event);
    });
    header.addEventListener('wheel', event => {event.preventDefault(); context.viewer.navigateWheel(event);}, {passive: false});
    const resize = button('调整大小', () => {}); resize.className = 'component-resize'; resize.setAttribute('aria-label', '调整宽度，方向键或拖动');
    resize.addEventListener('pointerdown', event => this.resize(event));
    resize.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); const factor = ['ArrowRight','ArrowUp'].includes(event.key) ? 1.1 : 1 / 1.1; this.resizeBy(factor); });
    if (!capabilities || capabilities.resizable) this.element.append(resize);
  }
  get ready(): Promise<void> { return this.content.ready; }
  get bounds(): THREE.Box3 {
    const [w, h] = this.spec.size ?? [110,70]; const p = this.object.position;
    return new THREE.Box3(new THREE.Vector3(p.x - w / 2, p.y - h / 2, p.z - .1), new THREE.Vector3(p.x + w / 2, p.y + h / 2, p.z + .1));
  }
  setPosition(position: Vec3): void { this.object.position.fromArray(position); }
  setVisible(visible: boolean): void { this.object.visible = visible; }
  setOpacity(opacity: number): void { this.element.style.opacity = String(opacity); }
  occludedAt(x: number, y: number): boolean {
    if (this.mode !== 'spatial') return false;
    const rect = this.context.host.root.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1, 1-(y-rect.top)/rect.height*2), this.context.viewer.activeCamera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1), -this.object.position.z), new THREE.Vector3());
    return !!point && this.context.viewer.geometryOccludes(x, y, point.toArray() as Vec3);
  }
  select(): void { this.element.classList.add('selected'); }
  focus(): void { this.context.viewer.focusBounds(this.bounds); }
  setPresentation(mode: Presentation): void {
    this.mode = mode; this.context.viewer.invalidate(); this.element.classList.toggle('expanded', mode !== 'spatial');
    this.content.element.inert = mode === 'spatial';
    if (mode === 'spatial') moveElement(this.wrapper, this.element);
    this.content.present?.(mode);
  }
  private size(): void { const [w,h] = this.spec.size ?? [110,70]; this.wrapper.style.width = '800px'; this.wrapper.style.height = `${800 * h / w}px`; this.object.scale.setScalar(w / 800); this.context.viewer.invalidate(); }
  private resizeBy(factor: number): void { const [w,h] = this.spec.size ?? [110,70]; const width = Math.max(20, Math.min(500, w * factor)); this.spec.size = [width, h / w * width]; this.size(); this.context.host.refreshBounds(); }
  private resize(event: PointerEvent): void {
    if (this.mode !== 'spatial') return; event.preventDefault(); this.context.viewer.setInteractionEnabled(false);
    const target = event.currentTarget as HTMLElement; target.setPointerCapture(event.pointerId); let x = event.clientX;
    const move = (e: PointerEvent) => { this.resizeBy(Math.exp((e.clientX - x) / 250)); x = e.clientX; };
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); target.removeEventListener('lostpointercapture', end); this.context.viewer.setInteractionEnabled(true); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end); target.addEventListener('lostpointercapture', end);
  }
  dispose(): void { this.content.dispose(); this.object.removeFromParent(); this.wrapper.remove(); this.element.remove(); }
}
function button(text: string, action: () => void): HTMLButtonElement { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = action; return button; }
function moveElement(parent: HTMLElement, element: HTMLElement): void {
  // Preserve iframe browsing context on browsers supporting state-preserving moves.
  const movable = parent as HTMLElement & {moveBefore?: (node: Node, child: Node | null) => void};
  if (movable.moveBefore && parent.isConnected && element.isConnected) movable.moveBefore(element, null); else parent.append(element);
}
