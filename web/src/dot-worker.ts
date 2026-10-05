import {instance} from '@viz-js/viz';
import {checkDotWork, DIAGRAM_MAX_OUTPUT} from './dot-work';

// One render per worker: terminating it releases the WASM instance on success too.
self.onmessage = async (event: MessageEvent<string>) => {
  try {
    const source = event.data;
    if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024) {
      throw new Error('图表源文件超过 2 MiB');
    }
    // Viz's JSON API also runs layout. Bound expansion before even loading WASM.
    checkDotWork(source);
    const renderer = await instance();
    const svg = renderer.renderString(source, {format: 'svg', engine: 'dot'});
    if (new TextEncoder().encode(svg).byteLength > DIAGRAM_MAX_OUTPUT) throw new Error('图表 SVG 超过 8 MiB');
    self.postMessage({svg});
  } catch (error) {
    self.postMessage({error: error instanceof Error ? error.message : 'DOT 绘制失败'});
  }
};
