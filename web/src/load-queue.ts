interface QueuedLoad {
  start(): void;
}

/** One admission queue shared by initial, visibility and quality requests. */
export class LoadQueue {
  private active = 0;
  private readonly waiting: QueuedLoad[] = [];
  private readonly concurrency: number;

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Load concurrency must be a positive integer');
    this.concurrency = concurrency;
  }

  enqueue<T>(load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (success: boolean, value: T | unknown): void => {
        if (settled) return;
        settled = true;
        if (success) resolve(value as T);
        else reject(value);
      };
      const abort = (): void => {
        if (!started) {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', abort);
        }
        // A running loader still occupies its slot until it actually stops.
        // Reject its consumer promptly without oversubscribing after a reset.
        finish(false, signal?.reason);
      };
      const release = (): void => {
        this.active--;
        signal?.removeEventListener('abort', abort);
        this.drain();
      };
      const entry: QueuedLoad = {
        start: () => {
          if (signal?.aborted) { abort(); return; }
          started = true;
          this.active++;
          void Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return load();
          }).then(
            value => { finish(true, value); release(); },
            error => { finish(false, error); release(); },
          );
        },
      };
      signal?.addEventListener('abort', abort, {once: true});
      this.waiting.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) this.waiting.shift()!.start();
  }
}
