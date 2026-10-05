import {DIAGRAM_MAX_OUTPUT, DOT_TIMEOUT_MS} from './dot-work.ts';

type Job = {
  source: string;
  signal?: AbortSignal;
  resolve: (svg: string) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  worker?: Worker;
  timer?: number;
};
const MAX_PENDING = 8;
const pending: Job[] = [];
let active: Job | undefined;

function finish(job: Job, svg?: string, error?: unknown): void {
  if (active !== job && !pending.includes(job)) return;
  job.worker?.terminate();
  clearTimeout(job.timer);
  job.signal?.removeEventListener('abort', job.abort);
  if (active === job) active = undefined;
  else pending.splice(pending.indexOf(job), 1);
  if (error !== undefined) job.reject(error);
  else job.resolve(svg!);
  startNext();
}

function startNext(): void {
  if (active || !pending.length) return;
  const job = pending.shift()!;
  active = job;
  try {
    // Vite emits a same-origin bundled worker, including Viz's embedded WASM.
    const worker = job.worker = new Worker(new URL('./dot-worker.ts', import.meta.url), {type: 'module'});
    job.timer = setTimeout(() => finish(job, undefined, new Error('DOT 绘制超过 20 秒，已终止')), DOT_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{svg?: unknown; error?: unknown}>) => {
      const data = event.data;
      if (typeof data?.error === 'string') { finish(job, undefined, new Error(data.error)); return; }
      if (typeof data?.svg !== 'string' || new TextEncoder().encode(data.svg).byteLength > DIAGRAM_MAX_OUTPUT) {
        finish(job, undefined, new Error('DOT 返回无效或过大的 SVG')); return;
      }
      finish(job, data.svg);
    };
    worker.onerror = event => { event.preventDefault(); finish(job, undefined, new Error('DOT 绘制线程失败')); };
    worker.onmessageerror = () => finish(job, undefined, new Error('DOT 绘制线程通信失败'));
    worker.postMessage(job.source);
  } catch (error) { finish(job, undefined, error); }
}

/** One active WASM instance, eight waiting sources, and no workers left after settlement. */
export function renderDot(source: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024) return Promise.reject(new Error('图表源文件超过 2 MiB'));
  if (active && pending.length >= MAX_PENDING) return Promise.reject(new Error('DOT 绘制队列已满（最多等待 8 个图表）'));
  return new Promise((resolve, reject) => {
    const job: Job = {source, signal, resolve, reject, abort: () => finish(job, undefined, signal?.reason ?? new DOMException('已取消', 'AbortError'))};
    signal?.addEventListener('abort', job.abort, {once: true});
    pending.push(job);
    startNext();
  });
}
