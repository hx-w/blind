export interface Rect { x: number; y: number; width: number; height: number }
export interface LabelOffset { x: number; y: number }
interface LayoutInput {
  width: number; height: number; labelWidth: number; labelHeight: number;
  x: number; y: number; silhouette: Rect | null; silhouettes: (Rect | null)[]; occupied: Rect[];
}

export function layoutLabel(input: LayoutInput, previous?: LabelOffset): { rect: Rect; offset: LabelOffset } {
  const { width, height, labelWidth: w, labelHeight: h, x, y, silhouette, silhouettes, occupied } = input;
  const place = (left: number, top: number): Rect => ({ x: clamp(left, 8, width - w - 8), y: clamp(top, 8, height - h - 8), width: w, height: h });
  // Camera motion only reprojects the anchor. Re-scoring symmetric candidates
  // on every frame makes tiny floating-point changes flip labels across a Mesh.
  if (previous) return { rect: place(x + previous.x, y + previous.y), offset: previous };
  const side = x < width / 2 ? -1 : 1;
  const candidates: Rect[] = [];
  for (const direction of [side, -side]) {
    const inside = x + (direction > 0 ? 36 : -36 - w);
    const lefts = silhouette
      ? [direction > 0 ? silhouette.x + silhouette.width + 12 : silhouette.x - w - 12, inside]
      : [inside];
    for (const dy of [-36 - h, 24, -h / 2, -80 - h, 68, -124 - h, 112]) {
      for (const left of lefts) candidates.push(place(left, y + dy));
    }
  }
  const score = (r: Rect): number => occupied.reduce((sum, other) => sum + overlap(r, other), 0) * 100
    + silhouettes.reduce((sum, other) => sum + (other ? overlap(r, other) : 0), 0)
    + Math.hypot(r.x + w / 2 - x, r.y + h / 2 - y);
  let rect = candidates[0];
  let best = score(rect);
  for (const candidate of candidates) {
    const next = score(candidate);
    if (next < best) { rect = candidate; best = next; }
  }
  return { rect, offset: { x: rect.x - x, y: rect.y - y } };
}

export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
