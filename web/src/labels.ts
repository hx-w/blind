import * as THREE from 'three';
import type { MeshLabelGroup, PublicMesh } from './api';
import { clamp, layoutLabel, type LabelOffset, overlapArea, type Rect } from './label-layout';

interface LabelModel { info: PublicMesh; bounds: THREE.Box3 }
interface LabelView { text: HTMLSpanElement; line: SVGPathElement; dot: SVGCircleElement; offset?: LabelOffset; width: number; height: number }
interface GroupView { text: HTMLButtonElement; frame: SVGPathElement; width: number; height: number }
const svgNS = 'http://www.w3.org/2000/svg';

/** Screen-sized labels attached to world-space Mesh bounds, independent of camera zoom. */
export class MeshLabels {
  private readonly layer = document.createElement('div');
  private readonly leaders = document.createElementNS(svgNS, 'svg');
  private readonly foreground = document.createElement('div');
  private readonly frontLeaders = document.createElementNS(svgNS, 'svg');
  private readonly views = new Map<number, LabelView>();
  private readonly groupViews = new Map<number, GroupView>();
  private viewport = '';
  // Root-relative rects of the UI chrome labels must avoid. Measured only
  // after an invalidation, never per frame.
  private obstacles: Rect[] | null = null;

  constructor(private readonly root: HTMLElement, private readonly focusGroup: (meshes: number[], animate: boolean) => void) {
    this.layer.className = 'mesh-label-layer';
    this.layer.setAttribute('aria-label', 'Mesh 标注');
    this.leaders.setAttribute('aria-hidden', 'true');
    this.layer.append(this.leaders);
    this.foreground.className = 'mesh-label-layer mesh-label-foreground';
    this.frontLeaders.setAttribute('aria-hidden', 'true');
    this.foreground.append(this.frontLeaders);
    root.append(this.layer, this.foreground);
  }

  // Label sizes and obstacle rects depend on the same layout state as the
  // placement offsets, so they drop their caches here too.
  invalidateLayout(): void {
    for (const view of this.views.values()) { view.offset = undefined; view.width = 0; view.height = 0; }
    for (const view of this.groupViews.values()) { view.width = 0; view.height = 0; }
    this.obstacles = null;
  }

