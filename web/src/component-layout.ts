/** Pack flat groups in reading order. Pick a column count that fits the actual viewport. */
export function packGroups(sizes: readonly (readonly [number, number])[], aspect: number, gap = 32): [number, number][] {
  if (!sizes.length) return [];
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  let best: {score:number; points:[number,number][]} | undefined;
  for (let columns = 1; columns <= sizes.length; columns++) {
    const points: [number,number][] = []; let top = 0, width = 0;
    for (let start = 0; start < sizes.length; start += columns) {
      const row = sizes.slice(start, start + columns); const height = Math.max(...row.map(size => size[1])); let x = 0;
      for (const [w,h] of row) {points.push([x + w / 2, -top - h / 2]); x += w + gap;}
      width = Math.max(width, x - gap); top += height + gap;
    }
    const score = Math.min(ratio / Math.max(1,width), 1 / Math.max(1,top-gap));
    if (!best || score > best.score) best = {score,points};
  }
  return best!.points;
}

/** Fixed panes retain their preferred heights; only automatic panes share spare space. */
export function panelHeights(preferred: readonly (number | null | undefined)[], available: number, gap: number): {min: number; max: number; heights: number[]} {
  const max = Math.max(0, available), min = Math.min(240, max);
  let fixed = 0, automatic = 0;
  const heights = preferred.map(height => {
    if (height == null) { automatic++; return 0; }
    const bounded = Math.min(max, Math.max(min, height)); fixed += bounded; return bounded;
  });
  const share = automatic ? Math.max(min, (max - Math.max(0, preferred.length - 1) * gap - fixed) / automatic) : 0;
  for (let index = 0; index < preferred.length; index++) if (preferred[index] == null) heights[index] = share;
  return {min, max, heights};
}
