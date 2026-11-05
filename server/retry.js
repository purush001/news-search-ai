/** Retry transient failures (malformed/empty output, 5xx, timeout, network) without consuming repair attempts. */
export async function withTransientRetry(fn, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!err?.transient || attempt === retries) throw err;
    }
  }
  throw lastErr;
}

export async function pool(items, limit, worker, shouldStop = () => false) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
