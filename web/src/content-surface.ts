export interface ContentAnchor {
  source: string;
  target: string;
  offset: number;
  x: number;
  y: number;
  viewport?: [number, number];
}
export interface ContentMark {
  id: string;
  label: string;
  color: string;
  kind: 'point' | 'line';
  anchors: ContentAnchor[];
}
export interface ContentState {
  presentation?: 'spatial' | 'focus' | 'fullscreen';
  reading?: ContentAnchor;
  selection?: boolean;
  zoom?: number;
  expanded?: string[];
  layer?: string;
  marks?: ContentMark[];
}
export interface NativeContent {
  readonly scroll: HTMLElement;
  capture(): ContentAnchor | undefined;
  restore(anchor: ContentAnchor): void;
  hit(x: number, y: number): ContentAnchor | undefined;
  locate(anchor: ContentAnchor): {x: number; y: number} | undefined;
  setSelection(enabled: boolean): void;
  zoom?(factor: number): void;
  layers?: readonly {id: string; label: string}[];
  setLayer?(id: string): void;
}
