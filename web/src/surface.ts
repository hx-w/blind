import type { SurfaceAnnotation, ScreenStroke, Vec3 } from './api';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { MeshViewer } from './viewer';
import type { MarkupCanvas } from './markup';
import { clamp, layoutLabel, type LabelOffset, type Rect } from './label-layout';
import {installIcons} from './icons';
import {AnnotationHistory, type AnnotationEditor, type AnnotationToolbarState} from './annotations/editor';
import {createAnnotationToolbar,ANNOTATION_COLORS as COLORS} from './annotations/toolbar';
import {validateColor,validateLabel,validateScreens,validateSurfaces} from './annotations/validation';
import {OperationError} from './operations/core';

type Hit = { point: Vec3; normal: Vec3 };
type Mode = 'select' | 'point' | 'line' | 'screen';
type Snapshot = { marks: SurfaceAnnotation[]; strokes: ScreenStroke[]; selected?: string; screen?: number; draft?: string };
type BadgeView = { button: HTMLButtonElement; line: SVGLineElement; width: number; height: number; offset?: LabelOffset };
const SVG_NS = 'http://www.w3.org/2000/svg';

export class SurfaceEditor implements AnnotationEditor {
  readonly surface={create:(input:Omit<SurfaceAnnotation,'id'|'mesh'> & {entityId:string})=>this.createSurface(input),edit:(id:string,patch:Partial<Pick<SurfaceAnnotation,'label'|'color'|'visible'|'points'|'normals'|'controls'|'closed'>>)=>this.editSurface(id,patch)};
  private readonly panel: HTMLElement;
  private readonly input: HTMLElement;
  private readonly list: HTMLElement;
  private readonly badges: HTMLElement;
  private mode: Mode = 'screen';
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
  private externalScreenMarkup = document.documentElement.classList.contains('embedded-scene');
  private listDismissed = false;
  private readonly badgeElements = new Map<string, BadgeView>();
  private readonly badgeLeaders = document.createElementNS(SVG_NS, 'svg');
  private badgeObstacles: Rect[] | null = null;
  private badgeViewport = '';
  private hovered?: string;
  private readonly timeline = new AnnotationHistory<Snapshot>();
  private readonly history = this.timeline.past;
  private readonly future = this.timeline.future;
  private screenBefore?: Snapshot;
  private gesture?: { id: number; before: Snapshot; x: number; y: number; moving?: number; markId?: string; selectionOnly?: boolean; changed: boolean; dragged?: boolean };
  private status = '';
  private pending?: {id:number; x:number; y:number; up:boolean; samples:Array<[number,number]>};
  private suspended?: {mode: Mode; selected?: string; screen?: number};