  render(models: LabelModel[], groups: MeshLabelGroup[], camera: THREE.Camera, selected: number): void {
    const hasMeshLabel = models.some(model => model.info.visible && model.info.label);
    if (this.views.size === 0 && this.groupViews.size === 0 && !hasMeshLabel && groups.length === 0) return;
    const width = this.root.clientWidth, height = this.root.clientHeight;
    const viewport = `${width}:${height}`;
    if (viewport !== this.viewport) {
      this.viewport = viewport;
      this.leaders.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.frontLeaders.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.invalidateLayout();
    }
    if (!this.obstacles) this.obstacles = this.measureObstacles();
    // Placement mutates the occupied set; the cache stays untouched.
    const occupied = this.obstacles.slice();
    const activeGroups = new Set<number>();
    const active = new Set<number>();
    for (const view of this.groupViews.values()) { view.text.hidden = true; view.frame.style.display = 'none'; }
    for (const view of this.views.values()) {
      view.text.hidden = true; view.line.style.display = 'none'; view.dot.style.display = 'none';
    }

    const grouped = new Set(groups.filter(group => group.text.trim()).flatMap(group => group.meshes));
    const renderMesh = (index: number): void => {
      const { info, bounds } = models[index];
      if (!info.label?.text.trim()) return;
      active.add(index);
      if (!info.visible || info.opacity <= 0 || bounds.isEmpty()) return;
      // A group caption already identifies its members. Expand only the selection.
      if (index !== selected && grouped.has(index)) return;
      const point = info.label.anchor
        ? new THREE.Vector3(...info.label.anchor)
        : bounds.getCenter(new THREE.Vector3());
      point.project(camera);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)
        || point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return;
      let view = this.views.get(index);
      if (!view) {
        view = { text: document.createElement('span'), line: document.createElementNS(svgNS, 'path'), dot: document.createElementNS(svgNS, 'circle'), width: 0, height: 0 };
        view.text.className = 'mesh-label'; view.line.classList.add('mesh-label-leader'); view.dot.classList.add('mesh-label-anchor');
        view.dot.setAttribute('r', '3');
        this.layer.append(view.text);
        this.leaders.append(view.line, view.dot);
        this.views.set(index, view);
      }
      view.text.hidden = false;
      view.line.style.display = ''; view.dot.style.display = '';
      const group = groups.find(group => group.meshes.includes(index));
      const text = memberCaption(info.label.text, group?.text);
      view.text.title = info.label.text;
      if (view.text.textContent !== text) { view.text.textContent = text; view.offset = undefined; view.width = 0; }
      // offsetWidth forces a synchronous reflow, so measure only when the
      // text or the viewport changed rather than on every rendered frame.
      if (!view.width) {
        view.text.style.maxWidth = '';
        // A side panel can leave a very narrow canvas on landscape phones.
        // Widen long labels before placement so wrapping does not clip them.
        if (view.text.offsetHeight > height - 16) view.text.style.maxWidth = `${Math.max(1, width - 16)}px`;
        view.width = view.text.offsetWidth; view.height = view.text.offsetHeight;
      }
      const w = view.width, h = view.height;
      view.text.classList.toggle('selected', index === selected);
      this.setLayer(index === selected, view.text, view.line, view.dot);
      view.text.style.setProperty('--mesh-color', info.color);
      view.dot.style.setProperty('--mesh-color', info.color);
      const x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
      const { rect: placement, offset } = layoutLabel({ width, height, labelWidth: w, labelHeight: h, x, y, occupied }, view.offset);
      view.offset = offset;
      if (index !== selected && occupied.some(other => overlapArea(placement, other) > 0)) {
        view.text.hidden = true; view.line.style.display = 'none'; view.dot.style.display = 'none';
        return;
      }
      occupied.push({ x: placement.x - 6, y: placement.y - 6, width: w + 12, height: h + 12 });
      view.text.style.transform = `translate(${placement.x}px, ${placement.y}px)`;
      const endX = clamp(x, placement.x, placement.x + w);
      const endY = clamp(y, placement.y, placement.y + h);
      view.line.setAttribute('d', `M ${x} ${y} L ${endX} ${endY}`);
      view.dot.setAttribute('cx', String(x)); view.dot.setAttribute('cy', String(y));
    };
    if (models[selected]) renderMesh(selected);
    const groupOrder = groups.map((_, index) => index).sort((a, b) => Number(groups[b].meshes.includes(selected)) - Number(groups[a].meshes.includes(selected)));
    groupOrder.forEach(index => {
      const group = groups[index];
      if (!group.text.trim()) return;
      activeGroups.add(index);
      const worldBounds = new THREE.Box3();
      for (const member of group.meshes) {
        const model = models[member];
        if (model?.info.visible && model.info.opacity > 0) worldBounds.union(model.bounds);
      }
      const bounds = projectBounds(worldBounds, camera, width, height);
      if (!bounds) return;
      const frame = insetViewport(expandRect(bounds, 10), width, height);
      let view = this.groupViews.get(index);
      if (!view) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'mesh-group-label';
        const path = document.createElementNS(svgNS, 'path'); path.classList.add('mesh-group-frame');
        button.addEventListener('pointerenter', () => path.classList.add('hover'));
        button.addEventListener('pointerleave', () => path.classList.remove('hover'));
        this.layer.append(button); this.leaders.append(path);
        view = { text: button, frame: path, width: 0, height: 0 };
        this.groupViews.set(index, view);
      }
      view.text.onclick = (event) => this.focusGroup(group.meshes, event.detail !== 0);
      view.text.hidden = false; view.frame.style.display = '';
      const count = group.meshes.length;
      const signature = `${group.text}\u0000${count}`;
      if (view.text.dataset.signature !== signature) {
        const name = document.createElement('span'); name.textContent = group.text;
        const total = document.createElement('small'); total.textContent = String(count); total.setAttribute('aria-hidden', 'true');
        view.text.replaceChildren(name, total); view.text.dataset.signature = signature; view.width = 0; view.height = 0;
      }
      view.text.setAttribute('aria-label', `聚焦标注 ${group.text}，${count} 个 Mesh`);
      const maxWidth = `${Math.min(240, width - 16, Math.max(88, frame.width - 16))}px`;
      if (view.text.style.maxWidth !== maxWidth) { view.text.style.maxWidth = maxWidth; view.width = 0; }
      if (!view.width) { view.width = view.text.offsetWidth; view.height = view.text.offsetHeight; }
      const color = averageColor(group.meshes.map(member => models[member]?.info.color).filter((value): value is string => Boolean(value)));
      const isSelected = group.meshes.includes(selected);
      // Selection promotes only the caption, not the group frame or siblings.
      this.setLayer(isSelected, view.text);
      if (view.frame.parentNode !== this.leaders) this.leaders.append(view.frame);
      view.text.classList.toggle('selected', isSelected); view.frame.classList.toggle('selected', isSelected);
      view.text.style.setProperty('--group-color', color); view.frame.style.setProperty('--group-color', color);
      const placement = placeGroupLabel(frame, view.width, view.height, occupied, width, height);
      if (occupied.some(other => overlapArea(placement, other) > 0)) {
        view.text.hidden = true; view.frame.style.display = 'none'; return;
      }
      occupied.push({ x: placement.x - 5, y: placement.y - 5, width: view.width + 10, height: view.height + 10 });
      view.text.style.transform = `translate(${placement.x}px, ${placement.y}px)`;
      view.frame.setAttribute('d', captionFramePath(frame, placement));
    });
    models.forEach((_, index) => { if (index !== selected) renderMesh(index); });
    for (const [index, view] of this.groupViews) {
      if (activeGroups.has(index)) continue;
      view.text.remove(); view.frame.remove(); this.groupViews.delete(index);
    }
    for (const [index, view] of this.views) {
      if (active.has(index)) continue;
      view.text.remove(); view.line.remove(); view.dot.remove(); this.views.delete(index);
    }
  }

  private setLayer(selected: boolean, text: HTMLElement, ...marks: SVGElement[]): void {
    const layer = selected ? this.foreground : this.layer;
    const leaders = selected ? this.frontLeaders : this.leaders;
    if (text.parentElement !== layer) layer.append(text);
    for (const mark of marks) if (mark.parentNode !== leaders) leaders.append(mark);
  }

  // The transparent canvas receives pointer input above ordinary labels.
  // Delegate only where rendered geometry leaves the group label visible.
  focusAt(x: number, y: number, covered: () => boolean): boolean {
    for (const view of this.groupViews.values()) {
      if (view.text.hidden) continue;
      const rect = view.text.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        if (covered()) return false;
        view.text.dispatchEvent(new MouseEvent('click', { detail: 1 }));
        return true;
      }
    }
    return false;
  }

  private measureObstacles(): Rect[] {
    // Keep labels clear of the viewer's existing controls and message panel.
    const origin = this.root.getBoundingClientRect();
    const rects: Rect[] = [];
    document.querySelectorAll<HTMLElement>('[data-label-obstacle]').forEach((element) => {
      if (!element.getClientRects().length) return;
      const r = element.getBoundingClientRect();
      rects.push({ x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height });
    });
    return rects;
  }
}

