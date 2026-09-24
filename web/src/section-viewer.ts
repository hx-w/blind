import * as THREE from 'three';
import type { SectionState, Vec3 } from './api';
import type { MeshViewer } from './viewer';
import { intersectSection, sectionCaps, type SectionSegment } from './section-geometry';
import {buildContourGraph, fitContours, oppositeContour, snapContour, type ContourGraph, type ContourHit, type OppositeHit, type PlanePoint, type PlaneSegment} from './section-plot';
import {installIcons} from './icons';

const vec = (value: Vec3): THREE.Vector3 => new THREE.Vector3(...value);
const array = (value: THREE.Vector3): Vec3 => value.toArray() as Vec3;

/** One read-only plane shared by an explicit set of Mesh entities. */
export class SectionViewer {
  private readonly panel = document.createElement('section');
  private readonly plot = document.createElement('canvas');
  private readonly overlay = document.createElement('div');
  private readonly guide = document.createElement('div');
  private readonly status = document.createElement('p');
  private readonly offset = document.createElement('input');
  private readonly scopeButton = document.createElement('button');
  private readonly scopeCount = document.createElement('span');
  private readonly scopeList = document.createElement('div');
  private readonly ruler = document.createElement('button');
  private readonly resizeHandle = document.createElement('button');
  private readonly trigger: HTMLButtonElement;
  private state: SectionState | null = null;
  private segments: SectionSegment[] = [];
  private sections: {mesh: number; segments: SectionSegment[]; color: string}[] = [];
  private planeSections: {color: string; segments: PlaneSegment[]}[] = [];
  private contourGraph: ContourGraph = buildContourGraph([]);
  private drawing = false;
  private measuring = false;
  private measureAnchor?: PlanePoint;
  private measureHover?: ContourHit & {opposite: OppositeHit | null};
  private hoverFrame = 0;
  private hoverPosition?: {x: number; y: number};
  private start?: {id: number; x: number; y: number};
  private pendingFrame = 0;
  private plotDrag?: {id: number; x: number; y: number; pan: [number, number]; scale: number};
  private measurePress?: {id: number; x: number; y: number; moved: boolean};
  private readonly plotPointers = new Map<number, {x: number; y: number}>();
  private pinch?: {ids: [number, number]; distance: number; radius: number; anchor: PlanePoint};
  private resizing?: {id: number; x: number; y: number; width: number; height: number};
  private lastPanelSize?: [number, number];

