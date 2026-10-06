import type {ContentMark, ContentState, NativeContent} from './content-surface';
import {validateContentState} from './content-reading';
import {OperationError} from './operations/core';

const svgNS = 'http://www.w3.org/2000/svg';
const copy = (marks: readonly ContentMark[]): ContentMark[] => marks.map(mark => ({...mark, anchors: mark.anchors.map(anchor => ({...anchor}))}));
function action(label: string, run: () => void): HTMLButtonElement {
  const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.onclick = run; return element;
}
/** Content anchors are source scoped; this is deliberately independent of screen ink. */
export class ContentAnnotations {
  readonly tools = document.createElement('section');
  readonly overlay = document.createElementNS(svgNS, 'svg');
  private readonly status = document.createElement('p');
  private readonly list = document.createElement('div');
  private readonly label = document.createElement('input');
  private readonly color = document.createElement('input');
  private readonly modes: HTMLButtonElement[] = [];
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly past: ContentMark[][] = [];
  private readonly future: ContentMark[][] = [];
  private selected?: string;
  private enabled = false;
  private kind: 'point' | 'line' = 'point';
  private pending?: ContentMark;
  private cursor?: {x: number; y: number};
  private frame = 0;
  private readonly resize: ResizeObserver;
  private readonly mutation: MutationObserver;
  get active(): boolean { return this.enabled; }
  constructor(private readonly native: NativeContent, private readonly state: ContentState, private readonly body: HTMLElement, private readonly changed: () => void, private readonly transact: (mutation: () => void) => void = mutation => mutation()) {
    validateContentState(state);
    this.overlay.classList.add('content-marks'); this.overlay.setAttribute('aria-hidden', 'true'); body.append(this.overlay);
    this.tools.className = 'content-annotation-tools'; this.tools.hidden = true; this.tools.setAttribute('aria-label', '内容标注');
    const modes = document.createElement('div'); modes.className = 'content-tool-row';
    for (const [kind, label] of [['point', '点'], ['line', '线']] as const) {
      const button = action(label, () => { this.setTool(kind); this.native.scroll.focus({preventScroll: true}); });
      button.setAttribute('aria-pressed', String(this.kind === kind)); modes.append(button); this.modes.push(button);
    }
    modes.append(action('完成标注', () => this.close()));
    this.status.className = 'content-mark-status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.label.type = 'text'; this.label.placeholder = '标注名称'; this.label.setAttribute('aria-label', '标注名称'); this.label.maxLength = 120;
    this.label.addEventListener('change', () => this.editSelected());
    this.color.type = 'color'; this.color.value = '#ff6b5e'; this.color.setAttribute('aria-label', '标注颜色'); this.color.addEventListener('change', () => this.editSelected());
    const fields = document.createElement('div'); fields.className = 'content-tool-row'; fields.append(this.label, this.color);
    this.deleteButton = action('删除', () => { if (this.selected) this.remove(this.selected); });
    this.undoButton = action('撤销', () => this.undo()); this.redoButton = action('重做', () => this.redo());
    const history = document.createElement('div'); history.className = 'content-tool-row'; history.append(this.deleteButton, this.undoButton, this.redoButton);
    this.list.className = 'content-mark-list'; this.list.setAttribute('aria-label', '已有内容标注');
    this.tools.append(modes, fields, history, this.status, this.list);
    native.scroll.addEventListener('scroll', this.schedule, {passive: true}); native.scroll.addEventListener('keydown', this.keydown);
    this.resize = new ResizeObserver(this.schedule); this.resize.observe(native.scroll); this.resize.observe(body);
    this.mutation = new MutationObserver(this.schedule); this.mutation.observe(native.scroll, {subtree: true, childList: true, attributes: true, characterData: true});
    this.refreshTools(); this.schedule();
  }
  open(): void {
    this.enabled = true; this.tools.hidden = false; this.native.setSelection(false);
    this.cursor = {x: this.native.scroll.clientWidth / 2, y: this.native.scroll.clientHeight / 2};
    this.updateModes(); this.schedule(); this.changed();
  }
  close(): void {
    const changed = this.enabled || !!this.pending;
    this.enabled = false; this.tools.hidden = true; this.pending = undefined; this.cursor = undefined; this.schedule();
    if (changed) this.changed();
  }
  cancel(): void { if (!this.pending) return; this.pending = undefined; this.schedule(); this.changed(); }
  begin(x: number, y: number): void {
    const anchor = this.native.hit(x, y); if (!anchor) return;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    this.pending = {id, label: this.label.value.trim() || `标注 ${(this.state.marks?.length ?? 0) + 1}`, color: this.color.value, kind: this.kind, anchors: [anchor]};
    if (this.kind === 'line') this.pending.anchors.push(anchor);
    this.cursor = {x, y}; this.schedule();
  }
  move(x: number, y: number): void {
    this.cursor = {x, y};
    if (this.pending?.kind === 'line') { const anchor = this.native.hit(x, y); if (anchor && anchor.source === this.pending.anchors[0].source) this.pending.anchors[1] = anchor; }
    this.schedule();
  }
  end(): void {
    const mark = this.pending; this.pending = undefined;
    if (mark) {
      const selected = this.selected; this.selected = mark.id;
      if (!this.commit([...(this.state.marks ?? []), mark])) { this.selected = selected; this.refreshTools(); }
    }
    this.schedule();
  }
  refresh(): void { this.refreshTools(); this.schedule(); }
  get toolbarState() { return {active: this.enabled, kind: this.kind, selected: this.selected ?? null, label: this.label.value, color: this.color.value, canUndo: !!this.past.length, canRedo: !!this.future.length}; }
  setTool(kind: 'point' | 'line', label?: string, color?: string): void {
    if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new OperationError('INVALID_ARGUMENT', 'Expected hex color', {field: 'color'});
    this.kind = kind; this.pending = undefined;
    if (label !== undefined) this.label.value = label;
    if (color !== undefined) this.color.value = color;
    this.updateModes(); this.changed();
  }
  create(mark: Omit<ContentMark, 'id'>): ContentMark {
    const value = {...mark, id: crypto.randomUUID(), anchors: mark.anchors.map(anchor => ({...anchor}))};
    try { validateContentState({...this.state, marks: [...(this.state.marks ?? []), value]}); }
    catch (error) { throw new OperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)); }
    if (!value.anchors.every(anchor => this.native.acceptsAnchor?.(anchor) ?? !!this.native.locate(anchor))) throw new OperationError('INVALID_ARGUMENT', 'Anchor does not belong to available source content', {field: 'anchors'});
    this.selected = value.id;
    if (!this.commit([...(this.state.marks ?? []), value])) throw new OperationError('INVALID_ARGUMENT', 'Invalid content annotation');
    this.refreshTools(); return structuredClone(value);
  }
  select(id: string): void {
    const mark = this.state.marks?.find(mark => mark.id === id);
    if (!mark) throw new OperationError('INVALID_ARGUMENT', 'Unknown content annotation', {target: id});
    this.transact(() => { this.selected = id; this.native.restore(mark.anchors[0]); this.changed(); this.refreshTools(); this.schedule(); });
  }
  edit(id: string, changes: {label?: string; color?: string}): void {
    if (!this.state.marks?.some(mark => mark.id === id)) throw new OperationError('INVALID_ARGUMENT', 'Unknown content annotation', {target: id});
    const marks = this.state.marks.map(mark => mark.id === id ? {...mark, ...changes} : mark);
    if (!this.commit(marks)) throw new OperationError('INVALID_ARGUMENT', 'Invalid content annotation');
  }
  remove(id: string): void {
    if (!this.state.marks?.some(mark => mark.id === id)) throw new OperationError('INVALID_ARGUMENT', 'Unknown content annotation', {target: id});
    const marks = this.state.marks.filter(mark => mark.id !== id);
    try { validateContentState({...this.state, marks}); }
    catch (error) { throw new OperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)); }
    if (this.selected === id) this.selected = undefined;
    if (!this.commit(marks)) throw new OperationError('INVALID_ARGUMENT', 'Invalid content annotations');
    this.refreshTools();
  }
  clear(): void {
    if (!this.state.marks?.length) return;
    try { validateContentState({...this.state, marks: []}); }
    catch (error) { throw new OperationError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)); }
    this.selected = undefined; this.commit([]); this.refreshTools();
  }
  undo(): void { this.history(this.past, this.future); }
  redo(): void { this.history(this.future, this.past); }
  private updateModes(): void {
    this.modes[0].setAttribute('aria-pressed', String(this.kind === 'point')); this.modes[1].setAttribute('aria-pressed', String(this.kind === 'line'));
    this.status.textContent = this.kind === 'point' ? '点击内容放置点。键盘方向键定位，Enter 放置。' : '拖动内容绘制线。键盘方向键定位，Enter 设置起点和终点。';
  }
  private editSelected(): void {
    if (!this.selected) return;
    try { this.edit(this.selected, {label: this.label.value.trim() || this.state.marks?.find(mark => mark.id === this.selected)?.label, color: this.color.value}); }
    catch (error) { if (!(error instanceof OperationError)) throw error; }
  }
  private accepts(marks: ContentMark[]): boolean {
    try { validateContentState({...this.state, marks}); return true; }
    catch (error) {
      this.refreshTools();
      this.status.textContent = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
  private commit(marks: ContentMark[]): boolean {
    if (!this.accepts(marks)) return false;
    this.past.push(copy(this.state.marks ?? [])); if (this.past.length > 50) this.past.shift(); this.future.length = 0;
    this.state.marks = marks; this.changed(); this.refreshTools(); this.schedule();
    this.status.textContent = '';
    return true;
  }
  private history(from: ContentMark[][], to: ContentMark[][]): void {
    const marks = from.at(-1); if (!marks || !this.accepts(marks)) return;
    from.pop(); to.push(copy(this.state.marks ?? [])); this.state.marks = marks;
    if (!marks.some(mark => mark.id === this.selected)) this.selected = undefined;
    this.changed(); this.refreshTools(); this.schedule();
    this.status.textContent = '';
  }
  private refreshTools(): void {
    this.undoButton.disabled = !this.past.length; this.redoButton.disabled = !this.future.length; this.deleteButton.disabled = !this.selected;
    const selected = this.state.marks?.find(mark => mark.id === this.selected);
    if (selected) { this.label.value = selected.label; this.color.value = selected.color; }
    this.list.replaceChildren();
    for (const mark of this.state.marks ?? []) {
      // The adapter refuses anchors from other source revisions. Never project them approximately.
      const valid = mark.anchors.length > 0 && mark.anchors.every(anchor => !!this.native.locate(anchor));
      const item = action(mark.label, () => {
        // restore performs source checking before resolving lazy JSON targets.
        this.select(mark.id);
      });
      item.setAttribute('aria-pressed', String(mark.id === this.selected)); item.dataset.locatable = String(valid);
      if (!valid) item.title = '源内容已变化或目标当前不可见';
      this.list.append(item);
    }
  }
  private keydown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.target instanceof Element && event.target.closest('input, textarea, button, a, summary, select')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
    const cursor = this.cursor ?? {x: this.native.scroll.clientWidth / 2, y: this.native.scroll.clientHeight / 2};
    const step = event.shiftKey ? 40 : 8;
    const directions: Record<string, readonly [number, number]> = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]};
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault(); event.stopPropagation(); this.move(Math.max(0, Math.min(this.native.scroll.clientWidth - 1, cursor.x + direction[0])), Math.max(0, Math.min(this.native.scroll.clientHeight - 1, cursor.y + direction[1])));
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); if (this.pending) this.end(); else { this.begin(cursor.x, cursor.y); if (this.kind === 'point') this.end(); }
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation(); if (event.shiftKey) this.redo(); else this.undo();
    }
  };
  private schedule = (): void => { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); }); };
  private draw(): void {
    const scroll = this.native.scroll;
    const scale = parseFloat(getComputedStyle(this.body).getPropertyValue('--content-ui-scale')) || 1;
    // Both are in the same CSS3D plane, so offset geometry is invariant under camera transforms.
    let left = 0, top = 0;
    let node: HTMLElement | null = scroll;
    while (node && node !== this.body) { left += node.offsetLeft; top += node.offsetTop; node = node.offsetParent as HTMLElement | null; }
    this.overlay.style.left = `${left}px`; this.overlay.style.top = `${top}px`;
    this.overlay.style.width = `${scroll.clientWidth}px`; this.overlay.style.height = `${scroll.clientHeight}px`;
    this.overlay.setAttribute('viewBox', `0 0 ${scroll.clientWidth} ${scroll.clientHeight}`); this.overlay.replaceChildren();
    for (const mark of [...(this.state.marks ?? []), ...(this.pending ? [this.pending] : [])]) {
      const anchors = mark.anchors.map(anchor => this.native.locate(anchor));
      if (!anchors.length || anchors.some(anchor => !anchor)) continue;
      const points = anchors as {x: number; y: number}[];
      const group = document.createElementNS(svgNS, 'g'); group.setAttribute('stroke', mark.color); group.setAttribute('fill', mark.color);
      if (mark.kind === 'line') { const line = document.createElementNS(svgNS, 'polyline'); line.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke-width', String(3 * scale)); group.append(line); }
      for (const point of points) { const dot = document.createElementNS(svgNS, 'circle'); dot.setAttribute('cx', String(point.x)); dot.setAttribute('cy', String(point.y)); dot.setAttribute('r', String((mark.id === this.selected ? 6 : 4) * scale)); group.append(dot); }
      const title = document.createElementNS(svgNS, 'title'); title.textContent = mark.label; group.append(title);
      const text = document.createElementNS(svgNS, 'text'); text.setAttribute('x', String(points[0].x + 10 * scale)); text.setAttribute('y', String(points[0].y - 8 * scale)); text.textContent = mark.label; text.setAttribute('stroke', 'none'); group.append(text); this.overlay.append(group);
    }
    if (this.enabled && this.cursor) {
      const cursor = document.createElementNS(svgNS, 'path'); const {x, y} = this.cursor;
      cursor.setAttribute('d', `M${x-8*scale},${y}h${16*scale}M${x},${y-8*scale}v${16*scale}`); cursor.setAttribute('stroke', 'currentColor'); cursor.setAttribute('stroke-width', String(1.5 * scale)); this.overlay.append(cursor);
    }
  }
  dispose(): void { if (this.frame) cancelAnimationFrame(this.frame); this.resize.disconnect(); this.mutation.disconnect(); this.native.scroll.removeEventListener('scroll', this.schedule); this.native.scroll.removeEventListener('keydown', this.keydown); this.overlay.remove(); this.tools.remove(); }
}
