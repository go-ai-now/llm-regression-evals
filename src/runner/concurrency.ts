/**
 * Maps `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result. There is no cancellation: if `fn` rejects, the
 * returned promise rejects, so callers should catch inside `fn` (the runner does).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`concurrency must be an integer >= 1, got ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
