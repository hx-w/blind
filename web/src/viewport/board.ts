import { Box3 } from 'three';
import type { PublicScene, SceneUpdate, ScreenStroke, ViewState, BoardViewportState } from '../api';
import type { MeshLoadProgress } from '../viewer';
import { OperationError } from '../operations/core';
import shader from '../../../shaders/matte.json';

/** An affine DOM camera. Surface source dimensions are never changed by framing. */
export class BoardViewport {
  readonly kind = 'board' as const;
  readonly stage = document.createElement('div');
  private readonly background = document.createElement('div');
  readonly renderListeners = new Set<() => void>();
  entityUpdates?: () => SceneUpdate['entities'];
  onViewChangeStart?: () => void;
  onViewChangeEnd?: () => void;
  onRender?: () => void;
  onLoadProgress?: (progress: MeshLoadProgress) => void;
  onModelChange?: () => void;
  private state!: ViewState;
  private readonly bounds = new Box3();
  private centerX = 0;
  private centerY = 0;
  private cameraScale = 1;
  private reservedRight = 0;
  private interactionEnabled = true;
  private initialFrame = true;
  private readableInitialFrame = false;
  private wheelTimer = 0;
  private frame = 0;
  private animation = 0;
  private disposed = false;
  private transition: Promise<'committed' | 'interrupted'> = Promise.resolve('committed');
  private finishTransition?: (status: 'committed' | 'interrupted') => void;
  private readonly pointers: Array<{id: number; x: number; y: number}> = [];
  private readonly observer: ResizeObserver;

  constructor(readonly root: HTMLElement) {
    this.background.className = 'board-background';
    Object.assign(this.background.style, {position: 'absolute', inset: '0', touchAction: 'none'});
    this.stage.className = 'board-stage';
    Object.assign(this.stage.style, {position: 'absolute', left: '0', top: '0', width: '0', height: '0', transformOrigin: '0 0', pointerEvents: 'none'});
    this.root.append(this.background, this.stage);
    this.background.addEventListener('pointerdown', this.pointerDown);
    this.background.addEventListener('wheel', this.wheel, {passive: false});
    document.addEventListener('pointermove', this.pointerMove, {passive: false});
    document.addEventListener('pointerup', this.pointerEnd);
    document.addEventListener('pointercancel', this.pointerEnd);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(root);
  }

  initialize(scene: PublicScene): void {
    this.cancelAnimation(); this.pointers.length = 0;
    this.state = structuredClone(scene.state);
    this.bounds.makeEmpty();
    this.readableInitialFrame = scene.entities.filter(entity => entity.placement === 'world' && entity.visible && entity.opacity > 0).length === 1;
    const saved = this.state.viewport.board;
    this.initialFrame = !saved;
    this.centerX = saved?.center[0] ?? 0;
    this.centerY = saved?.center[1] ?? 0;
    this.cameraScale = saved?.scale ?? 1;
    this.setBackground(this.state.background);
    this.onLoadProgress?.({completed: 0, total: 0, rawFallbacks: 0, failed: 0, raw: 0, lod: 0, pending: 0});
    this.resize();
  }

