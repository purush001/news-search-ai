/** Runtime configuration. Everything here is non-secret and can be overridden for tests. */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    model: env.OPENAI_MODEL || 'gpt-6.1-sol',
    openaiBaseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    serpapiBaseUrl: env.SERPAPI_BASE_URL || 'https://serpapi.com',
    openaiTimeoutMs: num(env.OPENAI_TIMEOUT_MS, 120_000),
    serpTimeoutMs: num(env.SERPAPI_TIMEOUT_MS, 30_000),
    verifyTimeoutMs: 15_000,
    searchConcurrency: 4,
    // Backoff between transient retries (doubles each try) and the most time one draft may spend
    // on repairs and review before the last usable draft is returned with a warning.
    retryDelayMs: 400,
    draftBudgetMs: 5 * 60 * 1000,
    budgetClock: () => Date.now(),
    sessionTtlMs: 8 * 60 * 60 * 1000,
    maxSessions: 50,
    maxBodyBytes: 64 * 1024,
    fetch: globalThis.fetch,
    logger: (line) => console.log(line),
    now: () => Date.now(),
    ...overrides,
  };
}
