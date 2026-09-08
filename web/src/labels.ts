import * as THREE from 'three';
import type { PublicMesh } from './api';
import { clamp, layoutLabel, type LabelOffset, type Rect } from './label-layout';

interface LabelModel { info: PublicMesh; bounds: THREE.Box3 }
interface LabelView { text: HTMLSpanElement; line: SVGPathElement; dot: SVGCircleElement; offset?: LabelOffset; width: number; height: number }
const svgNS = 'http://www.w3.org/2000/svg';

/** Screen-sized labels attached to world-space points, independent of camera zoom. */
export class MeshLabels {
  private readonly layer = document.createElement('div');
  private readonly leaders = document.createElementNS(svgNS, 'svg');
  private readonly views = new Map<number, LabelView>();
  private viewport = '';
  // Root-relative rects of the UI chrome labels must avoid. Measured only
  // after an invalidation, never per frame.
  private obstacles: Rect[] | null = null;

  constructor(private readonly root: HTMLElement) {
    this.layer.className = 'mesh-label-layer';
    this.layer.setAttribute('aria-label', 'Mesh 标注');
    this.leaders.setAttribute('aria-hidden', 'true');
    this.layer.append(this.leaders);
    root.append(this.layer);
  }

  // Label sizes and obstacle rects depend on the same layout state as the
  // placement offsets, so they drop their caches here too.
  invalidateLayout(): void {
    for (const view of this.views.values()) { view.offset = undefined; view.width = 0; view.height = 0; }
    this.obstacles = null;
  }

  render(models: LabelModel[], camera: THREE.Camera, selected: number): void {
    if (this.views.size === 0 && !models.some(model => model.info.visible && model.info.label)) return;
    const width = this.root.clientWidth, height = this.root.clientHeight;
    const viewport = `${width}:${height}`;
    if (viewport !== this.viewport) {
      this.viewport = viewport;
      this.leaders.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.invalidateLayout();
    }
    if (!this.obstacles) this.obstacles = this.measureObstacles();
    // Placement mutates the occupied set; the cache stays untouched.
    const occupied = this.obstacles.slice();
    const silhouettes = models.map(({ info, bounds }) => info.visible ? projectBounds(bounds, camera, width, height) : null);
    const active = new Set<number>();
    for (const view of this.views.values()) {
      view.text.hidden = true; view.line.style.display = 'none'; view.dot.style.display = 'none';
    }
    models.forEach(({ info, bounds }, index) => {
      if (!info.label?.text.trim()) return;
      active.add(index);
      if (!info.visible || bounds.isEmpty()) return;
      const point = info.label.anchor
        ? new THREE.Vector3(...info.label.anchor)
        : bounds.getCenter(new THREE.Vector3());
      point.project(camera);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)
        || point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return;
      let view = this.views.get(index);
      if (!view) {
        view = { text: document.createElement('span'), line: document.createElementNS(svgNS, 'path'), dot: document.createElementNS(svgNS, 'circle'), width: 0, height: 0 };
        view.text.className = 'mesh-label';
        view.dot.setAttribute('r', '3');
        this.layer.append(view.text);
        this.leaders.append(view.line, view.dot);
        this.views.set(index, view);
      }
      view.text.hidden = false;
      view.line.style.display = ''; view.dot.style.display = '';
      if (view.text.textContent !== info.label.text) { view.text.textContent = info.label.text; view.offset = undefined; view.width = 0; }
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
      view.text.style.setProperty('--mesh-color', info.color);
      view.dot.style.setProperty('--mesh-color', info.color);
      const x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
      const { rect: placement, offset } = layoutLabel({ width, height, labelWidth: w, labelHeight: h, x, y, silhouette: silhouettes[index], silhouettes, occupied }, view.offset);
      view.offset = offset;
      occupied.push({ x: placement.x - 6, y: placement.y - 6, width: w + 12, height: h + 12 });
      view.text.style.transform = `translate(${placement.x}px, ${placement.y}px)`;
      const endX = clamp(x, placement.x, placement.x + w);
      const endY = clamp(y, placement.y, placement.y + h);
      view.line.setAttribute('d', `M ${x} ${y} L ${endX} ${endY}`);
      view.dot.setAttribute('cx', String(x)); view.dot.setAttribute('cy', String(y));
    });
    for (const [index, view] of this.views) {
      if (active.has(index)) continue;
      view.text.remove(); view.line.remove(); view.dot.remove(); this.views.delete(index);
    }
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    point.set(x, y, z).project(camera);
    if (point.z < -1 || point.z > 1) return null;
    const px = (point.x + 1) * width / 2, py = (1 - point.y) * height / 2;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