  constructor(private readonly viewer: MeshViewer, private readonly notify: (message: string) => void) {
    this.trigger = document.querySelector<HTMLButtonElement>('#section-trigger')!;
    this.panel.className = 'section-panel'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', '剖面观察'); this.panel.dataset.labelObstacle = '';
    this.plot.className = 'section-plot'; this.plot.setAttribute('aria-label', '二维剖面，可拖动平移或使用尺子测量');
    this.offset.type = 'range'; this.offset.min = '-100'; this.offset.max = '100'; this.offset.value = '0'; this.offset.id = 'section-offset';
    this.status.className = 'section-status'; this.status.setAttribute('role', 'status');
    const heading = document.createElement('header');
    this.resizeHandle.type = 'button'; this.resizeHandle.className = 'section-resize-handle';
    this.resizeHandle.innerHTML = '<i data-lucide="move-diagonal-2" aria-hidden="true"></i>';
    this.resizeHandle.setAttribute('aria-label', '拖动调整剖面窗口大小');
    this.resizeHandle.addEventListener('pointerdown', event => this.resizeStart(event));
    this.resizeHandle.addEventListener('pointermove', event => this.resizeMove(event));
    this.resizeHandle.addEventListener('pointerup', event => this.resizeEnd(event));
    this.resizeHandle.addEventListener('pointercancel', event => this.resizeEnd(event));
    this.scopeButton.type = 'button'; this.scopeButton.className = 'section-scope-trigger';
    this.scopeButton.innerHTML = '<i data-lucide="list-filter" aria-hidden="true"></i>';
    this.scopeCount.className = 'section-scope-count'; this.scopeButton.append(this.scopeCount);
    this.scopeButton.setAttribute('aria-label', '选择剖面 Mesh'); this.scopeButton.setAttribute('aria-expanded', 'false');
    this.scopeButton.addEventListener('click', () => { this.scopeList.hidden = !this.scopeList.hidden; this.scopeButton.setAttribute('aria-expanded', String(!this.scopeList.hidden)); });
    this.scopeList.className = 'section-scope'; this.scopeList.hidden = true; this.scopeList.setAttribute('role', 'group'); this.scopeList.setAttribute('aria-label', '剖面中的 Mesh');
    const redraw = document.createElement('button'); redraw.type = 'button'; redraw.innerHTML = '<i data-lucide="rotate-ccw" aria-hidden="true"></i>'; redraw.setAttribute('aria-label', '重新划线');
    redraw.addEventListener('click', () => this.startDraw());
    this.ruler.type = 'button'; this.ruler.innerHTML = '<i data-lucide="ruler" aria-hidden="true"></i>';
    this.ruler.setAttribute('aria-label', '测量剖面距离，单位为模型坐标单位'); this.ruler.setAttribute('aria-pressed', 'false');
    this.ruler.addEventListener('click', () => {
      this.setMeasuring(!this.measuring);
    });
    const close = document.createElement('button'); close.type = 'button'; close.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>'; close.setAttribute('aria-label', '关闭剖面观察');
    close.addEventListener('click', () => this.close());
    heading.append(this.scopeButton, this.ruler, redraw, close);
    const plotWrap = document.createElement('div'); plotWrap.className = 'section-plot-wrap';
    const zoom = document.createElement('div'); zoom.className = 'section-zoom';
    const tool = (label: string, icon: string, action: () => void) => { const item = document.createElement('button'); item.type = 'button'; item.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i>`; item.setAttribute('aria-label', label); item.addEventListener('click', action); zoom.append(item); };
    tool('放大剖面', 'plus', () => this.zoom(.75));
    tool('缩小剖面', 'minus', () => this.zoom(1.25));
    tool('全幅显示剖面', 'maximize-2', () => { if (this.state) { this.state.fit = true; this.state.pan = [0,0]; this.viewer.setSection(this.state); this.drawPlot(); } });
    plotWrap.append(this.plot, zoom);
    this.plot.addEventListener('wheel', event => { event.preventDefault(); this.zoom(event.deltaY < 0 ? .88 : 1.12, event.clientX, event.clientY); }, {passive:false});
    this.plot.addEventListener('pointerdown', event => this.plotPointerDown(event));
    this.plot.addEventListener('pointermove', event => this.plotPointerMove(event));
    this.plot.addEventListener('pointerup', event => this.plotPointerEnd(event));
    this.plot.addEventListener('pointercancel', event => this.plotPointerEnd(event));
    this.plot.addEventListener('pointerleave', () => { if (this.measuring && !this.measurePress) this.clearHover(); });
    this.plot.addEventListener('contextmenu', event => event.preventDefault());
    this.offset.setAttribute('aria-label', '剖面位置');
    this.panel.append(this.resizeHandle, heading, this.scopeList, plotWrap, this.offset, this.status);
    document.querySelector('#app-shell')!.append(this.panel);
    installIcons(this.panel);
    this.overlay.className = 'section-draw-overlay'; this.overlay.hidden = true;
    this.overlay.setAttribute('aria-label', '在选中 Mesh 上划线定义剖面');
    this.guide.className = 'section-draw-guide'; this.guide.hidden = true; this.overlay.append(this.guide);
    document.querySelector('#viewer')!.append(this.overlay);
    this.overlay.addEventListener('pointerdown', event => this.pointerDown(event));
    this.overlay.addEventListener('pointermove', event => this.pointerMove(event));
    this.overlay.addEventListener('pointerup', event => this.pointerUp(event));
    this.overlay.addEventListener('pointercancel', () => this.cancelDraw());
    this.offset.addEventListener('input', () => {
      if (!this.state) return;
      this.clearMeasurements();
      const extent = this.viewer.sectionTarget(this.state.mesh)?.bounds.getSize(new THREE.Vector3()).length() ?? this.state.radius * 2;
      this.state.offset = Number(this.offset.value) / 100 * extent / 2;
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = requestAnimationFrame(() => this.recompute());
    });
    this.trigger.addEventListener('click', () => this.open());
    new ResizeObserver(() => this.drawPlot()).observe(this.plot);
    window.addEventListener('resize', () => this.applyPanelSize());
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.panel.hidden && document.querySelector('dialog[open]')) return;
      if (this.measuring) {event.preventDefault(); this.setMeasuring(false);}
      else if (this.drawing) {event.preventDefault(); this.cancelDraw();}
      else if (!this.panel.hidden) {event.preventDefault(); this.close();}
    });
  }

  load(): void {
    const saved = this.viewer.currentState.section;
    if (!saved || !this.valid(saved)) { this.viewer.setSection(null); return; }
    this.state = saved; this.lastPanelSize = saved.panel_size; this.show(); this.recompute();
  }
  refresh(): void {
    if (!this.state) return;
    if (!this.valid(this.state)) { this.close(); return; }
    this.renderScope(); this.recompute();
  }
  private valid(state: SectionState): boolean {
    const target = this.viewer.sectionSource(state.mesh);
    return !!target && target.entityId === state.entity_id && target.revision === state.revision
      && (state.targets ?? []).every(item => { const source = this.viewer.sectionSource(item.mesh); return !!source && source.entityId === item.entity_id && source.revision === item.revision; })
      && Number.isFinite(state.radius) && state.radius > 0;
  }
  open(): void {
    if (this.drawing || this.state && !this.panel.hidden) { this.close(); return; }
    const selected = this.viewer.selectedIndex;
    if (!this.viewer.sectionTarget(selected)) { this.notify('请先选中可见的 Mesh，再观察剖面'); return; }
    this.startDraw();
  }
  private show(): void {
    if (document.querySelector('#app-shell')?.classList.contains('tree-open'))
      document.querySelector<HTMLButtonElement>('#scene-tree-toggle')?.click();
    this.panel.hidden = false;
    this.trigger.classList.add('active'); this.trigger.setAttribute('aria-expanded', 'true');
    if (this.state) {
      const extent = this.viewer.sectionSource(this.state.mesh)?.bounds.getSize(new THREE.Vector3()).length() ?? this.state.radius * 2;
      this.offset.value = String(Math.round(this.state.offset / Math.max(extent / 2, 1e-9) * 100));
    }
    this.applyPanelSize();
    this.renderScope();
    this.drawPlot();
  }
  close(): void {
    this.lastPanelSize = this.state?.panel_size ?? this.lastPanelSize;
    this.cancelDraw(); this.state = null; this.segments = []; this.sections = []; this.planeSections = [];
    this.contourGraph = buildContourGraph([]); this.clearHover();
    this.measureAnchor = undefined; this.measuring = false; this.plotPointers.clear(); this.pinch = undefined;
    this.ruler.classList.remove('active'); this.ruler.setAttribute('aria-pressed', 'false'); this.plot.classList.remove('measuring');
    this.scopeList.hidden = true; this.scopeButton.setAttribute('aria-expanded', 'false');
    this.viewer.setSection(null); this.panel.hidden = true;
    this.trigger.classList.remove('active'); this.trigger.setAttribute('aria-expanded', 'false');
  }
  deactivate(): void { this.cancelDraw(); }
  private startDraw(): void {
    if (!this.viewer.sectionTarget(this.viewer.selectedIndex)) { this.notify('请先选中可见的 Mesh'); return; }
    this.drawing = true; this.panel.hidden = true; this.overlay.hidden = false;
    this.trigger.classList.add('active'); this.trigger.setAttribute('aria-expanded', 'true');
  }
  private cancelDraw(): void {
    if (this.drawing) this.panel.hidden = !this.state;
    this.drawing = false; this.start = undefined; this.guide.hidden = true; this.overlay.hidden = true;
    if (!this.state) { this.trigger.classList.remove('active'); this.trigger.setAttribute('aria-expanded', 'false'); }
  }
  private pointerDown(event: PointerEvent): void {
    if (!this.drawing || this.start || !event.isPrimary) return;
    event.preventDefault(); this.start = {id:event.pointerId,x:event.clientX,y:event.clientY};
    this.overlay.setPointerCapture(event.pointerId);
    this.positionGuide(event.clientX, event.clientY);
  }
  private pointerMove(event: PointerEvent): void { if (this.start?.id === event.pointerId) this.positionGuide(event.clientX, event.clientY); }
  private positionGuide(x: number, y: number): void {
    if (!this.start) return;
    const rect = this.overlay.getBoundingClientRect();
    const length = Math.hypot(x - this.start.x, y - this.start.y);
    this.guide.hidden = false;
    this.guide.style.width = `${length}px`;
    this.guide.style.left = `${this.start.x - rect.left}px`;
    this.guide.style.top = `${this.start.y - rect.top}px`;
    this.guide.style.transform = `rotate(${Math.atan2(y - this.start.y, x - this.start.x)}rad)`;
  }
  private pointerUp(event: PointerEvent): void {
    const start = this.start; if (!start || start.id !== event.pointerId) return;
    this.start = undefined; this.guide.hidden = true;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) < 16) { this.notify('线段太短，请重新划线'); return; }
    const mesh = this.viewer.selectedIndex, target = this.viewer.sectionTarget(mesh);
    if (!target) return;
    let anchor: THREE.Vector3 | null = null;
    for (const t of [.5, .25, .75, 0, 1]) {
      anchor = this.viewer.sectionPick(mesh, start.x + dx * t, start.y + dy * t);
      if (anchor) break;
    }
    if (!anchor) { this.notify('线段需要经过选中的 Mesh'); return; }
    this.cancelDraw();
    const basis = this.viewer.sectionCameraBasis();
    const axis = basis.right.multiplyScalar(dx).addScaledVector(basis.up, -dy).normalize();
    const normal = basis.forward.cross(axis).normalize();
    const radius = Math.max(Math.hypot(dx, dy) * this.viewer.sectionWorldPerPixel(anchor) / 2, target.bounds.getSize(new THREE.Vector3()).length() * .01);
    const targets = this.viewer.modelInfos.flatMap((_, index) => {
      const visible = this.viewer.sectionTarget(index);
      return visible ? [{entity_id:visible.entityId, mesh:index, revision:visible.revision}] : [];
    });
    this.state = {entity_id:target.entityId, mesh, revision:target.revision, origin:array(anchor), normal:array(normal), axis:array(axis), radius, offset:0, fit:true, pan:[0,0], targets, panel_size:this.state?.panel_size ?? this.lastPanelSize};
    this.viewer.revealSection(normal, axis);
    this.viewer.setSection(this.state); this.show(); this.recompute();
  }
  private recompute(): void {
    if (!this.state || !this.valid(this.state)) return;
    const normal = vec(this.state.normal).normalize();
    const origin = vec(this.state.origin).addScaledVector(normal, this.state.offset);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const targets = this.state.targets?.length ? this.state.targets.map(target => target.mesh) : [this.state.mesh];
    const unique = [...new Set(targets)];
    this.sections = unique.flatMap(mesh => {
      const target = this.viewer.sectionTarget(mesh);
      if (!target) return [];
      const segments = intersectSection(target.object, plane);
      return [{mesh, segments, color:this.viewer.modelInfos[mesh].color}];
    });
    this.segments = this.sections.flatMap(section => section.segments);
    const axis = vec(this.state.axis).normalize(), vertical = normal.clone().cross(axis).normalize();
    const project = (point: THREE.Vector3): PlanePoint => {
      const relative = point.clone().sub(origin); return [relative.dot(axis), relative.dot(vertical)];
    };
    this.planeSections = this.sections.map(section => ({color:section.color, segments:section.segments.map(segment => ({a:project(segment.a), b:project(segment.b)}))}));
    this.contourGraph = buildContourGraph(this.planeSections.flatMap(section => section.segments));
    this.clearHover();
    const hitCount = this.sections.filter(section => section.segments.length > 0).length;
    for (const check of this.scopeList.querySelectorAll<HTMLInputElement>('input[data-mesh]')) {
      const note = check.closest('.section-scope-row')?.querySelector<HTMLElement>('small');
      if (!note) continue;
      note.hidden = !check.checked || this.sections.some(section => section.mesh === Number(check.dataset.mesh) && section.segments.length > 0);
    }
    this.syncScopeSummary(hitCount);
    this.viewer.setSectionSegments(this.sections.map(section => ({segments:section.segments, caps:sectionCaps(section.segments, origin, normal, vec(this.state!.axis)), color:section.color})));
    this.status.textContent = this.segments.length ? `${this.segments.length} 段截线 · ${hitCount}/${this.sections.length} 个 Mesh 相交` : '此位置没有截线';
    this.drawPlot();
  }
  private renderScope(): void {
    if (!this.state) return;
    this.scopeList.replaceChildren();
    const selected = new Set((this.state.targets?.length ? this.state.targets.map(target => target.mesh) : [this.state.mesh]));
    this.viewer.modelInfos.forEach((info, mesh) => {
      const target = this.viewer.sectionTarget(mesh);
      if (!target) return;
      const row = document.createElement('label'); row.className = 'section-scope-row';
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.mesh = String(mesh); check.checked = selected.has(mesh);
      const dot = document.createElement('i'); dot.style.background = info.color;
      const name = document.createElement('span'); name.textContent = target.name;
      const note = document.createElement('small'); note.textContent = '无交线'; note.hidden = true;
      row.append(check, dot, name, note); this.scopeList.append(row);
      check.addEventListener('change', () => {
        if (!this.state) return;
        const targets = [] as NonNullable<SectionState['targets']>;
        for (const input of this.scopeList.querySelectorAll<HTMLInputElement>('input[data-mesh]:checked')) {
          const index = Number(input.dataset.mesh);
          const item = this.viewer.sectionTarget(index);
          if (item) targets.push({entity_id:item.entityId, mesh:index, revision:item.revision});
        }
        if (!targets.length) { check.checked = true; this.notify('至少保留一个 Mesh'); return; }
        this.clearMeasurements();
        this.state.targets = targets; this.state.fit = true; this.state.pan = [0,0]; this.viewer.setSection(this.state); this.recompute();
      });
    });
    this.syncScopeSummary();
  }
  private syncScopeSummary(hitCount?: number): void {
    if (!this.state) return;
    const checks = [...this.scopeList.querySelectorAll<HTMLInputElement>('input[data-mesh]')];
    const selected = checks.filter(check => check.checked).length;
    this.scopeCount.textContent = `${selected}/${checks.length}`;
    this.scopeCount.hidden = checks.length < 2;
    const result = hitCount === undefined ? '' : `，${hitCount} 个有截线`;
    this.scopeButton.setAttribute('aria-label', `剖面 Mesh：已选 ${selected}/${checks.length}${result}`);
    this.scopeButton.title = `${selected}/${checks.length} 个 Mesh 已选${result}`;
  }
  private clearMeasurements(): void {
    if (!this.state) return;
    this.state.measurements = []; this.measureAnchor = undefined; this.clearHover();
  }
  private setMeasuring(active: boolean): void {
    this.measuring = active; this.measureAnchor = undefined; this.measurePress = undefined; this.clearHover();
    if (!active && this.state) { this.state.measurements = []; this.viewer.setSection(this.state); }
    this.ruler.classList.toggle('active', active); this.ruler.setAttribute('aria-pressed', String(active));
    this.plot.classList.toggle('measuring', active); this.drawPlot();
  }
  private clearHover(): void {
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0; this.hoverPosition = undefined; this.measureHover = undefined;
    this.drawPlot();
  }
  private scheduleHover(clientX: number, clientY: number): void {
    this.hoverPosition = {x:clientX,y:clientY};
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const position = this.hoverPosition;
      this.measureHover = position ? this.plotHit(position.x,position.y) ?? undefined : undefined;
      this.drawPlot();
    });
  }
  private plotWindow(): {radius: number; pan: PlanePoint} {
    if (!this.state) return {radius: 1, pan: [0,0]};
    return this.state.fit ? fitContours(this.contourGraph.segments, this.state.radius)
      : {radius:this.state.radius, pan:this.state.pan ?? [0,0]};
  }
  private plotScale(radius: number, rect: DOMRect): number {
    return Math.min((rect.width - 32) / (radius * 2), (rect.height - 32) / (radius * 2));
  }
  private plotPoint(clientX: number, clientY: number): PlanePoint | null {
    if (!this.state) return null;
    const rect = this.plot.getBoundingClientRect();
    const view = this.plotWindow();
    const scale = this.plotScale(view.radius, rect);
    if (!(scale > 0)) return null;
    return [view.pan[0] + (clientX - rect.left - rect.width / 2) / scale,
      view.pan[1] - (clientY - rect.top - rect.height / 2) / scale];
  }
  private plotHit(clientX: number, clientY: number): (ContourHit & {opposite: OppositeHit | null}) | null {
    const point = this.plotPoint(clientX,clientY); if (!point) return null;
    const scale = this.plotScale(this.plotWindow().radius,this.plot.getBoundingClientRect());
    const hit = snapContour(point,this.contourGraph.segments,12/scale);
    if (hit.index < 0) return null;
    return {...hit,opposite:oppositeContour(this.contourGraph,hit.point,hit.index)};
  }
  private plotPointerDown(event: PointerEvent): void {
    if (!this.state) return;
    event.preventDefault();
    this.plotPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    this.plot.setPointerCapture(event.pointerId);
    if (event.pointerType === 'touch' && this.plotPointers.size >= 2) {
      this.plotDrag = undefined; this.measurePress = undefined; this.plot.classList.remove('dragging');
      this.beginPinch(); return;
    }
    if (this.pinch || !event.isPrimary) return;
    if (this.measuring && event.button === 0) {
      this.measurePress = {id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
      this.scheduleHover(event.clientX,event.clientY); return;
    }
    this.ensurePlotWindow();
    const scale = this.plotScale(this.state.radius,this.plot.getBoundingClientRect());
    this.plotDrag = {id:event.pointerId,x:event.clientX,y:event.clientY,pan:[...(this.state.pan ?? [0,0])],scale};
    this.plot.classList.add('dragging'); this.clearHover();
  }
  private plotPointerMove(event: PointerEvent): void {
    if (this.plotPointers.has(event.pointerId)) this.plotPointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if (this.pinch) { this.movePinch(); return; }
    const press = this.measurePress;
    if (press?.id === event.pointerId) {
      if (Math.hypot(event.clientX-press.x,event.clientY-press.y) > 6) press.moved = true;
      this.scheduleHover(event.clientX,event.clientY); return;
    }
    const drag = this.plotDrag;
    if (this.state && drag?.id === event.pointerId) {
      this.state.pan = [drag.pan[0]-(event.clientX-drag.x)/drag.scale,drag.pan[1]+(event.clientY-drag.y)/drag.scale];
      this.viewer.setSection(this.state); this.drawPlot(); return;
    }
    if (this.measuring && event.pointerType !== 'touch') this.scheduleHover(event.clientX,event.clientY);
  }
  private plotPointerEnd(event: PointerEvent): void {
    this.plotPointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.plotPointers.size < 2) this.pinch = undefined;
      this.clearHover(); return;
    }
    const press = this.measurePress;
    if (press?.id === event.pointerId) {
      this.measurePress = undefined;
      if (!press.moved && event.type === 'pointerup' && this.state) {
        const hit = this.plotHit(event.clientX,event.clientY);
        if (hit) {
          if (this.measureAnchor) {
            if (Math.hypot(hit.point[0]-this.measureAnchor[0],hit.point[1]-this.measureAnchor[1]) > 1e-9) {
              this.state.measurements = [...(this.state.measurements ?? []).slice(-1),
                {a:this.measureAnchor,b:hit.point,...(hit.opposite ? {opposite:hit.opposite.point} : {})}];
              this.viewer.setSection(this.state);
            }
            this.measureAnchor = undefined;
          } else this.measureAnchor = hit.point;
          this.measureHover = hit;
        }
      }
      this.drawPlot(); return;
    }
    if (this.plotDrag?.id === event.pointerId) {
      this.plotDrag = undefined; this.plot.classList.remove('dragging');
    }
  }
  private beginPinch(): void {
    if (!this.state) return;
    this.ensurePlotWindow();
    const [first,second] = [...this.plotPointers.entries()].slice(0,2);
    const cx = (first[1].x+second[1].x)/2, cy = (first[1].y+second[1].y)/2;
    const anchor = this.plotPoint(cx,cy); if (!anchor) return;
    this.pinch = {ids:[first[0],second[0]],distance:Math.max(1,Math.hypot(second[1].x-first[1].x,second[1].y-first[1].y)),radius:this.state.radius,anchor};
    this.clearHover();
  }
  private movePinch(): void {
    if (!this.state || !this.pinch) return;
    const [a,b] = this.pinch.ids.map(id=>this.plotPointers.get(id));
    if (!a || !b) return;
    const distance = Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));
    const radius = Math.max(1e-8,Math.min(1e9,this.pinch.radius*this.pinch.distance/distance));
    const rect = this.plot.getBoundingClientRect(), scale = this.plotScale(radius,rect);
    const cx = (a.x+b.x)/2-rect.left-rect.width/2, cy = (a.y+b.y)/2-rect.top-rect.height/2;
    this.state.radius = radius;
    this.state.pan = [this.pinch.anchor[0]-cx/scale,this.pinch.anchor[1]+cy/scale];
    this.viewer.setSection(this.state); this.drawPlot();
  }
  private drawPlot(): void {
    if (this.panel.hidden) return;
    const rect = this.plot.getBoundingClientRect();
    const width = Math.max(1, rect.width), height = Math.max(1, rect.height), pixelRatio = Math.min(devicePixelRatio, 2);
    this.plot.width = Math.round(width * pixelRatio); this.plot.height = Math.round(height * pixelRatio);
    const ctx = this.plot.getContext('2d'); if (!ctx) return;
    ctx.scale(pixelRatio, pixelRatio);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#292c32';
    ctx.fillRect(0, 0, width, height);
    if (!this.state) return;
    const {radius, pan} = this.plotWindow();
    const scale = Math.min((width - 32) / (radius * 2), (height - 32) / (radius * 2));
    const x = (value: number) => width / 2 + (value - pan[0]) * scale, y = (value: number) => height / 2 - (value - pan[1]) * scale;
    ctx.strokeStyle = 'rgba(150, 161, 177, .22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(width, y(0)); ctx.moveTo(x(0), 0); ctx.lineTo(x(0), height); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    ctx.lineWidth = 1.55; ctx.lineCap = 'round';
    for (const section of this.planeSections) {
      ctx.strokeStyle = section.color; ctx.beginPath();
      for (const segment of section.segments) {
        ctx.moveTo(x(segment.a[0]), y(segment.a[1])); ctx.lineTo(x(segment.b[0]), y(segment.b[1]));
      }
      ctx.stroke();
    }
    const placedLabels: Array<{x:number;y:number;width:number;height:number}> = [];
    const readout = (value: string, bx: number, by: number, color: string, lower: boolean, side: number) => {
      ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
      const labelWidth = ctx.measureText(value).width + 14, labelHeight = 22;
      let lx = side > 0 ? bx + 13 : bx - labelWidth - 13;
      if (lx < 4 || lx + labelWidth > width - 4) lx = side > 0 ? bx - labelWidth - 13 : bx + 13;
      lx = Math.max(4,Math.min(width-labelWidth-4,lx));
      let ly = Math.max(4,Math.min(height-labelHeight-4,by+(lower ? 8 : -30)));
      for (let attempt=0;attempt<6;attempt++) {
        if (!placedLabels.some(label => lx < label.x+label.width+3 && lx+labelWidth+3 > label.x && ly < label.y+label.height+3 && ly+labelHeight+3 > label.y)) break;
        ly = Math.max(4,Math.min(height-labelHeight-4,ly+(lower?25:-25)));
      }
      placedLabels.push({x:lx,y:ly,width:labelWidth,height:labelHeight});
      ctx.fillStyle = 'rgba(31, 29, 42, .94)'; ctx.beginPath(); ctx.roundRect(lx,ly,labelWidth,labelHeight,6); ctx.fill();
      ctx.fillStyle = color; ctx.fillText(value,lx+7,ly+15);
    };
    const drawMeasure = (a: PlanePoint, b: PlanePoint, opposite?: PlanePoint, preview = false) => {
      const ax = x(a[0]), ay = y(a[1]), bx = x(b[0]), by = y(b[1]);
      const ox = opposite ? x(opposite[0]) : bx, oy = opposite ? y(opposite[1]) : by;
      const rightPressure = Number(ax > bx + 2) + Number(opposite !== undefined && ox > bx + 2);
      const leftPressure = Number(ax < bx - 2) + Number(opposite !== undefined && ox < bx - 2);
      const labelSide = rightPressure > leftPressure ? -1 : 1;
      ctx.strokeStyle = '#c7a7ff'; ctx.fillStyle = '#c7a7ff'; ctx.lineWidth = 1.8;
      ctx.setLineDash(preview ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      for (const [px, py] of [[ax,ay],[bx,by]]) {ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill();}
      if (opposite) {
        ctx.strokeStyle = '#7ed6cf'; ctx.fillStyle = '#7ed6cf'; ctx.lineWidth = 1.5; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(ox,oy); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(ox,oy,3.5,0,Math.PI*2); ctx.fill();
      }
      readout(Math.hypot(b[0]-a[0], b[1]-a[1]).toFixed(3),bx,by,'#e4d4ff',false,labelSide);
      if (opposite) readout(Math.hypot(opposite[0]-b[0], opposite[1]-b[1]).toFixed(3),bx,by,'#aaf0e7',true,labelSide);
    };
    for (const line of this.state.measurements ?? []) drawMeasure(line.a,line.b,line.opposite);
    if (this.measureAnchor && this.measureHover) drawMeasure(this.measureAnchor,this.measureHover.point,this.measureHover.opposite?.point,true);
    else if (this.measureAnchor) {ctx.fillStyle = '#c7a7ff';ctx.beginPath();ctx.arc(x(this.measureAnchor[0]),y(this.measureAnchor[1]),3.5,0,Math.PI*2);ctx.fill();}
    if (this.measuring && this.measureHover && this.measureHover.index !== -1) {
      const px = x(this.measureHover.point[0]), py = y(this.measureHover.point[1]);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#292c32';
      ctx.strokeStyle = '#c7a7ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px,py,5.5,0,Math.PI*2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  private zoom(factor: number, clientX?: number, clientY?: number): void {
    if (!this.state) return;
    this.ensurePlotWindow();
    const rect = this.plot.getBoundingClientRect();
    clientX ??= rect.left+rect.width/2; clientY ??= rect.top+rect.height/2;
    const anchor = this.plotPoint(clientX,clientY); if (!anchor) return;
    this.state.radius = Math.max(1e-8,Math.min(1e9,this.state.radius*factor));
    const scale = this.plotScale(this.state.radius,rect);
    this.state.pan = [anchor[0]-(clientX-rect.left-rect.width/2)/scale,
      anchor[1]+(clientY-rect.top-rect.height/2)/scale];
    this.viewer.setSection(this.state); this.drawPlot();
  }
  private ensurePlotWindow(): void {
    if (!this.state?.fit) return;
    const view = this.plotWindow(); this.state.radius = view.radius; this.state.pan = view.pan;
    this.state.fit = false;
  }

  private clampedPanelSize(width: number, height: number): [number, number] {
    const mobile = innerWidth < 760;
    const dock = parseFloat(getComputedStyle(document.querySelector('#app-shell')!).getPropertyValue('--dock-height')) || 64;
    const maxWidth = Math.min(1200, Math.max(280, innerWidth - (mobile ? 24 : 36)));
    const maxHeight = Math.min(1200, Math.max(160, innerHeight - dock - 142));
    return [mobile ? maxWidth : Math.max(280, Math.min(maxWidth, width)), Math.max(160, Math.min(maxHeight, height))];
  }
  private applyPanelSize(size = this.state?.panel_size): void {
    const [width, height] = this.clampedPanelSize(size?.[0] ?? 500, size?.[1] ?? (innerWidth < 760 ? 300 : 380));
    this.panel.style.width = `${width}px`; this.plot.style.height = `${height}px`;
  }
  private resizeStart(event: PointerEvent): void {
    if (!this.state || !event.isPrimary) return;
    event.preventDefault(); this.resizeHandle.setPointerCapture(event.pointerId);
    this.resizing = {id:event.pointerId, x:event.clientX, y:event.clientY, width:this.panel.getBoundingClientRect().width, height:this.plot.getBoundingClientRect().height};
    this.panel.classList.add('resizing');
  }
  private resizeMove(event: PointerEvent): void {
    const start = this.resizing; if (!start || event.pointerId !== start.id) return;
    const [width, height] = this.clampedPanelSize(start.width + start.x - event.clientX, start.height + start.y - event.clientY);
    this.applyPanelSize([width,height]);
  }
  private resizeEnd(event: PointerEvent): void {
    if (!this.resizing || event.pointerId !== this.resizing.id) return;
    this.resizing = undefined; this.panel.classList.remove('resizing');
    if (this.state) {
      this.state.panel_size = [this.panel.getBoundingClientRect().width, this.plot.getBoundingClientRect().height];
      this.lastPanelSize = this.state.panel_size;
      this.viewer.setSection(this.state);
    }
  }
}
