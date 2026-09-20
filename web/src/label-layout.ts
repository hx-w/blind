export interface Rect { x: number; y: number; width: number; height: number }
export interface LabelOffset { x: number; y: number }
interface LayoutInput {
  width: number; height: number; labelWidth: number; labelHeight: number;
  x: number; y: number; occupied: Rect[]; maxLeaderLength?: number;
}

export const MAX_LEADER_LENGTH = 72;

export function layoutLabel(input: LayoutInput, previous?: LabelOffset): { rect: Rect; offset: LabelOffset } {
  const { width, height, labelWidth: w, labelHeight: h, x, y, occupied, maxLeaderLength = MAX_LEADER_LENGTH } = input;
  const place = (left: number, top: number): Rect => ({ x: clamp(left, 8, width - w - 8), y: clamp(top, 8, height - h - 8), width: w, height: h });
  const distance = (r: Rect): number => Math.hypot(x - clamp(x, r.x, r.x + w), y - clamp(y, r.y, r.y + h));
  // Camera motion only reprojects the anchor. Re-scoring symmetric candidates
  // on every frame makes tiny floating-point changes flip labels across a Mesh.
  if (previous) {
    const rect = place(x + previous.x, y + previous.y);
    if (distance(rect) <= maxLeaderLength && occupied.every(other => overlapArea(rect, other) === 0)) return { rect, offset: previous };
  }
  const side = x < width / 2 ? -1 : 1;
  const candidates: Rect[] = [];
  for (const direction of [side, -side]) {
    // Meshes cover ordinary labels. Do not chase a projected bounding box
    // across the viewport just to keep a label clear of geometry.
    for (const gap of [18, 36]) {
      const left = x + (direction > 0 ? gap : -gap - w);
      const rows = [-h / 2, -h - 12, 12, -h - 36, 36];
      if (maxLeaderLength > MAX_LEADER_LENGTH) for (let shift = h + 48; shift < maxLeaderLength; shift += h + 8) rows.push(-shift, shift);
      for (const dy of rows) candidates.push(place(left, y + dy));
    }
  }
  const score = (r: Rect): number => occupied.reduce((sum, other) => sum + overlapArea(r, other), 0) * 100
    + distance(r);
  let rect = candidates[0];
  let best = score(rect);
  for (const candidate of candidates) {
    if (distance(candidate) > maxLeaderLength) continue;
    const next = score(candidate);
    if (next < best) { rect = candidate; best = next; }
  }
  return { rect, offset: { x: rect.x - x, y: rect.y - y } };
}

export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
export function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