  constructor(private viewer: MeshViewer, private markup: MarkupCanvas, private shell: HTMLElement,
    private callbacks: { toast: (message: string) => void; change: () => void }) {
    this.input = document.createElement('div'); this.input.id = 'surface-input'; this.input.hidden = true;
    this.input.setAttribute('aria-label', '标记画布');
    document.querySelector('#viewer')!.append(this.input);
    this.badges = document.createElement('div'); this.badges.id = 'surface-badges';
    this.badgeLeaders.setAttribute('aria-hidden','true');this.badges.append(this.badgeLeaders);
    document.querySelector('#viewer')!.append(this.badges);
    this.panel = createAnnotationToolbar(true);
    shell.append(this.panel);
    this.list = document.createElement('section'); this.list.className = 'surface-list'; this.list.hidden = true;
    this.list.setAttribute('aria-label','标记列表'); this.list.setAttribute('data-label-obstacle','');
    this.list.innerHTML = '<div class="surface-list-heading"><strong>标记</strong><span>点选定位</span><button type="button" id="surface-list-close" aria-label="收起标记列表"><i data-lucide="x" aria-hidden="true"></i></button></div><div id="surface-items"></div>';
    installIcons(this.list);
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
    this.el('#surface-end').addEventListener('click', () => this.finish());
    this.el('#surface-close').addEventListener('click', () => {if(this.current){try{this.setClosed(this.current.id,!this.current.closed);}catch(error){this.callbacks.toast(error instanceof Error?error.message:String(error));}}});
    this.el('#surface-delete').addEventListener('click', () => this.remove());
    this.el('#surface-undo').addEventListener('click', () => this.undo());
    this.el('#surface-redo').addEventListener('click', () => this.redo());
    this.el<HTMLInputElement>('#surface-name').addEventListener('change', event => {
      const label=(event.target as HTMLInputElement).value.trim();
      if(this.current)this.editSurface(this.current.id,{label});
      else if(this.selectedScreen!==undefined)this.editScreen(this.markup.exportStrokes()[this.selectedScreen].id,{label});
    });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-mode]').forEach(button=>button.addEventListener('click',()=>this.setTool(button.dataset.surfaceMode as Mode)));
    this.panel.querySelectorAll<HTMLButtonElement>('[data-surface-color]').forEach(button=>button.addEventListener('click',()=>this.setColor(button.dataset.surfaceColor!)));
    this.markup.onStrokeStart=()=> { this.selected=undefined; this.selectedScreen=undefined; this.screenBefore=this.snapshot(); };
    this.markup.onStrokeEnd=()=> {
      if(this.screenBefore) {
        const strokes=this.markup.exportStrokes();
        if(strokes.length>this.screenBefore.strokes.length) {
          this.remember(this.screenBefore);
          this.selectedScreen=strokes.length-1;
        }
        this.screenBefore=undefined;
      }
      this.sync();
    };
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
      else if (event.code === 'Space' && !event.repeat) { event.preventDefault(); this.cancelGesture();this.setTool('select'); }
      else if (event.key === 'Enter') { event.preventDefault(); this.finish(); }
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
    const enoughSpace = (viewport?.width ?? window.innerWidth) >= 900 && height >= 600;
    this.badgeObstacles=null;this.viewer.refreshLabels();
    this.list.hidden = this.listDismissed || !enoughSpace || (!this.visibleMarks().length && !this.markup.hasStrokes);
  }
  private get current(): SurfaceAnnotation | undefined { return this.viewer.annotations.find(mark => mark.id === this.selected); }
  get isActive(): boolean { return this.active; }
  suspend(): void {
    if (!this.active) return;
    this.suspended = {mode: this.mode, selected: this.selected, screen: this.selectedScreen};
    this.exit();
  }
  resume(): void {
    const saved = this.suspended;
    if (!saved) return;
    this.suspended = undefined;
    void this.enter();
    this.mode = saved.mode; this.selected = saved.selected; this.selectedScreen = saved.screen;
    this.sync();
  }
  setExternalScreenMarkup(external: boolean): void { this.externalScreenMarkup=external; this.sync(); }
  async enter(id?: string): Promise<void> {
    if(id&&!this.viewer.annotations.some(m=>m.id===id))throw new OperationError('INVALID_ARGUMENT','Surface annotation not found',{target:id});
    if(this.active){if(id)this.selectMark(id);return;}
    this.active = true;
    if(id) this.selectMark(id);
    else { this.mode='screen'; this.selected=undefined; this.selectedScreen=undefined; this.status=''; }
    if (!document.documentElement.classList.contains('embedded-scene'))
      this.el('.surface-actions').append(this.el('#share-view'));
    this.panel.hidden = false; this.shell.classList.add('surface-mode');
    this.el('#gesture-hint').classList.add('dismissed'); this.sync();
  }
  load(): void {
    this.timeline.clear();this.selected=undefined;this.selectedScreen=undefined;this.draft=undefined;this.screenBefore=undefined;
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
    if(!this.active)return;
    this.markup.finishActive(); this.pending=undefined; this.cancelGesture(); this.finishLine(); this.active = false; this.selected = undefined; this.selectedScreen=undefined;
    if (this.panel.contains(this.el('#share-view')))
      this.el('.review-dock .dock-main').append(this.el('#share-view'));
    this.panel.hidden = true; this.input.hidden = true; this.shell.classList.remove('surface-mode');
    this.viewer.setInteractionEnabled(true); this.sync();
  }
  finishForShare(): void { this.markup.finishActive(); this.cancelGesture(); this.finishLine(); this.sync(); }
  invalidateScreenHistory(): void {
    this.markup.cancelActive(); this.screenBefore=undefined; this.selectedScreen=undefined;
    const signature = (snapshot: Snapshot) => JSON.stringify([snapshot.marks, snapshot.draft]);
    const current = JSON.stringify([this.viewer.annotations, this.draft]);
    for (const stack of [this.history, this.future]) {
      let nearest = current;
      for (let index = stack.length - 1; index >= 0; index--) {
        const snapshot = stack[index]; snapshot.strokes=[]; snapshot.screen=undefined;
        const value = signature(snapshot);
        if (value === nearest) stack.splice(index, 1);
        else nearest = value;
      }
    }
    this.sync();
  }
  private snapshot(): Snapshot { return { marks: structuredClone(this.viewer.annotations), strokes:this.markup.exportStrokes(), screen:this.selectedScreen, selected: this.selected, draft: this.draft }; }
  private async restore(snapshot: Snapshot,notify=true): Promise<boolean> {
    if(snapshot.marks.some(mark=>this.viewer.modelInfos[mark.mesh]?.revision!==mark.revision))throw new OperationError('CONFLICT','Annotation history refers to a changed source revision');
    const targets=[...new Set(snapshot.marks.map(mark=>mark.mesh))];
    const needsRaw=targets.filter(index=>this.viewer.modelInfos[index]?.quality!=='raw' || this.viewer.modelInfos[index]?.loadState!=='ready');
    if(needsRaw.length) {
      this.busy=true;this.status='正在恢复精细表面…';this.sync(false);
      try {for(const index of needsRaw) await this.viewer.setQuality(index,'raw');}
      catch {this.callbacks.toast('精细表面加载失败，未恢复标记');return false;}
      finally {this.busy=false;this.status='';this.sync(false);}
    }
    if(snapshot.marks.some(mark=>this.viewer.modelInfos[mark.mesh]?.revision!==mark.revision))throw new OperationError('CONFLICT','Source revision changed while restoring annotation history');
    if(targets.some(index=>this.viewer.modelInfos[index]?.quality!=='raw'||!this.viewer.hasSurface(index)))throw new OperationError('RESOURCE_UNAVAILABLE','Raw surface geometry is unavailable',{retryable:true});
    this.selected=snapshot.selected;this.selectedScreen=snapshot.screen;this.draft=snapshot.draft;
    const restored=snapshot.marks.find(mark=>mark.id===(snapshot.draft??snapshot.selected));
    if(restored) this.target=restored.mesh;
    if(this.draft) this.mode='line';
    this.viewer.setAnnotations(structuredClone(snapshot.marks));this.markup.load(snapshot.strokes);this.sync(notify);return true;
  }
  private remember(snapshot = this.snapshot()): void { this.timeline.remember(snapshot); }
  async undo(): Promise<void> { if(this.busy||this.markup.isDrawing)throw new OperationError('CONFLICT','Finish or cancel the active annotation first');this.cancelGesture();const previous=this.history.at(-1);if(!previous)return;const current=this.snapshot();if(await this.restore(previous,false)){this.history.pop();this.future.push(current);this.sync();}else throw new OperationError('RESOURCE_UNAVAILABLE','Raw geometry could not be restored',{retryable:true}); }
  async redo(): Promise<void> { if(this.busy||this.markup.isDrawing)throw new OperationError('CONFLICT','Finish or cancel the active annotation first');this.cancelGesture();const next=this.future.at(-1);if(!next)return;const current=this.snapshot();if(await this.restore(next,false)){this.future.pop();this.history.push(current);this.sync();}else throw new OperationError('RESOURCE_UNAVAILABLE','Raw geometry could not be restored',{retryable:true}); }
  private remove(): void {
    const selected=this.toolbarState.selection;
    if(selected)this.removeAnnotation(selected.kind,selected.id);
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
      this.gesture = undefined;try{this.setClosed(current.id,true);}catch(error){this.callbacks.toast(error instanceof Error?error.message:String(error));}return;
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
      const toggle=document.createElement('button');toggle.type='button';toggle.className='surface-visibility';toggle.innerHTML=`<i data-lucide="${mark.visible ? 'eye' : 'eye-off'}" aria-hidden="true"></i>`;
      toggle.setAttribute('aria-label',`${mark.visible?'隐藏':'显示'} ${mark.label}`);toggle.setAttribute('aria-pressed',String(mark.visible));
      toggle.addEventListener('click',()=>this.editSurface(mark.id,{visible:!mark.visible}));item.append(toggle);
    });
    strokes.forEach((stroke,i)=>row(marks.length+i+1,stroke.label || `画笔 ${i+1}`,stroke.color,'屏幕',i===this.selectedScreen,()=>this.selectScreen(i)));
    installIcons(container);
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
      if(p)badge(`screen:${stroke.id}`,p[0],p[1],stroke.label || `画笔 ${index+1}`,stroke.color,index===this.selectedScreen,()=>this.select('screen',stroke.id));
    });
    for(const [key,view] of this.badgeElements)if(!retained.has(key)){view.button.remove();view.line.remove();this.badgeElements.delete(key);}
  }
  get toolbarState():AnnotationToolbarState {
    const mark=this.current,stroke=this.markup.exportStrokes()[this.selectedScreen??-1],busy=this.busy||this.markup.isDrawing;
    const hint=this.mode==='select'?'拖动旋转 · 双指移动与缩放 · 点选标记编辑':this.mode==='screen'?'屏幕画笔 · 松手成一笔，改变视角后隐藏':this.mode==='point'?'点按可见表面落点 · 拖动微调':this.draft?'继续点按连线，或点「完成线」':'沿表面拖画，松手成线 · 也可逐点连线';
    return {active:this.active,mode:this.mode,color:mark?.color??stroke?.color??this.color,selection:mark?{kind:'surface',id:mark.id}:stroke?{kind:'screen',id:stroke.id}:null,label:mark?.label??stroke?.label??'',canUndo:!!this.history.length&&!busy,canRedo:!!this.future.length&&!busy,canClose:mark?.kind==='line',closed:mark?.closed??false,canFinishLine:!!this.draft,busy,status:this.status||hint,supportsSurface:true};
  }
  surfaceAnnotations():SurfaceAnnotation[] {return structuredClone(this.viewer.annotations);}
  private assertIdle(includeScreen=true):void {if(this.busy||this.gesture||this.pending||(includeScreen&&this.markup.isDrawing))throw new OperationError('CONFLICT','Finish or cancel the active annotation gesture or wait for Raw loading');}
  setTool(mode:Mode):void {this.assertIdle(false);if(this.mode===mode)return;this.markup.finishActive();this.finishLine();this.selected=undefined;this.selectedScreen=undefined;this.mode=mode;this.status='';this.sync();}
  setColor(color:string):void {this.assertIdle();validateColor(color);this.color=color;const mark=this.current,stroke=this.markup.exportStrokes()[this.selectedScreen??-1];if(mark){this.editSurface(mark.id,{color});return;}if(stroke){this.editScreen(stroke.id,{color});return;}this.sync();}
  select(kind:'surface'|'screen',id:string):void {this.assertIdle();if(kind==='surface'){if(!this.viewer.annotations.some(m=>m.id===id))throw new OperationError('INVALID_ARGUMENT','Surface annotation not found',{target:id});this.selectMark(id);}else{const index=this.markup.exportStrokes().findIndex(s=>s.id===id);if(index<0)throw new OperationError('INVALID_ARGUMENT','Screen annotation not found',{target:id});this.selectScreen(index);}}
  createScreen(input:Omit<ScreenStroke,'id'>):ScreenStroke {this.assertIdle();const stroke={...structuredClone(input),id:crypto.randomUUID()},next=[...this.markup.exportStrokes(),stroke];validateScreens(next);this.remember();this.markup.load(next);this.selected=undefined;this.selectedScreen=next.length-1;this.sync();return structuredClone(stroke);}
  editScreen(id:string,patch:Partial<Omit<ScreenStroke,'id'>>):ScreenStroke {this.assertIdle();const next=this.markup.exportStrokes(),index=next.findIndex(s=>s.id===id);if(index<0)throw new OperationError('INVALID_ARGUMENT','Screen annotation not found',{target:id});const previous=JSON.stringify(next[index]);next[index]={...next[index],...structuredClone(patch)};validateScreens(next);if(JSON.stringify(next[index])===previous)return structuredClone(next[index]);this.remember();this.markup.load(next);this.sync();return structuredClone(next[index]);}
  async createSurface(input:Omit<SurfaceAnnotation,'id'|'mesh'> & {entityId:string}):Promise<SurfaceAnnotation> {
    if(this.draft)throw new OperationError('CONFLICT','Finish or cancel the current surface line draft first');
    this.assertIdle();const mesh=this.viewer.getMeshIndex(input.entityId);
    if(mesh===undefined)throw new OperationError('UNKNOWN_ENTITY','Mesh entity does not exist',{target:input.entityId});
    if(this.viewer.modelInfos[mesh]?.format==='pts')throw new OperationError('UNSUPPORTED','Point clouds have no annotatable surface',{target:input.entityId});
    if(!this.viewer.modelInfos[mesh])throw new OperationError('NOT_READY','Mesh metadata is not ready',{target:input.entityId,retryable:true});
    if(this.viewer.modelInfos[mesh].revision!==input.revision)throw new OperationError('CONFLICT','Source revision changed',{field:'revision',target:input.entityId});
    const {entityId:_,...data}=input,mark:SurfaceAnnotation={...structuredClone(data),mesh,id:crypto.randomUUID()};
    validateSurfaces([...this.viewer.annotations,mark]);
    if(this.viewer.modelInfos[mesh].quality!=='raw'||this.viewer.modelInfos[mesh].loadState!=='ready'){this.busy=true;this.sync(false);try{await this.viewer.setQuality(mesh,'raw');}catch{throw new OperationError('RESOURCE_UNAVAILABLE','Raw surface could not be loaded',{target:input.entityId,retryable:true});}finally{this.busy=false;this.sync(false);}}
    if(this.viewer.getMeshIndex(input.entityId)!==mesh||this.viewer.modelInfos[mesh]?.revision!==mark.revision)throw new OperationError('CONFLICT','Entity or source revision changed during Raw load',{field:'revision',target:input.entityId});
    if(this.viewer.modelInfos[mesh].quality!=='raw'||!this.viewer.hasSurface(mesh))throw new OperationError('RESOURCE_UNAVAILABLE','Raw surface geometry is unavailable',{target:input.entityId,retryable:true});
    validateSurfaces([...this.viewer.annotations,mark]);this.remember();this.viewer.setAnnotations([...this.viewer.annotations,mark]);this.selected=mark.id;this.selectedScreen=undefined;this.sync();return structuredClone(mark);
  }
  editSurface(id:string,patch:Partial<Pick<SurfaceAnnotation,'label'|'color'|'visible'|'points'|'normals'|'controls'|'closed'>>):SurfaceAnnotation {
    this.assertIdle();const index=this.viewer.annotations.findIndex(m=>m.id===id);if(index<0)throw new OperationError('INVALID_ARGUMENT','Surface annotation not found',{target:id});
    const next=structuredClone(this.viewer.annotations);next[index]={...next[index],...structuredClone(patch)};
    if(this.viewer.modelInfos[next[index].mesh]?.revision!==next[index].revision)throw new OperationError('CONFLICT','Source revision changed',{target:id});
    validateLabel(next[index].label);validateColor(next[index].color);
    const metadataOnly=patch.points===undefined&&patch.normals===undefined&&patch.controls===undefined&&patch.closed===undefined;
    validateSurfaces(metadataOnly?next.filter(m=>m.id!==this.draft):next);
    if(JSON.stringify(next[index])===JSON.stringify(this.viewer.annotations[index]))return structuredClone(next[index]);
    this.remember();this.viewer.setAnnotations(next);this.sync();return structuredClone(next[index]);
  }
  removeAnnotation(kind:'surface'|'screen',id:string):void {
    this.assertIdle();
    if(kind==='screen'){const strokes=this.markup.exportStrokes(),index=strokes.findIndex(s=>s.id===id);if(index<0)throw new OperationError('INVALID_ARGUMENT','Screen annotation not found',{target:id});this.remember();strokes.splice(index,1);this.markup.load(strokes);this.selectedScreen=undefined;}
    else{if(!this.viewer.annotations.some(m=>m.id===id))throw new OperationError('INVALID_ARGUMENT','Surface annotation not found',{target:id});this.remember();this.viewer.setAnnotations(this.viewer.annotations.filter(m=>m.id!==id));if(this.selected===id)this.selected=undefined;if(this.draft===id)this.draft=undefined;}this.sync();
  }
  clearAnnotations(kind?:'surface'|'screen'):void {this.assertIdle();if((kind==='screen'||!this.viewer.annotations.length)&&(kind==='surface'||!this.markup.hasStrokes))return;this.remember();if(kind!=='screen'){this.viewer.setAnnotations([]);this.selected=undefined;this.draft=undefined;}if(kind!=='surface'){this.markup.clear();this.selectedScreen=undefined;}this.sync();}
  finish():void {this.finishForShare();}
  cancel():void {this.pending=undefined;this.markup.cancelActive();if(this.screenBefore){this.markup.load(this.screenBefore.strokes);this.selectedScreen=this.screenBefore.screen;}this.screenBefore=undefined;this.cancelGesture();if(this.draft){const id=this.draft;this.viewer.setAnnotations(this.viewer.annotations.filter(m=>m.id!==id));this.draft=undefined;this.selected=undefined;}this.sync();}
  setClosed(id:string,closed:boolean):void {
    this.assertIdle();const mark=this.viewer.annotations.find(m=>m.id===id);
    if(!mark)throw new OperationError('INVALID_ARGUMENT','Surface annotation not found',{target:id});
    if(mark.kind!=='line')throw new OperationError('INVALID_ARGUMENT','Only a line can be closed',{target:id});
    if(mark.closed===closed)return;
    const next=structuredClone(mark);
    if(closed){
      if(mark.controls.length<3)throw new OperationError('INVALID_ARGUMENT','Closing requires three control points',{field:'closed'});
      const previousTarget=this.target,previousStatus=this.status;this.target=mark.mesh;
      const hits=this.segment(mark.points.at(-1)!,...this.screen(mark.points[0]));const failure=this.status;this.target=previousTarget;this.status=previousStatus;
      if(!hits)throw new OperationError('CONFLICT',failure||'Closing path cannot be sampled on the visible surface',{target:id});
      hits[hits.length-1]={point:[...mark.points[0]],normal:[...mark.normals[0]]};
      next.points.push(...hits.map(h=>h.point));next.normals.push(...hits.map(h=>h.normal));next.controls.push(next.points.length-1);next.closed=true;this.smooth(next);
    }else{const end=mark.controls.at(-2)!;next.points.length=end+1;next.normals.length=end+1;next.controls.pop();next.closed=false;}
    const marks=this.viewer.annotations.map(m=>m.id===id?next:m);validateSurfaces(marks);this.remember();this.viewer.setAnnotations(marks);this.draft=undefined;this.sync();
  }
  private sync(refresh = true): void {
    this.panel.querySelectorAll<HTMLButtonElement>('button:not(#share-view)').forEach(button=>button.disabled=this.busy);
    this.el<HTMLInputElement>('#surface-name').disabled=this.busy;
    this.list.inert=this.busy;
    const share=this.el<HTMLButtonElement>('#share-view');if(!share.classList.contains('working'))share.disabled=this.busy;
    this.input.hidden = !this.active || this.mode==='select' || this.mode==='screen';
    this.input.style.cursor=this.mode==='select'?'default':'crosshair';
    this.markup.setEnabled(this.active && this.mode==='screen' && !this.externalScreenMarkup); this.markup.setColor(this.color);
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
