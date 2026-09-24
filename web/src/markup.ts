import type { ScreenStroke } from './api';
import ink from '../../shaders/stroke.json';

const MAX_STROKES = 64;
const MAX_STROKE_POINTS = 512;
const MAX_POINTS = 4_096;
const SAMPLE_DISTANCE_PX = 1.25;

interface ActiveStroke extends ScreenStroke {
  pointerId: number;
}

export class MarkupCanvas {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private strokes: ScreenStroke[] = [];
  private active: ActiveStroke | null = null;
  private enabled = false;
  private selection?: number;
  private color = '#ff6b5e';
  private cssWidth = 1;
  private cssHeight = 1;
  private boundsLeft = 0;
  private boundsTop = 0;
  private drawFrame = 0;

  onChange?: () => void;
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
  onActiveChange?: (active: boolean) => void;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.active) this.finishActive();
      this.resize();
    });
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    canvas.addEventListener('pointerdown', this.pointerDown);
    // pointerrawupdate reports at full input rate; pointermove coalesces per
    // frame and only exists as the fallback for browsers without rawupdate.
    if ('onpointerrawupdate' in window) {
      canvas.addEventListener('pointerrawupdate', this.pointerMove as EventListener);
    } else {
      canvas.addEventListener('pointermove', this.pointerMove);
    }
    canvas.addEventListener('pointerup', this.pointerUp);
    canvas.addEventListener('pointercancel', this.pointerCancel);
    canvas.addEventListener('lostpointercapture', this.pointerCancel);
    this.resize();
  }

  get isEnabled(): boolean { return this.enabled; }
  get hasStrokes(): boolean { return this.strokes.length > 0; }

  load(strokes: ScreenStroke[]): void {
    this.cancelActive();
    this.strokes = structuredClone(strokes);
    this.scheduleDraw();
    this.onChange?.();
  }

  exportStrokes(): ScreenStroke[] { return structuredClone(this.strokes); }

  displayPoints(index: number): Array<[number, number]> {
    const stroke = this.strokes[index]; if (!stroke) return [];
    const bounds = this.canvas.getBoundingClientRect();
    const aspect = this.cssWidth / this.cssHeight;
    return stroke.points.map(p => [bounds.left + ((p[0]*2-1)*stroke.aspect/aspect+1)*this.cssWidth/2, bounds.top+p[1]*this.cssHeight]);
  }
  hitTest(x: number, y: number): number | undefined {
    for (let i=this.strokes.length-1;i>=0;i--) {
      const points=this.displayPoints(i);
      for (let j=1;j<points.length;j++) {
        const a=points[j-1],b=points[j],dx=b[0]-a[0],dy=b[1]-a[1];
        const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)));
        if(Math.hypot(x-a[0]-dx*t,y-a[1]-dy*t)<14) return i;
      }
    }
    return undefined;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    if (!enabled) this.finishActive();
    this.enabled = enabled;
    this.canvas.classList.toggle('enabled', enabled);
    this.canvas.setAttribute('aria-hidden', String(!enabled));
  }

  setSelection(index?: number): void { if(this.selection===index)return;this.selection=index;this.scheduleDraw(); }

  setColor(color: string): void { this.color = color; }

  clear(): void {
    this.cancelActive();
    if (this.strokes.length === 0) return;
    this.strokes = [];
    this.changed();
  }

  finishActive(): void {
    const active = this.active;
    if (!active) return;
    this.releaseActivePointer();
    const available = Math.max(MAX_POINTS - pointCount(this.strokes), 0);
    if (active.points.length >= 2 && active.points.length <= available && this.strokes.length < MAX_STROKES) {
      this.strokes.push({ color: active.color, aspect: active.aspect, points: active.points });
      this.changed();
    } else {
      this.scheduleDraw();
    }
    this.onStrokeEnd?.();
  }

  private cancelActive(): void {
    if (!this.active) return;
    this.releaseActivePointer();
    this.scheduleDraw();
  }

  private releaseActivePointer(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.onActiveChange?.(false);
    if (this.canvas.hasPointerCapture(active.pointerId)) {
      this.canvas.releasePointerCapture(active.pointerId);
    }
  }

  private changed(): void {
    this.scheduleDraw();
    this.onChange?.();
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.isPrimary || this.active) {
      this.finishActive();
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.strokes.length >= MAX_STROKES || pointCount(this.strokes) >= MAX_POINTS) return;
    // Pointer capture keeps every later event flowing here, so one layout
    // read per gesture is enough for all its samples.
    const bounds = this.canvas.getBoundingClientRect();
    this.boundsLeft = bounds.left; this.boundsTop = bounds.top;
    const point = this.normalizedPoint(event);
    this.onStrokeStart?.();
    this.active = {
      pointerId: event.pointerId,
      color: this.color,
      aspect: this.cssWidth / Math.max(this.cssHeight, 1),
      points: [point],
    };
    this.canvas.setPointerCapture(event.pointerId);
    this.onActiveChange?.(true);
    this.scheduleDraw();
  };

  private pointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    this.appendEventSamples(event);
    this.scheduleDraw();
  };

  private pointerUp = (event: PointerEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    this.appendEventSamples(event);
    this.finishActive();
  };

  private pointerCancel = (event: PointerEvent): void => {
    if (!this.active || event.pointerId !== this.active.pointerId) return;
    this.finishActive();
  };

  private appendEventSamples(event: PointerEvent): void {
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced) this.appendPoint(this.normalizedPoint(sample));
    this.appendPoint(this.normalizedPoint(event));
  }

  private appendPoint(point: [number, number]): void {
    const active = this.active;
    if (!active) return;
    const previous = active.points.at(-1)!;
    const distance = Math.hypot(
      (point[0] - previous[0]) * this.cssWidth,
      (point[1] - previous[1]) * this.cssHeight,
    );
    if (distance < SAMPLE_DISTANCE_PX) return;
    if (active.points.length >= MAX_STROKE_POINTS) {
      const committedPoints = pointCount(this.strokes);
      if (this.strokes.length >= MAX_STROKES - 1 || committedPoints + active.points.length >= MAX_POINTS) return;
      this.strokes.push({ color: active.color, aspect: active.aspect, points: active.points });
      active.points = [previous];
      this.onChange?.();
    }
    if (pointCount(this.strokes) + active.points.length < MAX_POINTS) active.points.push(point);
  }

  private normalizedPoint(event: PointerEvent): [number, number] {
    return [
      clamp((event.clientX - this.boundsLeft) / this.cssWidth, 0, 1),
      clamp((event.clientY - this.boundsTop) / this.cssHeight, 0, 1),
    ];
  }

  private resize(): void {
    const host = this.canvas.parentElement ?? this.canvas;
    this.cssWidth = Math.max(host.clientWidth, 1);
    this.cssHeight = Math.max(host.clientHeight, 1);
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    if (this.drawFrame) return;
    this.drawFrame = requestAnimationFrame(() => {
      this.drawFrame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const context = this.context;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);
    const width = Math.round(this.cssWidth * pixelRatio); const height = Math.round(this.cssHeight * pixelRatio);
    // Keep the old frame until its resized replacement can be drawn.
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    for (const [i,stroke] of this.strokes.entries()) this.drawStroke(stroke, i===this.selection);
    if (this.active) {
      this.drawStroke({
        color: this.active.color,
        aspect: this.active.aspect,
        points: this.active.points,
      });
    }
  }

  private drawStroke(stroke: ScreenStroke, selected=false): void {
    if (stroke.points.length === 0) return;
    const context = this.context;
    const currentAspect = this.cssWidth / Math.max(this.cssHeight, 1);
    const path = new Path2D();
    const displayPoints = stroke.points.map((point) => [
      (((point[0] * 2 - 1) * stroke.aspect / currentAspect + 1) * 0.5) * this.cssWidth,
      point[1] * this.cssHeight,
    ] as [number, number]);
    traceSmoothPath(path, displayPoints);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if(selected) {context.strokeStyle='rgba(244,242,234,.55)';context.lineWidth=ink.ink_width+4;context.stroke(path);}
    context.strokeStyle = `rgba(${ink.outline_color.join(',')},${ink.outline_alpha})`;
    context.lineWidth = ink.outline_width;
    context.stroke(path);
    context.strokeStyle = stroke.color;
    context.lineWidth = ink.ink_width;
    context.stroke(path);
  }
}

function pointCount(strokes: ScreenStroke[]): number {
  return strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
}

function traceSmoothPath(path: Path2D, points: Array<[number, number]>): void {
  const first = points[0];
  if (!first) return;
  path.moveTo(first[0], first[1]);
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    path.quadraticCurveTo(
      point[0],
      point[1],
      (point[0] + next[0]) * 0.5,
      (point[1] + next[1]) * 0.5,
    );
  }
  const last = points.at(-1)!;
  path.lineTo(last[0], last[1]);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
