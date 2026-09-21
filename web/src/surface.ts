import type { SurfaceAnnotation, ScreenStroke, Vec3 } from './api';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { MeshViewer } from './viewer';
import type { MarkupCanvas } from './markup';
import { clamp, layoutLabel, type LabelOffset, type Rect } from './label-layout';

type Hit = { point: Vec3; normal: Vec3 };
type Mode = 'select' | 'point' | 'line' | 'screen';
type Snapshot = { marks: SurfaceAnnotation[]; strokes: ScreenStroke[]; selected?: string; screen?: number; draft?: string };
type BadgeView = { button: HTMLButtonElement; line: SVGLineElement; width: number; height: number; offset?: LabelOffset };
const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ff6b5e', '#ffc857', '#5fb4ff', '#f4f2ea'];
const icon = (path: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const undoIcon = icon('<path d="m9 8-4 4 4 4M5 12h9a5 5 0 0 1 5 5"/>');
const redoIcon = icon('<path d="m15 8 4 4-4 4M19 12h-9a5 5 0 0 0-5 5"/>');
const trashIcon = icon('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>');

export class SurfaceEditor {
  private readonly panel: HTMLElement;
  private readonly input: HTMLElement;
  private readonly list: HTMLElement;
  private readonly badges: HTMLElement;
  private mode: Mode = 'point';
  private color = COLORS[0];
  private selected?: string;
  private selectedScreen?: number;
  private draft?: string;
  private target = 0;
  private busy = false;
  private selectionPointer?: number;
  private readonly cameraPointers = new Set<number>();
  private readonly cancelledPointers = new Set<number>();
  private active = false;
  private listDismissed = false;
  private readonly badgeElements = new Map<string, BadgeView>();
  private readonly badgeLeaders = document.createElementNS(SVG_NS, 'svg');
  private badgeObstacles: Rect[] | null = null;
  private badgeViewport = '';
  private hovered?: string;
  private history: Snapshot[] = [];
  private future: Snapshot[] = [];
  private screenBefore?: Snapshot;
  private gesture?: { id: number; before: Snapshot; x: number; y: number; moving?: number; markId?: string; selectionOnly?: boolean; changed: boolean; dragged?: boolean };
  private status = '';
  private pending?: {id:number; x:number; y:number; up:boolean; samples:Array<[number,number]>};

  constructor(private viewer: MeshViewer, private markup: MarkupCanvas, private shell: HTMLElement,
    private callbacks: { closePanel: () => void; toast: (message: string) => void; change: () => void }) {
    this.input = document.createElement('div'); this.input.id = 'surface-input'; this.input.hidden = true;
    this.input.setAttribute('aria-label', '标记画布');
    document.querySelector('#viewer')!.append(this.input);
    this.badges = document.createElement('div'); this.badges.id = 'surface-badges';
    this.badgeLeaders.setAttribute('aria-hidden','true');this.badges.append(this.badgeLeaders);
    document.querySelector('#viewer')!.append(this.badges);
    this.panel = document.createElement('section'); this.panel.id = 'surface-toolbar'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', '标记工具'); this.panel.setAttribute('data-label-obstacle', '');
    this.panel.innerHTML = `
      <div class="surface-modes" role="group" aria-label="标注工具">
        <button data-surface-mode="select" type="button">${icon('<path d="m5 3 13 9-7 1-3 7Z"/>')}选择</button>
        <button data-surface-mode="point" type="button">${icon('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>')}点</button>
        <button data-surface-mode="line" type="button">${icon('<path d="M4 17c5 0 4-10 9-10s2 9 7 9"/>')}线</button>
        <button data-surface-mode="screen" id="surface-brush" type="button">${icon('<path d="m15 4 5 5L8 20l-4-1 1-4Z"/>')}画笔</button>
        <button id="surface-done" class="surface-primary" type="button">完成</button>
      </div>
      <div class="surface-actions">
        <div class="surface-colors" role="group" aria-label="标记颜色">${COLORS.map((color, i) => `<button type="button" data-surface-color="${color}" aria-label="${['珊瑚红','琥珀黄','标记蓝','柔白'][i]}" style="--ink:${color}"><i></i></button>`).join('')}</div>
        <span class="surface-action-spacer"></span>
        <button id="surface-undo" type="button" aria-label="撤销标记">${undoIcon}</button><button id="surface-redo" type="button" aria-label="重做标记">${redoIcon}</button>
      </div>
      <div class="surface-selection" hidden>
        <input id="surface-name" maxlength="120" aria-label="标记名称" placeholder="标记名称" autocomplete="off"/>
        <button id="surface-close" type="button">闭合</button><button id="surface-end" type="button">完成线</button>
        <button id="surface-delete" type="button" aria-label="删除选中标记">${trashIcon}</button>
      </div>
      <p id="surface-hint" role="status"></p>`;
    shell.append(this.panel);
    this.list = document.createElement('section'); this.list.className = 'surface-list'; this.list.hidden = true;
    this.list.setAttribute('aria-label','标记列表'); this.list.setAttribute('data-label-obstacle','');
    this.list.innerHTML = '<div class="surface-list-heading"><strong>标记</strong><span>点选定位</span><button type="button" id="surface-list-close" aria-label="收起标记列表">×</button></div><div id="surface-items"></div>';
    this.el('#scene-panels').append(this.list);
    const layout = () => this.updateLayout();
    new ResizeObserver(layout).observe(this.panel);
    new MutationObserver(layout).observe(this.shell, {attributes:true, attributeFilter:['class']});
    window.addEventListener('resize', layout);
    window.visualViewport?.addEventListener('resize', layout);
    window.visualViewport?.addEventListener('scroll', layout);
    layout();
    this.el('#surface-list-close').addEventListener('click', () => { this.listDismissed=true; this.updateLayout(); });
    this.el('#surface-done').addEventListener('click', () => this.exit());
    this.el('#surface-end').addEventListener('click', () => { this.finishLine(); this.sync(); });
    this.el('#surface-close').addEventListener('click', () => this.closeLine());
    this.el('#surface-delete').addEventListener('click', () => this.remove());
    this.el('#surface-undo').addEventListener('click', () => this.undo());
    this.el('#surface-redo').addEventListener('click', () => this.redo());
    this.el<HTMLInputElement>('#surface-name').addEventListener('change', event => {
      if (!this.current && this.selectedScreen === undefined) return;
      this.remember();
      const label = (event.target as HTMLInputElement).value.trim();
      if (this.current) this.current.label = label;
      else {
        const strokes = this.markup.exportStrokes();
        strokes[this.selectedScreen!].label = label || undefined;
        this.markup.load(strokes);
      }
      this.sync();
    });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-mode]').forEach(button => button.addEventListener('click', () => {
      this.markup.finishActive(); this.finishLine(); this.selected = undefined; this.selectedScreen=undefined;
      this.mode = button.dataset.surfaceMode as Mode; this.status = ''; this.sync();
    }));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-color]').forEach(button => button.addEventListener('click', () => {
      this.color = button.dataset.surfaceColor!;
      if (this.current) { this.remember(); this.current.color = this.color; }
      else if(this.selectedScreen!==undefined) { this.remember(); const strokes=this.markup.exportStrokes(); strokes[this.selectedScreen].color=this.color; this.markup.load(strokes); }
      this.sync();
    }));
    this.markup.onStrokeStart=()=> { this.selected=undefined; this.selectedScreen=undefined; this.screenBefore=this.snapshot(); };
    this.markup.onStrokeEnd=()=> { if(this.screenBefore) { if(JSON.stringify(this.screenBefore.strokes)!==JSON.stringify(this.markup.exportStrokes())) this.remember(this.screenBefore); this.screenBefore=undefined; } this.sync(); };
    this.input.addEventListener('pointerdown', event => void this.down(event));
    this.input.addEventListener('pointermove', event => this.move(event));
    this.input.addEventListener('pointerup', event => this.up(event));
    this.input.addEventListener('pointercancel', event => { if(this.pending?.id===event.pointerId)this.pending=undefined; if(this.gesture?.id===event.pointerId)this.cancelGesture(); });
    this.input.addEventListener('lostpointercapture', () => { if(!this.pending) this.cancelGesture(); });
    window.addEventListener('keydown', event => {
      if (!this.active || this.busy || event.target instanceof HTMLInputElement || document.querySelector('dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
      else if (event.key === 'Escape') { event.preventDefault(); if (this.gesture) this.cancelGesture(); else if(!this.list.hidden) {this.listDismissed=true;this.updateLayout();} else this.exit(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.remove(); }
      else if (event.code === 'Space' && !event.repeat) { event.preventDefault(); this.chooseSelection(); }
      else if (event.key === 'Enter') { event.preventDefault(); this.finishLine(); this.sync(); }
    });
    // Selection shares the viewer canvas with camera controls. Only a hit on a
    // mark captures the gesture; ordinary drags and multi-touch stay with Arcball.
    const canvas=this.el<HTMLCanvasElement>('#canvas-root canvas');
    window.addEventListener('pointerdown',event=> {
      // A second finger can land on a label or toolbar, outside the canvas.
      if(!this.active || this.mode!=='select' || event.pointerId===this.selectionPointer || (!this.cancelledPointers.size && this.selectionPointer===undefined))return;
      if(this.selectionPointer!==undefined)this.cancelledPointers.add(this.selectionPointer);
      this.cancelledPointers.add(event.pointerId);event.stopImmediatePropagation();event.preventDefault();
      canvas.setPointerCapture(event.pointerId);this.selectionPointer=undefined;this.cancelGesture();
      this.status='已取消调整，松开后可双指移动与缩放';this.sync();
    },true);
    canvas.addEventListener('pointerdown',event=> {
      if(!this.active || this.mode!=='select' || event.button!==0 || this.busy)return;
      if(this.cameraPointers.size || !event.isPrimary || (!this.findMark(event.clientX,event.clientY) && this.markup.hitTest(event.clientX,event.clientY)===undefined)) {
        this.cameraPointers.add(event.pointerId);return;
      }
      event.stopImmediatePropagation();this.selectionPointer=event.pointerId;
      this.viewer.setInteractionEnabled(false);void this.down(event,canvas);
    },true);
    canvas.addEventListener('pointermove',event=> {
      if(this.cancelledPointers.has(event.pointerId)){event.stopImmediatePropagation();return;}
      if(this.selectionPointer!==event.pointerId)return;
      event.stopImmediatePropagation();if(this.gesture)this.move(event);
    },true);
    canvas.addEventListener('pointerup',event=> {
      this.cameraPointers.delete(event.pointerId);
      if(this.cancelledPointers.delete(event.pointerId)){event.stopImmediatePropagation();this.sync();return;}
      if(this.selectionPointer!==event.pointerId)return;
      event.stopImmediatePropagation();this.selectionPointer=undefined;this.up(event);this.sync();
    },true);
    const cancel=(event:PointerEvent)=> {
      this.cameraPointers.delete(event.pointerId);
      if(this.cancelledPointers.delete(event.pointerId)){event.stopImmediatePropagation();this.sync();return;}
      if(this.selectionPointer!==event.pointerId)return;
      this.selectionPointer=undefined;this.cancelGesture();this.sync();
    };
    canvas.addEventListener('pointercancel',cancel,true);
    canvas.addEventListener('lostpointercapture',cancel,true);
    const endCamera=(event:PointerEvent)=>this.cameraPointers.delete(event.pointerId);
    window.addEventListener('pointerup',endCamera,true);
    window.addEventListener('pointercancel',endCamera,true);
    window.addEventListener('blur',()=> {
      this.cameraPointers.clear();this.cancelledPointers.clear();this.selectionPointer=undefined;
      if(this.active){this.cancelGesture();this.sync();}
    });
    this.viewer.onRender = () => this.renderBadges();
  }
  private el<T extends HTMLElement = HTMLButtonElement>(selector: string): T { return document.querySelector<T>(selector)!; }
  private updateLayout(): void {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const inset = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
    this.shell.style.setProperty('--annotation-viewport-height', `${height}px`);
    this.shell.style.setProperty('--annotation-keyboard-inset', `${inset}px`);
    this.shell.style.setProperty('--annotation-toolbar-height', `${this.active ? this.panel.offsetHeight : 64}px`);
    const detailWidth = this.shell.classList.contains('panel-open') ? this.el('#control-panel').offsetWidth + 16 : 0;
    const enoughSpace = (viewport?.width ?? window.innerWidth) - detailWidth >= 900 && height >= 600;
    this.badgeObstacles=null;this.viewer.refreshLabels();
    this.list.hidden = this.listDismissed || !enoughSpace || (!this.visibleMarks().length && !this.markup.hasStrokes);
  }
  private get current(): SurfaceAnnotation | undefined { return this.viewer.annotations.find(mark => mark.id === this.selected); }
  get isActive(): boolean { return this.active; }
  async enter(id?: string): Promise<void> {
    this.callbacks.closePanel(); this.active = true;
    if(id) this.selectMark(id);
    this.panel.hidden = false; this.shell.classList.add('surface-mode');
    this.el('#gesture-hint').classList.add('dismissed'); this.sync();
  }
  load(): void {
    this.listDismissed=false;
    this.refreshList();this.sync();
  }
  private selectMark(id: string): void {
    this.finishLine(); this.selectedScreen=undefined;
    const mark=this.viewer.annotations.find(m=>m.id===id); if(!mark) return;
    this.selected=id; this.mode='select'; this.target=mark.mesh; this.color=mark.color;
    if(!mark.visible) {this.remember();mark.visible=true;}
    this.viewer.focusAnnotation(mark); this.status=''; this.sync();
  }
  exit(): void {
    this.markup.finishActive(); this.pending=undefined; this.cancelGesture(); this.finishLine(); this.active = false; this.selected = undefined; this.selectedScreen=undefined;
    this.panel.hidden = true; this.input.hidden = true; this.shell.classList.remove('surface-mode');
    this.viewer.setInteractionEnabled(true); this.sync();
  }
  finishForShare(): void { this.markup.finishActive(); this.cancelGesture(); this.finishLine(); this.sync(); }
  invalidateScreenHistory(): void { for(const s of [...this.history,...this.future]) {s.strokes=[];s.screen=undefined;} this.selectedScreen=undefined; }
  private chooseSelection(): void { this.markup.finishActive(); this.cancelGesture(); this.finishLine(); this.mode='select'; this.status=''; this.sync(); }
  private snapshot(): Snapshot { return { marks: structuredClone(this.viewer.annotations), strokes:this.markup.exportStrokes(), screen:this.selectedScreen, selected: this.selected, draft: this.draft }; }
  private async restore(snapshot: Snapshot): Promise<boolean> {
    const targets=[...new Set(snapshot.marks.map(mark=>mark.mesh))];
    const needsRaw=targets.filter(index=>this.viewer.modelInfos[index]?.quality!=='raw' || this.viewer.modelInfos[index]?.loading);
    if(needsRaw.length) {
      this.busy=true;this.status='正在恢复精细表面…';this.sync();
      try {for(const index of needsRaw) await this.viewer.setQuality(index,'raw');}
      catch {this.callbacks.toast('精细表面加载失败，未恢复标记');return false;}
      finally {this.busy=false;this.status='';this.sync();}
    }
    this.selected=snapshot.selected;this.selectedScreen=snapshot.screen;this.draft=snapshot.draft;
    const restored=snapshot.marks.find(mark=>mark.id===(snapshot.draft??snapshot.selected));
    if(restored) this.target=restored.mesh;
    if(this.draft) this.mode='line';
    this.viewer.setAnnotations(structuredClone(snapshot.marks));this.markup.load(snapshot.strokes);this.sync();return true;
  }
  private remember(snapshot = this.snapshot()): void { this.history.push(snapshot); if (this.history.length > 40) this.history.shift(); this.future = []; }
  private async undo(): Promise<void> { if(this.busy)return;this.cancelGesture();const previous=this.history.at(-1);if(!previous)return;const current=this.snapshot();if(await this.restore(previous)){this.history.pop();this.future.push(current);this.sync();} }
  private async redo(): Promise<void> { if(this.busy)return;this.cancelGesture();const next=this.future.at(-1);if(!next)return;const current=this.snapshot();if(await this.restore(next)){this.future.pop();this.history.push(current);this.sync();} }
  private remove(): void {
    if(this.selectedScreen!==undefined) {this.remember();const strokes=this.markup.exportStrokes();strokes.splice(this.selectedScreen,1);this.selectedScreen=undefined;this.markup.load(strokes);this.sync();return;}
    if (!this.current) return; this.remember(); const id = this.selected;
    this.viewer.setAnnotations(this.viewer.annotations.filter(mark => mark.id !== id)); this.selected = undefined;
    if (this.draft === id) this.draft = undefined; this.sync();
  }
  private finishLine(): void {
    const mark = this.viewer.annotations.find(m => m.id === this.draft);
    if (mark && mark.points.length < 2) {
      this.viewer.setAnnotations(this.viewer.annotations.filter(m => m.id !== mark.id));
      this.selected = undefined; this.callbacks.toast('至少两个位置才能成线，单点草稿已取消');
    }
    this.draft = undefined;
  }
  private newMark(hit: Hit): SurfaceAnnotation | undefined {
    if(this.viewer.annotations.reduce((n,m)=>n+m.points.length,0)+(this.mode==='point'?1:2)>16384) {this.callbacks.toast('标记已达到采样上限，请删除部分标记后重试');return;}
    if (this.viewer.annotations.length >= 64) { this.callbacks.toast('最多保留 64 个标记'); return; }
    const mark: SurfaceAnnotation = { id: globalThis.crypto?.randomUUID?.() ?? `mark-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      mesh: this.target, revision: this.viewer.modelInfos[this.target].revision, kind: this.mode === 'point' ? 'point' : 'line',
      label: `${this.mode === 'point' ? '点' : '线'} ${this.viewer.annotations.filter(m => m.kind === this.mode).length + 1}`,
      color: this.color, visible: true, closed: false, points: [hit.point], normals: [hit.normal], controls: [0] };
    this.viewer.annotations.push(mark); this.selected = mark.id; if (this.mode === 'line') this.draft = mark.id; return mark;
  }
  private nearPoint(point: Vec3, x: number, y: number, radius = 18): boolean {
    const p = this.viewer.projectSurface(point); return p.visible && Math.hypot(p.x - x, p.y - y) <= radius;
  }
  private findMark(x: number, y: number): SurfaceAnnotation | undefined {
    return [...this.viewer.annotations].reverse().find(mark => this.viewer.modelInfos[mark.mesh]?.visible && this.viewer.modelInfos[mark.mesh]?.opacity > 0 && mark.visible && mark.points.some((point, i) =>
      (mark.kind === 'point' || i % 2 === 0) && this.nearPoint(point, x, y, mark.kind === 'point' ? 18 : 12) && this.viewer.surfacePointVisible(point, mark.mesh)));
  }
  private async down(event: PointerEvent, capture: HTMLElement = this.input): Promise<void> {
    if (event.button !== 0) return;
    if(this.pending && event.pointerId!==this.pending.id) {this.pending=undefined;this.status='双指移动与缩放请切换到「选择」';this.sync();return;}
    if(this.busy)return;
    if (this.gesture) { this.cancelGesture(); this.status = '用「选择」旋转、移动和缩放'; this.sync(); return; }
    event.preventDefault(); capture.setPointerCapture(event.pointerId);
    if(this.mode==='select') {
      const screen=this.markup.hitTest(event.clientX,event.clientY);
      if(screen!==undefined) {this.selected=undefined;this.selectedScreen=screen;this.sync();return;}
      const existing=this.findMark(event.clientX,event.clientY);
      if(!existing) {this.selected=undefined;this.selectedScreen=undefined;this.sync();return;}
      if(existing.id!==this.selected) {this.selectMark(existing.id);return;}
      this.target=existing.mesh;
    }
    let hit = this.viewer.pickSurface(event.clientX, event.clientY, this.draft ? this.target : undefined);
    if (!hit) { this.status = '点按可见的模型表面'; this.sync(); return; }
    this.target=hit.mesh;
    if(this.viewer.modelInfos[this.target].quality!=='raw') {
      const pending=this.pending={id:event.pointerId,x:event.clientX,y:event.clientY,up:false,samples:[] as Array<[number,number]>};
      this.busy=true;this.status='正在准备精细表面…';this.sync();
      try {await this.viewer.setQuality(this.target,'raw');}
      catch {this.callbacks.toast('表面加载失败，请重试');this.pending=undefined;}
      finally {this.busy=false;}
      if(this.pending!==pending) {this.sync();return;}
      this.pending=undefined;
      hit=this.viewer.pickSurface(event.clientX,event.clientY,this.target);
      if(!hit) {this.sync();return;}
      // Preserve a tap received while geometry loads; a drag is sampled below.
      this.startGesture(event,hit);
      for(const [x,y] of pending.samples) this.move(new PointerEvent('pointermove',{pointerId:event.pointerId,clientX:x,clientY:y}));
      if(pending.up) this.up(new PointerEvent('pointerup',{pointerId:event.pointerId,clientX:pending.x,clientY:pending.y}));
      return;
    }
    this.startGesture(event,hit);
  }
  private startGesture(event: PointerEvent, hit: Hit): void {
    const before=this.snapshot();
    this.status = '';
    const gesture = this.gesture = { id: event.pointerId, before, x: event.clientX, y: event.clientY, changed: false } as NonNullable<SurfaceEditor['gesture']>;
    const current = this.current;
    this.selectedScreen=undefined;
    if (current && this.mode === 'select') {
      const control = current.controls.find(i => this.nearPoint(current.points[i], event.clientX, event.clientY) && this.viewer.surfacePointVisible(current.points[i], this.target));
      if (control !== undefined) { gesture.moving = control; gesture.markId = current.id; return; }
    }
    if (this.mode === 'select') {
      const existing = this.findMark(event.clientX, event.clientY);
      if (existing && existing.id !== this.selected) {
        this.selected = existing.id; this.mode = 'select'; this.color = existing.color; gesture.selectionOnly = true; this.sync(); return;
      }
      if (existing?.kind === 'line') {
        let nearest = 0, distance = Infinity;
        existing.points.forEach((point, i) => { const p = this.viewer.projectSurface(point), d = Math.hypot(p.x - event.clientX, p.y - event.clientY); if (d < distance) { distance = d; nearest = i; } });
        if (!existing.controls.includes(nearest)) { existing.controls.push(nearest); existing.controls.sort((a,b) => a-b); gesture.changed = true; }
        gesture.moving = nearest; gesture.markId = existing.id; this.sync(); return;
      }
    }
    if (this.draft && current && current.controls.length >= 3 && this.nearPoint(current.points[0], event.clientX, event.clientY, 14)) {
      this.gesture = undefined; this.closeLine(); return;
    }
    if(this.mode==='select') return;
    const mark = this.draft ? this.current : this.newMark(hit);
    if (!mark) return;
    gesture.markId = mark.id;
    if (mark.kind === 'point') gesture.moving = 0;
    else if (mark.points.length > 0 && mark.id === before.draft) this.append(mark, event.clientX, event.clientY);
    gesture.changed = true; this.sync();
  }
  private move(event: PointerEvent): void {
    if(this.pending) {if(event.pointerId!==this.pending.id)return;this.pending.x=event.clientX;this.pending.y=event.clientY;if(this.pending.samples.length<4096)this.pending.samples.push([event.clientX,event.clientY]);return;}
    if (this.busy) return;
    const hit = this.viewer.pickSurface(event.clientX, event.clientY, this.gesture || this.draft ? this.target : undefined);
    const gesture = this.gesture;
    if (!gesture) { this.viewer.setAnnotations(this.viewer.annotations, this.selected, hit?.point); return; }
    if (gesture.id !== event.pointerId || gesture.selectionOnly) return;
    const mark = this.viewer.annotations.find(m => m.id === gesture.markId); if (!mark || !hit) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 3) return;
    gesture.dragged=true;
    if (gesture.moving !== undefined) {
      if (mark.kind === 'point') { mark.points[0] = hit.point; mark.normals[0] = hit.normal; gesture.changed = true; }
      else {
        const original = gesture.before.marks.find(m => m.id === mark.id);
        if (original && this.moveControl(mark, original, gesture.moving, hit)) gesture.changed = true;
      }
    } else { this.append(mark, event.clientX, event.clientY); gesture.changed = true; }
    this.sync(false);
  }
  private up(event: PointerEvent): void {
    if(this.pending) {if(event.pointerId!==this.pending.id)return;this.pending.up=true;this.pending.x=event.clientX;this.pending.y=event.clientY;return;}
    const gesture = this.gesture; if (!gesture || gesture.id !== event.pointerId) return;
    this.move(event);
    const mark = this.viewer.annotations.find(m => m.id === gesture.markId);
    if (mark?.kind === 'line' && gesture.moving === undefined && !gesture.selectionOnly) {
      const i = mark.points.length - 1;
      const previousControl = mark.controls.at(-1)!;
      const originalControl = gesture.before.marks.find(m => m.id === mark.id)?.controls.at(-1) ?? 0;
      if (previousControl > originalControl && previousControl !== i && this.nearPoint(mark.points[previousControl], ...this.screen(mark.points[i]), 18)) mark.controls.pop();
      if (!mark.controls.includes(i)) mark.controls.push(i);
    }
    this.gesture = undefined;
    if (mark?.kind === 'line' && gesture.changed) this.smooth(mark);
    if(mark?.kind === 'line' && gesture.dragged && gesture.moving===undefined) this.finishLine();
    if (gesture.changed) this.remember(gesture.before);
    this.sync();
  }
  private cancelGesture(): void {
    if (!this.gesture) return; const before = this.gesture.before; this.gesture = undefined; this.restore(before);
  }
  /** Sample the visible surface along the input trajectory, refusing gaps and large jumps. */
  private segment(start: Vec3, x: number, y: number): Hit[] | null {
    if (!this.viewer.surfacePointVisible(start, this.target)) { this.status = '上一端点被遮挡，请调整视角后继续'; return null; }
    const a = this.viewer.projectSurface(start), distance = Math.hypot(a.x-x, a.y-y);
    const count = Math.max(1, Math.ceil(distance / 3)); if (count > 600) return null;
    const hits: Hit[] = []; let previous = start;
    const maxJump = this.viewer.surfaceScale(this.target) * 0.06;
    for (let i = 1; i <= count; i++) {
      const hit = this.viewer.pickSurface(a.x + (x-a.x)*i/count, a.y + (y-a.y)*i/count, this.target);
      if (!hit || Math.hypot(...hit.point.map((v,j) => v-previous[j])) > maxJump) { this.status = '路径离开了表面，请补一个更近的点'; return null; }
      hits.push(hit); previous = hit.point;
    }
    return hits;
  }
  private append(mark: SurfaceAnnotation, x: number, y: number): void {
    const last = mark.points.at(-1)!; const p = this.viewer.projectSurface(last);
    if (Math.hypot(p.x-x,p.y-y) < 2) return;
    const hits = this.segment(last, x, y); if (!hits) return;
    if (mark.points.length + hits.length > 4096 || this.viewer.annotations.reduce((n,m) => n+m.points.length,0) + hits.length > 16384) {
      this.status = '这条路径已达到长度上限，请结束后新建'; return;
    }
    for (const hit of hits) {
      mark.points.push(hit.point); mark.normals.push(hit.normal);
      if (mark.points.length - 1 - mark.controls.at(-1)! >= 12) mark.controls.push(mark.points.length-1);
    }
  }
  private moveControl(mark: SurfaceAnnotation, original: SurfaceAnnotation, index: number, hit: Hit): boolean {
    if (mark.closed && (index === 0 || index === original.points.length-1)) { this.status = '闭合端点请先打开线，再移动'; return false; }
    const controls = [...original.controls]; if (!controls.includes(index)) { controls.push(index); controls.sort((a,b)=>a-b); }
    const slot = controls.indexOf(index), left = controls[Math.max(0,slot-1)], right = controls[Math.min(controls.length-1,slot+1)];
    const leftHits = slot > 0 ? this.segment(original.points[left], ...this.screen(hit.point)) : [];
    const rightHits = slot < controls.length-1 ? this.segment(hit.point, ...this.screen(original.points[right])) : [];
    if (!leftHits || !rightHits) return false;
    const middle: Hit[] = [...(slot > 0 ? [{point: original.points[left], normal: original.normals[left]}, ...leftHits] : [hit]), ...rightHits];
    const delta = middle.length - (right-left+1);
    if (original.points.length + delta > 4096 || this.viewer.annotations.reduce((n,m) => n + (m.id === mark.id ? original.points.length + delta : m.points.length), 0) > 16384) return false;
    mark.points = [...original.points.slice(0,left), ...middle.map(h=>h.point), ...original.points.slice(right+1)];
    mark.normals = [...original.normals.slice(0,left), ...middle.map(h=>h.normal), ...original.normals.slice(right+1)];
    mark.controls = controls.map(i => i < left ? i : i === index ? left + (slot > 0 ? leftHits.length : 0) : i >= right ? i+delta : i);
    return true;
  }
  private screen(point: Vec3): [number,number] { const p=this.viewer.projectSurface(point); return [p.x,p.y]; }
  private closeLine(): void {
    const mark = this.current; if (!mark || mark.kind !== 'line') return;
    if (mark.closed) { this.remember(); const end = mark.controls.at(-2)!; mark.points.length = end + 1; mark.normals.length = end + 1; mark.controls.pop(); mark.closed = false; this.sync(); return; }
    if (mark.controls.length < 3) { this.callbacks.toast('至少三个控制点才能闭合'); return; }
    const before = this.snapshot(); const hits = this.segment(mark.points.at(-1)!, ...this.screen(mark.points[0]));
    if (!hits || mark.points.length + hits.length > 4096 || this.viewer.annotations.reduce((n,m) => n+m.points.length,0) + hits.length > 16384) { this.callbacks.toast(this.status); return; }
    hits[hits.length-1] = {point: [...mark.points[0]], normal: [...mark.normals[0]]};
    mark.points.push(...hits.map(h=>h.point)); mark.normals.push(...hits.map(h=>h.normal));
    mark.controls.push(mark.points.length-1); mark.closed = true; this.draft = undefined; this.smooth(mark); this.remember(before); this.sync();
  }
  /** A centripetal curve through editing handles, resampled onto the same visible surface.
   * Commit only when every sample remains valid. Saved scenes never run this fitting step. */
  private smooth(mark: SurfaceAnnotation): void {
    const indices = mark.closed ? mark.controls.slice(0,-1) : mark.controls;
    if (indices.length < 3 || indices.some(i => !this.viewer.surfacePointVisible(mark.points[i], mark.mesh))) return;
    const anchors = indices.map(i => ({point: mark.points[i], normal: mark.normals[i]}));
    const screen = anchors.map(a => { const p = this.viewer.projectSurface(a.point); return new Vector3(p.x,p.y,0); });
    const curve = new CatmullRomCurve3(screen,mark.closed,'centripetal');
    const segments = mark.closed ? anchors.length : anchors.length-1;
    const hits: Hit[] = [anchors[0]], controls = [0];
    const maxJump = this.viewer.surfaceScale(mark.mesh) * 0.06;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment+1)%anchors.length;
      const count = Math.max(2,Math.ceil(screen[segment].distanceTo(screen[next])/2));
      for (let i = 1; i <= count; i++) {
        const p = curve.getPoint((segment+i/count)/segments);
        const hit = i === count ? anchors[next] : this.viewer.pickSurface(p.x,p.y,mark.mesh);
        if (!hit || Math.hypot(...hit.point.map((v,j)=>v-hits.at(-1)!.point[j])) > maxJump || hits.length >= 4096) return;
        hits.push(hit);
      }
      controls.push(hits.length-1);
    }
    if (this.viewer.annotations.reduce((n,m)=>n+(m.id===mark.id?hits.length:m.points.length),0)>16384) return;
    mark.points = hits.map(h=>h.point); mark.normals = hits.map(h=>h.normal); mark.controls = controls;
  }
  private visibleMarks(): SurfaceAnnotation[] { return this.viewer.annotations.filter(m=>this.viewer.modelInfos[m.mesh]?.visible && this.viewer.modelInfos[m.mesh]?.opacity>0); }
  refreshList(): void {
    const container = this.el('#surface-items'); container.replaceChildren();
    const marks=this.visibleMarks(), strokes=this.markup.exportStrokes();
    this.updateLayout();
    if (!marks.length && !strokes.length) { const p = document.createElement('p'); p.textContent = '点、线和画笔都收在这里。点选条目，在画布中查看。'; container.append(p); }
    const row=(number:number,label:string,color:string,kind:string,selected:boolean,click:()=>void)=> {
      const item=document.createElement('div');item.className='surface-list-row';item.classList.toggle('selected',selected);
      const button=document.createElement('button');button.type='button';button.setAttribute('aria-pressed',String(selected));
      const badge=document.createElement('i');badge.textContent=String(number);badge.style.setProperty('--ink',color);
      const name=document.createElement('span');name.textContent=label;const detail=document.createElement('small');detail.textContent=kind;
      button.append(badge,name,detail);button.addEventListener('click',click);item.append(button);container.append(item);return item;
    };
    marks.forEach((mark,i)=> {
      const item=row(i+1,mark.label||'未命名标记',mark.color,mark.kind==='point'?'点':mark.closed?'闭合线':'线',mark.id===this.selected,()=>void this.enter(mark.id));
      item.addEventListener('pointerenter',()=> {this.hovered=mark.id;this.viewer.setAnnotations(this.viewer.annotations,mark.id);});
      item.addEventListener('pointerleave',()=> {this.hovered=undefined;this.viewer.setAnnotations(this.viewer.annotations,this.selected);});
      const toggle=document.createElement('button');toggle.type='button';toggle.className='surface-visibility';toggle.innerHTML=icon(mark.visible?'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>':'<path d="m3 3 18 18M9 5a10 10 0 0 1 3 0c6 0 10 7 10 7a20 20 0 0 1-4 4M6 6a20 20 0 0 0-4 6s4 7 10 7a10 10 0 0 0 5-1"/>');
      toggle.setAttribute('aria-label',`${mark.visible?'隐藏':'显示'} ${mark.label}`);toggle.setAttribute('aria-pressed',String(mark.visible));
      toggle.addEventListener('click',()=> {this.remember();mark.visible=!mark.visible;this.sync();});item.append(toggle);
    });
    strokes.forEach((stroke,i)=>row(marks.length+i+1,stroke.label || `画笔 ${i+1}`,stroke.color,'屏幕',i===this.selectedScreen,()=>this.selectScreen(i)));
  }
  private selectScreen(index: number): void {
    const stroke=this.markup.exportStrokes()[index]; if(!stroke)return;
    void this.enter();this.finishLine();this.selected=undefined;this.selectedScreen=index;
    this.color=stroke.color;this.mode='select';this.sync();
  }
  private renderBadges(): void {
    const retained = new Set<string>();
    const width=window.innerWidth,height=window.innerHeight,viewport=`${width}:${height}`;
    if(viewport!==this.badgeViewport) {
      this.badgeViewport=viewport;this.badgeObstacles=null;
      for(const view of this.badgeElements.values()){view.width=0;view.offset=undefined;}
    }
    if(!this.badgeObstacles) this.badgeObstacles=Array.from(document.querySelectorAll<HTMLElement>('[data-label-obstacle]')).filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const occupied=this.badgeObstacles.slice();
    const touchPadding=matchMedia('(pointer: coarse)').matches ? 9 : 0;
    // Keep names away from editing handles so pointer drags reach the surface.
    if(this.active && this.current)for(const i of this.current.controls){const p=this.viewer.projectSurface(this.current.points[i]);if(p.visible)occupied.push({x:p.x-14,y:p.y-14,width:28,height:28});}
    const badge=(key:string,x:number,y:number,label:string,color:string,selected:boolean,click:()=>void)=> {
      retained.add(key);
      let view=this.badgeElements.get(key);
      if(!view) {
        const button=document.createElement('button');button.type='button';button.className='surface-badge';
        const line=document.createElementNS(SVG_NS,'line');line.classList.add('surface-badge-leader');
        button.addEventListener('click',click);view={button,line,width:0,height:0};
        this.badgeElements.set(key,view);this.badges.append(button);this.badgeLeaders.append(line);
      }
      const el=view.button;
      el.classList.toggle('selected',selected);
      el.style.setProperty('--ink',color);
      if(el.textContent!==label){el.textContent=label;view.width=0;view.offset=undefined;}
      if(!view.width){view.width=el.offsetWidth;view.height=el.offsetHeight;}
      const {rect,offset}=layoutLabel({width,height,labelWidth:view.width+touchPadding*2,labelHeight:view.height+touchPadding*2,x,y,occupied,maxLeaderLength:180},view.offset);
      view.offset=offset;occupied.push({x:rect.x-4,y:rect.y-4,width:rect.width+8,height:rect.height+8});
      rect.x+=touchPadding;rect.y+=touchPadding;rect.width=view.width;rect.height=view.height;
      el.style.transform=`translate3d(${rect.x}px,${rect.y}px,0)`;
      view.line.setAttribute('x1',String(x));view.line.setAttribute('y1',String(y));
      view.line.setAttribute('x2',String(clamp(x,rect.x,rect.x+rect.width)));
      view.line.setAttribute('y2',String(clamp(y,rect.y,rect.y+rect.height)));
      view.line.style.setProperty('--ink',color);
      el.title=label;el.setAttribute('aria-label',`编辑 ${label}`);
      // Drawing must still reach the surface beneath an existing label.
      el.disabled=this.busy;
      el.style.pointerEvents=this.active && this.mode!=='select' ? 'none' : 'auto';
    };
    this.visibleMarks().forEach(mark=> {
      if(!mark.visible)return;
      const count=mark.points.length;
      const candidates=[Math.floor(count/2),0,count-1,Math.floor(count/4),Math.floor(count*3/4)];
      const point=[...new Set(candidates)].map(i=>mark.points[i]).find(p=>p && this.viewer.surfacePointVisible(p,mark.mesh));
      if(!point)return;
      const p=this.viewer.projectSurface(point);
      badge(mark.id,p.x,p.y,mark.label||'未命名标记',mark.color,mark.id===(this.hovered??this.selected),()=>void this.enter(mark.id));
    });
    this.markup.exportStrokes().forEach((stroke,index)=> {
      const points=this.markup.displayPoints(index),p=points[Math.floor(points.length/2)];
      if(p)badge(`screen:${index}`,p[0],p[1],stroke.label || `画笔 ${index+1}`,stroke.color,index===this.selectedScreen,()=>this.selectScreen(index));
    });
    for(const [key,view] of this.badgeElements)if(!retained.has(key)){view.button.remove();view.line.remove();this.badgeElements.delete(key);}
  }
  private sync(refresh = true): void {
    this.panel.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=this.busy);
    this.el<HTMLInputElement>('#surface-name').disabled=this.busy;
    this.list.inert=this.busy;
    const share=this.el<HTMLButtonElement>('#share-view');if(!share.classList.contains('working'))share.disabled=this.busy;
    this.input.hidden = !this.active || this.mode==='select' || this.mode==='screen';
    this.input.style.cursor=this.mode==='select'?'default':'crosshair';
    this.markup.setEnabled(this.active && this.mode==='screen'); this.markup.setColor(this.color);
    this.markup.setSelection(this.active?this.selectedScreen:undefined);
    if (this.active) this.viewer.setInteractionEnabled(this.mode==='select' && !this.busy && this.selectionPointer===undefined && !this.cancelledPointers.size);
    this.viewer.setAnnotations(this.viewer.annotations, this.active ? this.selected : undefined);
    const hint = this.mode==='select' ? '拖动旋转 · 双指移动与缩放 · 点选标记编辑' : this.mode==='screen' ? '屏幕画笔 · 松手成一笔，改变视角后隐藏' : this.mode === 'point' ? '点按可见表面落点 · 拖动微调' : this.draft ? '继续点按连线，或点「完成线」' : '沿表面拖画，松手成线 · 也可逐点连线';
    this.el('#surface-hint').textContent = this.status || hint;
    this.el<HTMLButtonElement>('#surface-undo').disabled = !this.history.length || this.busy;
    this.el<HTMLButtonElement>('#surface-redo').disabled = !this.future.length || this.busy;
    this.el('#brush-tool').setAttribute('aria-pressed',String(this.active));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-mode]').forEach(button => { const on=button.dataset.surfaceMode === this.mode; button.classList.toggle('active',on); button.setAttribute('aria-pressed',String(on)); button.disabled=this.busy; });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-color]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.surfaceColor === (this.current?.color ?? this.color))));
    const selected = this.current;
    this.el('.surface-selection').hidden = !selected && this.selectedScreen===undefined;
    const input=this.el<HTMLInputElement>('#surface-name');input.readOnly=!selected && this.selectedScreen===undefined;
    if(document.activeElement!==input) input.value=selected?.label??this.markup.exportStrokes()[this.selectedScreen ?? -1]?.label??`画笔 ${(this.selectedScreen??0)+1}`;
    this.el('#surface-close').hidden = selected?.kind !== 'line';
    this.el('#surface-close').textContent = selected?.closed ? '打开' : '闭合';
    this.el('#surface-end').hidden = !this.draft;
    if (refresh) { this.refreshList(); this.callbacks.change(); }
    requestAnimationFrame(()=>this.updateLayout());
  }
}