function projectBounds(bounds: THREE.Box3, camera: THREE.Camera, width: number, height: number): Rect | null {
  if (bounds.isEmpty()) return null;
  const point = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, samples = 0;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    point.set(x, y, z).project(camera);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.z < -1 || point.z > 1) continue;
    const px = (point.x + 1) * width / 2, py = (1 - point.y) * height / 2;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py); samples += 1;
  }
  return samples > 0 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
}

function expandRect(rect: Rect, amount: number): Rect {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function insetViewport(rect: Rect, width: number, height: number): Rect {
  const x = clamp(rect.x, 8, width - 8), y = clamp(rect.y, 8, height - 8);
  return { x, y, width: Math.max(0, clamp(rect.x + rect.width, 8, width - 8) - x), height: Math.max(0, clamp(rect.y + rect.height, 8, height - 8) - y) };
}

function placeGroupLabel(frame: Rect, width: number, height: number, occupied: Rect[], viewportWidth: number, viewportHeight: number): Rect {
  const candidates = [
    { x: frame.x + 4, y: frame.y - height / 2 },
    { x: frame.x + frame.width - width - 4, y: frame.y - height / 2 },
    { x: frame.x + 4, y: frame.y + frame.height - height / 2 },
    { x: frame.x + frame.width - width - 4, y: frame.y + frame.height - height / 2 },
  ].map(point => ({ x: clamp(point.x, 8, viewportWidth - width - 8), y: clamp(point.y, 8, viewportHeight - height - 8), width, height }));
  return candidates.reduce((best, candidate) => scoreOverlap(candidate, occupied) < scoreOverlap(best, occupied) ? candidate : best);
}

function scoreOverlap(rect: Rect, occupied: Rect[]): number {
  return occupied.reduce((sum, other) => sum + Math.max(0, Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x))
    * Math.max(0, Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y)), 0);
}

function captionFramePath(rect: Rect, caption: Rect): string {
  const x2 = rect.x + rect.width, y2 = rect.y + rect.height;
  const length = Math.min(14, rect.width / 4, rect.height / 4);
  const bottom = Math.abs(caption.y + caption.height / 2 - y2) < Math.abs(caption.y + caption.height / 2 - rect.y);
  const y = bottom ? y2 : rect.y, direction = bottom ? -1 : 1;
  const left = clamp(caption.x - 4, rect.x, x2), right = clamp(caption.x + caption.width + 4, rect.x, x2);
  // The caption interrupts the frame edge itself; there is no detached callout.
  return `M ${rect.x} ${y + direction * length} V ${y} H ${left} M ${right} ${y} H ${x2} V ${y + direction * length}`
    + (bottom
      ? ` M ${rect.x} ${rect.y + length} V ${rect.y} H ${rect.x + length} M ${x2 - length} ${rect.y} H ${x2} V ${rect.y + length}`
      : ` M ${rect.x} ${y2 - length} V ${y2} H ${rect.x + length} M ${x2 - length} ${y2} H ${x2} V ${y2 - length}`);
}

function memberCaption(text: string, group?: string): string {
  if (!group || !text.startsWith(group)) return text;
  const suffix = text.slice(group.length);
  return /^\s*[/·:|]\s*\S/.test(suffix) ? suffix.replace(/^\s*[/·:|]\s*/, '') : text;
}

function averageColor(colors: string[]): string {
  if (colors.length === 0) return '#8fa9c9';
  const total = colors.reduce((rgb, color) => {
    const value = Number.parseInt(color.slice(1), 16);
    rgb[0] += value >> 16; rgb[1] += value >> 8 & 255; rgb[2] += value & 255;
    return rgb;
  }, [0, 0, 0]);
  return `rgb(${total.map(value => Math.round(value / colors.length)).join(' ')})`;
}
