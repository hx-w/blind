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
export interface ContentTarget { id: string; label: string; anchor: ContentAnchor }
export interface JsonBranch { path: string; expanded: boolean; loaded: number; total: number }
export interface NativeContent {
  readonly scroll: HTMLElement;
  capture(): ContentAnchor | undefined;
  restore(anchor: ContentAnchor): void;
  hit(x: number, y: number): ContentAnchor | undefined;
  locate(anchor: ContentAnchor): {x: number; y: number} | undefined;
  setSelection(enabled: boolean): void;
  catalogTargets?(): readonly ContentTarget[];
  readonly targetRange?: {prefix: string; count: number};
  acceptsAnchor?(anchor: ContentAnchor): boolean;
  fit?(): void;
  json?: {
    branches(): readonly JsonBranch[];
    setExpanded(path: string, expanded: boolean): void;
    page(path: string): void;
  };
  zoom?(factor: number): void;
  layers?: readonly {id: string; label: string}[];
  setLayer?(id: string): void;
}
