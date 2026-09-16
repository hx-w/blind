export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
