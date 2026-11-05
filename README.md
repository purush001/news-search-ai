# News Search AI

A Vite + React app with a small Node backend and three agents:

1. **Research Agent** searches recent news (SerpAPI / Google News) and proposes 10 story ideas.
2. You approve **exactly three**.
3. A **LinkedIn Agent** and an **X/Twitter Agent** draft content for them **at the same time**.

All three agents use one model (default `gpt-6.1-sol`, override with `OPENAI_MODEL`).

## Run it

Requires Node 22+ (the test script uses `node --test` globs).

```bash
npm install
npm run dev          # Vite dev server + API on http://127.0.0.1:5173
```

```bash
npm run build && npm start   # production: serves dist/ and the API on http://127.0.0.1:4173
```

```bash
npm run dev:mock     # offline demo against mock OpenAI and SerpAPI servers
```

In `dev:mock` any keys work, except keys containing `bad` (401), `ratelimit` (429) or `quota` (out of credit).
Mock stories are placeholders (titles start with `[Mock]`; their URLs are not real pages). In the editorial notes of an
idea you can add `[mock:overlong]`, `[mock:weakhook]` or `[mock:delay=1500]` to exercise repair, hook rewrite and slow
responses.

Environment variables (all optional): `OPENAI_MODEL`, `OPENAI_BASE_URL`, `SERPAPI_BASE_URL`, `PORT` (`npm start`),
`OPENAI_TIMEOUT_MS`, `SERPAPI_TIMEOUT_MS`. None of them holds a credential.

## Vercel

`vercel.json` and `api/[...path].js` run the same API handler as a Vercel function; Vercel builds the Vite app as static
files. No environment variables are required (optionally `OPENAI_MODEL`). On Vercel (`VERCEL` is set) the handler accepts
the public host name, still refuses cross-origin writes, and marks the session cookie `Secure`.

**Limitation: sessions are in memory.** Keys and the current research results live in the memory of one function
instance. Vercel may start a new instance or route a request to a different one, and then those are gone: you will see
"Save both API keys first" or "These results are no longer available" and must re-enter the keys or search again. Warm,
low-traffic use mostly works; it is not reliable. For reliable hosting, run `npm run build && npm start` on a
long-running Node host, or move session state out of memory (for example an encrypted cookie plus a signed results token).

`maxDuration` is 60 seconds (the most Hobby allows without Fluid compute). A search plus idea generation, or a draft with
several repairs, can take longer; if you see timeouts, raise it on a plan that allows it. This setup was tested with a
simulated Vercel request shape, not on Vercel itself.

## Tests

```bash
npm test             # unit + API integration (real HTTP server, mock providers) + spawned-server test
npm run build && npm run test:e2e              # Playwright, production path
E2E_TARGET=dev npm run test:e2e                # Playwright, Vite dev middleware path
```

`test:e2e` needs Playwright with Chromium; it is not a project dependency and is resolved from the environment.
Screenshots go to `e2e-artifacts/` (git-ignored).

## Credential handling

- The OpenAI and SerpAPI keys are entered in masked fields (`type="password"`, autocomplete off).
- The browser sends each key once to the backend. The backend **verifies it with a free call** (`GET /models/{model}` for
  OpenAI, `GET /account` for SerpAPI) and only then keeps it **in server memory**, behind a random session id in an
  `HttpOnly; SameSite=Strict` cookie. Keys are never returned, logged, stored in the browser, or bundled (no `VITE_*`
  credentials). The UI clears typed keys after saving.
- Restarting the server forgets the keys. The cookie has no `Secure` flag because the app is served over plain
  `http://127.0.0.1`.
- Logs contain only method, path, status and duration. Every error detail passes through a redactor.
- The server binds to `127.0.0.1`, rejects foreign `Host` headers, cross-origin writes and non-JSON bodies, and caps
  body size. The static server handles malformed paths (`/%` returns 400) and wraps every request so nothing thrown can
  kill the process.
- `npm start` serves a strict Content-Security-Policy (same-origin scripts and requests only, no framing). Vite's dev server
  does not, because HMR needs inline scripts.
- The browser keeps one non-secret value: `nsai.lastRunEnd` in `localStorage`.

## Behaviour

**Research.** Window modes are *Past 24 hours* and *Since last successful run* (24 hours when no marker exists, and the
UI says so). Windows are capped at 30 days. Fifteen queries (5 Oracle, 4 PeopleSoft, 6 general) run with limited
concurrency. SerpAPI's recency filter is used coarsely; the app then filters **locally by parsed publication date**
(ISO, `MM/DD/YYYY, hh:mm AM, +0000 UTC`, `Nov 3, 2026`, `3 Nov 2026`, and relative forms such as `3 hours ago`). Undated or
unparseable dates are ignored. A date-only value counts when its UTC calendar day overlaps the window. A relative date
such as `3 hours ago` means somewhere in the following hour-wide interval and counts when that interval overlaps.

Candidates are tagged with the categories whose queries found them, then capped round-robin per category (primary
sources first, then newest). The model sees candidates by id (no URLs) and answers by id; the server maps ids to the real
results, enforces category quotas (Oracle 2, PeopleSoft 2, General 6), drops repeated stories (shared source URL or
headline), and requires a dated in-window source for each idea. If a category has too few ideas, one fill pass runs with
unused candidates; if still short, the UI says exactly how many are missing and lets you widen the window for only those
categories (48 hours to 30 days) while keeping existing ideas and the original window end.

**The "last successful run" marker** advances only after a *complete* run: no search failed **and** every category quota is
met. I read "ideas found" strictly so a run with a shortfall does not skip over news you have not covered. After widening
completes the quota, the marker advances to the original window end. Otherwise the previous marker is kept and the UI says why.

**Drafting.** One shared runner does generate, validate, repair (up to 4 attempts), independent opening review, and
per-idea results for both platforms. Transient failures (malformed or empty output, 5xx, timeout, network) are retried
twice without using a repair attempt. If a repair call fails the last usable draft is kept with a warning. If nothing
could be drafted, the provider's real status is returned. Opening rewrites are accepted only if they add no validation issue
the draft did not already have.

- LinkedIn: the server appends the source links; the model writes no URLs. An optional CTA URL adds a CTA line and puts
  the URL alone on the last line (source links stay above it). Without a CTA there is no CTA.
- X: tweet count is set per thread (1–25) and generated exactly. Length uses twitter-text v3 weighting (limit 280, URLs
  count 23, scheme-less domains with a known TLD count 23, CJK and emoji count 2). Threads that stay invalid are shown with a red counter.
- Discarding drafts while a run is in flight is safe: runs are tagged with a generation id and stale responses are ignored.

## Layout

```
shared/     limits, categories, URL rules, X length rules (used by server and browser)
server/     app.js (API handler), index.js (npm start), static.js, research.js, drafting/, providers/, mock/
src/        React app
tests/      node:test suites
scripts/    dev-mock.js, e2e.cjs
```

## Caveats

- **Live providers were not exercised** while building this (no keys or network for them in the build environment).
  The OpenAI Chat Completions JSON-mode calls and the SerpAPI response shapes (`news_results`, `date`, `iso_date`) follow my
  knowledge of the documented formats, validated only against the mocks. The model name `gpt-6.1-sol` and the claim that it
  supports `GET /models/{id}` and JSON mode could not be confirmed offline. If your model rejects a request parameter, adjust
  `server/providers/openai.js`.
- X length counting is implemented from the twitter-text v3 rules; the known-TLD list is a compact subset, so an unusual
  TLD may be counted as ordinary text.
- Drafts are model output. Check every claim against its sources before posting.