  get scale(): number { return this.cameraScale; }
  get viewportWidth(): number { return Math.max(this.root.clientWidth - this.reservedRight, 1); }
  get hasVisibleContent(): boolean { return !this.bounds.isEmpty(); }
  get focusedComponentId(): string | undefined { return this.state.focused_component_id ?? undefined; }
  setFocusedComponent(id: string): void { this.state.focused_component_id = id; }
  setStrokes(strokes: ScreenStroke[]): void { this.state.strokes = strokes; }
  get currentState(): ViewState {
    return {...this.state, viewport: {mode: this.state.viewport.mode, board: {center: [this.centerX, this.centerY], scale: this.cameraScale}}, camera: null,
      frame: {width: Math.round(this.root.clientWidth), height: Math.round(this.root.clientHeight)}};
  }
  exportUpdate(): SceneUpdate { return {meshes: [], state: this.currentState, entities: this.entityUpdates?.()}; }
  worldToScreen(x: number, y: number): {x: number; y: number} {
    const rect = this.root.getBoundingClientRect();
    return {x: rect.left + this.viewportWidth / 2 + (x - this.centerX) * this.cameraScale,
      y: rect.top + this.root.clientHeight / 2 - (y - this.centerY) * this.cameraScale};
  }
  screenToWorld(x: number, y: number): {x: number; y: number} {
    const rect = this.root.getBoundingClientRect();
    return {x: this.centerX + (x - rect.left - this.viewportWidth / 2) / this.cameraScale,
      y: this.centerY - (y - rect.top - this.root.clientHeight / 2) / this.cameraScale};
  }
  setReservedSpace(right: number): void {
    const reservedRight = Math.max(0, Math.min(right, this.root.clientWidth - 1));
    if (reservedRight === this.reservedRight) return;
    this.onViewChangeStart?.();
    this.reservedRight = reservedRight; this.invalidate();
    this.onViewChangeEnd?.();
  }
  setComponentBounds(bounds: Box3): void {
    this.bounds.copy(bounds);
    if (this.initialFrame && !bounds.isEmpty()) {
      this.initialFrame = false;
      if (this.readableInitialFrame) {
        const scale = Math.max(Math.min(this.viewportWidth - 48, 800), 1) / Math.max(bounds.max.x - bounds.min.x, 1e-9);
        const toolbar = this.root.closest('.app-shell')?.querySelector<HTMLElement>('.topbar');
        const top = Math.max(24, (toolbar?.getBoundingClientRect().bottom ?? 0) - this.root.getBoundingClientRect().top + 12);
        this.setCamera({center: [(bounds.min.x + bounds.max.x) / 2, bounds.max.y - (this.root.clientHeight / 2 - top) / scale], scale});
      } else this.fitAll(false);
    }
    this.invalidate();
  }
  setCamera(camera: BoardViewportState): void {
    if (!Number.isFinite(camera.scale) || camera.scale <= 0 || !camera.center.every(Number.isFinite)) throw new OperationError('INVALID_ARGUMENT', 'Board camera requires finite center and positive finite scale', {field: 'camera'});
    this.cancelAnimation(); this.initialFrame = false; this.onViewChangeStart?.();
    this.centerX = camera.center[0]; this.centerY = camera.center[1]; this.cameraScale = camera.scale; this.invalidate();
  }
  pan(delta: readonly [number, number]): void {
    const x = this.centerX - delta[0] / this.cameraScale, y = this.centerY + delta[1] / this.cameraScale;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new OperationError('INVALID_ARGUMENT', 'Pan would exceed finite board coordinates', {field: 'delta'});
    this.cancelAnimation(); this.initialFrame = false; this.onViewChangeStart?.();
    this.centerX = x; this.centerY = y; this.invalidate();
  }
  zoom(factor: number, anchor?: readonly [number, number]): void {
    const scale = this.cameraScale * factor;
    if (!Number.isFinite(scale) || scale <= 0) throw new OperationError('INVALID_ARGUMENT', 'Zoom requires a finite positive resulting scale', {field: 'factor'});
    let centerX = this.centerX, centerY = this.centerY;
    if (anchor) {
      const rect = this.root.getBoundingClientRect();
      const x = anchor[0] - rect.left - this.viewportWidth / 2, y = anchor[1] - rect.top - this.root.clientHeight / 2;
      centerX += x / this.cameraScale - x / scale;
      centerY -= y / this.cameraScale - y / scale;
    }
    if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) throw new OperationError('INVALID_ARGUMENT', 'Zoom anchor would exceed finite board coordinates', {field: 'anchor'});
    this.cancelAnimation(); this.initialFrame = false; this.onViewChangeStart?.();
    this.centerX = centerX; this.centerY = centerY; this.cameraScale = scale; this.invalidate();
  }
  fitAll(animate = true): void { this.focusBox(this.bounds, animate); }
  focusBounds(bounds: Box3, animate = false): void { this.focusBox(bounds, animate); }
  waitForViewTransition(): Promise<'committed' | 'interrupted'> { return this.transition; }
  private focusBox(bounds: Box3, animate: boolean): void {
    if (bounds.isEmpty()) return;
    this.cancelAnimation(); this.initialFrame = false; this.onViewChangeStart?.();
    const x = (bounds.min.x + bounds.max.x) / 2, y = (bounds.min.y + bounds.max.y) / 2;
    const width = Math.max(this.viewportWidth - 64, 1), height = Math.max(this.root.clientHeight - 64, 1);
    const scale = Math.min(width / Math.max(bounds.max.x - bounds.min.x, 1e-9), height / Math.max(bounds.max.y - bounds.min.y, 1e-9));
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.centerX = x; this.centerY = y; this.cameraScale = scale; this.invalidate(); return;
    }
    const completion = Promise.withResolvers<'committed' | 'interrupted'>();
    this.transition = completion.promise; this.finishTransition = completion.resolve;
    const start = performance.now(), fromX = this.centerX, fromY = this.centerY, fromScale = this.cameraScale;
    const tick = (now: number) => {
      const fraction = Math.min((now - start) / 260, 1), t = 1 - (1 - fraction) ** 4;
      this.centerX = fromX + (x - fromX) * t; this.centerY = fromY + (y - fromY) * t;
      this.cameraScale = fromScale * (scale / fromScale) ** t; this.invalidate();
      if (fraction < 1) this.animation = requestAnimationFrame(tick);
      else { this.animation = 0; this.finishTransition?.('committed'); this.finishTransition = undefined; }
    };
    this.animation = requestAnimationFrame(tick);
  }
  setBackground(background: ViewState['background']): void {
    this.state.background = background;
    const color = background === 'light' ? shader.background_light : shader.background_dark;
    this.root.style.backgroundColor = color;
    document.documentElement.dataset.theme = background;
    document.documentElement.style.setProperty('--scene-background', color);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    this.invalidate();
  }
  setInteractionEnabled(enabled: boolean): void {
    this.interactionEnabled = enabled;
    if (!enabled) { this.cancelAnimation(); this.pointers.length = 0; }
  }
  navigatePointer(event: PointerEvent): void { this.pointerDown(event); }
  navigateWheel(event: WheelEvent): void { this.wheel(event); }
  resize(): void { this.invalidate(); }
  invalidate(): void { if (!this.disposed && !this.frame) this.frame = requestAnimationFrame(this.render); }
  private render = (): void => {
    this.frame = 0;
    const x = this.viewportWidth / 2 - this.centerX * this.cameraScale;
    const y = this.root.clientHeight / 2 + this.centerY * this.cameraScale;
    this.stage.style.transform = `matrix(${this.cameraScale},0,0,${-this.cameraScale},${x},${y})`;
    for (const render of this.renderListeners) render();
    this.onRender?.();
  };
  private pointerDown = (event: PointerEvent): void => {
    if (!this.interactionEnabled || event.pointerType !== 'touch' && event.button !== 0 && event.button !== 1 || this.pointers.length >= 2) return;
    for (const pointer of this.pointers) if (pointer.id === event.pointerId) return;
    this.cancelAnimation(); this.initialFrame = false; this.onViewChangeStart?.();
    this.pointers.push({id: event.pointerId, x: event.clientX, y: event.clientY});
    event.preventDefault();
    if (event.target === this.background) this.background.setPointerCapture(event.pointerId);
  };
  private pointerMove = (event: PointerEvent): void => {
    if (!this.interactionEnabled) return;
    let pointer: (typeof this.pointers)[number] | undefined;
    for (let i = 0; i < this.pointers.length; i++) if (this.pointers[i].id === event.pointerId) { pointer = this.pointers[i]; break; }
    if (!pointer) return;
    event.preventDefault();
    const a = this.pointers[0], b = this.pointers[1];
    if (!b) {
      this.centerX -= (event.clientX - pointer.x) / this.cameraScale;
      this.centerY += (event.clientY - pointer.y) / this.cameraScale;
      pointer.x = event.clientX; pointer.y = event.clientY;
    } else {
      const oldX = (a.x + b.x) / 2, oldY = (a.y + b.y) / 2, oldDistance = Math.hypot(a.x - b.x, a.y - b.y);
      pointer.x = event.clientX; pointer.y = event.clientY;
      const nextX = (a.x + b.x) / 2, nextY = (a.y + b.y) / 2;
      const rect = this.root.getBoundingClientRect();
      const x = oldX - rect.left - this.viewportWidth / 2, y = oldY - rect.top - this.root.clientHeight / 2;
      const previous = this.cameraScale;
      if (oldDistance > 0) this.cameraScale = Math.max(1e-9, Math.min(1e9, this.cameraScale * Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1) / oldDistance));
      this.centerX += x / previous - (nextX - rect.left - this.viewportWidth / 2) / this.cameraScale;
      this.centerY -= y / previous - (nextY - rect.top - this.root.clientHeight / 2) / this.cameraScale;
    }
    this.invalidate();
  };
  private pointerEnd = (event: PointerEvent): void => {
    const index = this.pointers.findIndex(pointer => pointer.id === event.pointerId);
    if (index !== -1) {
      this.pointers.splice(index, 1);
      if (!this.pointers.length) this.onViewChangeEnd?.();
    }
  };
  private wheel = (event: WheelEvent): void => {
    if (!this.interactionEnabled) return;
    event.preventDefault();
    const units = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.root.clientHeight : 1;
    const scale = Math.max(1e-9, Math.min(1e9, this.cameraScale * Math.exp(Math.max(-4, Math.min(4, -event.deltaY * units * .0015)))));
    this.zoom(scale / this.cameraScale, [event.clientX, event.clientY]);
    clearTimeout(this.wheelTimer); this.wheelTimer = window.setTimeout(this.wheelEnd, 120);
  };
  private wheelEnd = (): void => { this.wheelTimer = 0; this.onViewChangeEnd?.(); };
  private cancelAnimation(): void {
    clearTimeout(this.wheelTimer); this.wheelTimer = 0;
    if (this.animation) cancelAnimationFrame(this.animation);
    this.animation = 0; this.finishTransition?.('interrupted'); this.finishTransition = undefined;
    this.transition = Promise.resolve('committed');
  }
  dispose(): void {
    this.disposed = true; this.cancelAnimation(); this.observer.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    document.removeEventListener('pointermove', this.pointerMove);
    document.removeEventListener('pointerup', this.pointerEnd);
    document.removeEventListener('pointercancel', this.pointerEnd);
    this.background.remove(); this.stage.remove(); this.renderListeners.clear();
  }
}
