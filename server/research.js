import { randomBytes } from 'node:crypto';
import {
  CATEGORIES,
  CATEGORY_KEYS,
  TOTAL_IDEAS,
  WINDOW,
  findUrls,
  isValidHttpUrl,
  normalizeHeadline,
  normalizeUrl,
} from '../shared/index.js';
import { AppError } from './errors.js';
import { parsePublished, isInWindow, representativeTime } from './dates.js';
import { RESEARCH_SYSTEM, researchUser } from './prompts.js';
import { pool, withTransientRetry } from './retry.js';

const HOUR = 3_600_000;
const MAX_CANDIDATES = 45;

export const QUERIES = [
  { category: 'oracle', q: 'Oracle Database AI' },
  { category: 'oracle', q: 'Oracle Cloud Infrastructure OCI generative AI' },
  { category: 'oracle', q: 'Oracle AI agents integration' },
  { category: 'oracle', q: 'Oracle Database 23ai vector search' },
  { category: 'oracle', q: 'Oracle production operations AI automation' },
  { category: 'peoplesoft', q: 'PeopleSoft HCM AI' },
  { category: 'peoplesoft', q: 'PeopleSoft FSCM cloud' },
  { category: 'peoplesoft', q: 'PeopleTools Integration Broker' },
  { category: 'peoplesoft', q: 'PeopleSoft ERP modernization' },
  { category: 'general', q: 'agentic AI' },
  { category: 'general', q: 'AI coding agents developer tools' },
  { category: 'general', q: 'new AI model release' },
  { category: 'general', q: 'AI research paper agents' },
  { category: 'general', q: 'Model Context Protocol' },
  { category: 'general', q: 'applied AI production LLM deployment' },
];

const PRIMARY_DOMAINS = [
  'oracle.com', 'openai.com', 'anthropic.com', 'deepmind.google', 'blog.google', 'research.google',
  'ai.google', 'ai.meta.com', 'meta.com', 'microsoft.com', 'aws.amazon.com', 'amazon.science',
  'nvidia.com', 'huggingface.co', 'github.blog', 'github.com', 'arxiv.org', 'mistral.ai', 'cohere.com',
  'x.ai', 'databricks.com', 'langchain.com', 'modelcontextprotocol.io', 'python.org', 'nodejs.org',
  'kubernetes.io', 'cncf.io', 'ieee.org', 'acm.org', 'nature.com', 'science.org', 'apple.com',
];

export function isPrimaryHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return PRIMARY_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** Strict ISO instant (with zone) as used for the saved "last successful run" marker. */
export function parseMarker(value) {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const info = parsePublished(value, 0);
  return info && info.precision === 'time' ? info.start : null;
}

export function computeWindow({ mode, lastRunEnd, now }) {
  const notes = [];
  let effectiveMode = mode;
  let start = now - WINDOW.defaultHours * HOUR;
  let clamped = false;

  if (mode === 'since_last') {
    const marker = parseMarker(lastRunEnd);
    if (marker === null || marker > now) {
      effectiveMode = '24h';
      notes.push(
        marker === null
          ? 'No previous successful run is recorded, so this search covers the past 24 hours.'
          : 'The saved last-run time is in the future, so this search covers the past 24 hours.',
      );
    } else if (now - marker > WINDOW.maxHours * HOUR) {
      start = now - WINDOW.maxHours * HOUR;
      clamped = true;
      notes.push('The last successful run is older than 30 days, so the window was limited to the past 30 days.');
    } else {
      start = marker;
    }
  }
  return { start, end: now, mode, effectiveMode, clamped, notes };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Merge raw search items into candidates: dedupe by normalized URL, parse and
 * filter by publication date locally, tag with the categories whose queries found them.
 */
export function collectCandidates(rawItems, { start, end, now }) {
  const byUrl = new Map();
  const stats = { total: 0, undated: 0, outside: 0, invalid: 0 };
  for (const { category, item } of rawItems) {
    stats.total++;
    if (!isValidHttpUrl(item.url)) {
      stats.invalid++;
      continue;
    }
    const key = normalizeUrl(item.url);
    const existing = byUrl.get(key);
    if (existing) {
      existing.categories.add(category);
      continue;
    }
    const info = parsePublished(item.dateRaw, now) || parsePublished(item.dateAlt, now);
    if (!info) {
      stats.undated++;
      continue;
    }
    if (!isInWindow(info, start, end)) {
      stats.outside++;
      continue;
    }
    byUrl.set(key, {
      key,
      title: item.title,
      url: item.url,
      source: item.source,
      snippet: item.snippet,
      host: new URL(item.url).hostname.replace(/^www\./, ''),
      primary: isPrimaryHost(new URL(item.url).hostname),
      time: representativeTime(info, end),
      precision: info.precision,
      categories: new Set([category]),
    });
  }
  return { candidates: [...byUrl.values()], stats };
}

/** Round-robin across categories (primary first, then newest) so no category crowds out another. */
export function capCandidates(candidates, cap = MAX_CANDIDATES, categories = CATEGORY_KEYS) {
  const order = (a, b) => Number(b.primary) - Number(a.primary) || b.time - a.time;
  const lists = categories.map((c) => candidates.filter((x) => x.categories.has(c)).sort(order));
  const chosen = [];
  const seen = new Set();
  let progressed = true;
  while (chosen.length < cap && progressed) {
    progressed = false;
    for (const list of lists) {
      while (list.length && seen.has(list[0].key)) list.shift();
      if (!list.length) continue;
      const next = list.shift();
      seen.add(next.key);
      chosen.push(next);
      progressed = true;
      if (chosen.length >= cap) break;
    }
  }
  return chosen;
}

function publicSource(c) {
  return {
    title: c.title,
    url: c.url,
    source: c.source || c.host,
    host: c.host,
    primary: c.primary,
    publishedAt: new Date(c.time).toISOString(),
    precision: c.precision,
  };
}

// ---------------------------------------------------------------------------
// Idea assembly (server-side validation of model output)
// ---------------------------------------------------------------------------

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  let s = value;
  const urls = findUrls(s);
  for (const u of [...urls].reverse()) s = s.slice(0, u.start) + s.slice(u.end);
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Turn the model's output into validated ideas. The model refers to candidates
 * by id only; URLs come from the candidate records, never from the model.
 */
export function assembleIdeas(rawIdeas, candidatesById, { quotas, existing = [], nextNumber = 1 }) {
  const accepted = [];
  const dropped = [];
  const counts = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  const seenUrls = new Set();
  const seenHeadlines = new Set();
  for (const e of existing) {
    counts[e.category]++;
    e.sources.forEach((s) => seenUrls.add(normalizeUrl(s.url)));
    seenHeadlines.add(normalizeHeadline(e.headline));
  }
  let n = nextNumber;
  const list = Array.isArray(rawIdeas) ? rawIdeas : [];
  const existingCounts = { ...counts };

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      dropped.push({ reason: 'not_an_object' });
      continue;
    }
    const category = typeof raw.category === 'string' ? raw.category.trim().toLowerCase() : '';
    if (!CATEGORY_KEYS.includes(category)) {
      dropped.push({ reason: 'unknown_category' });
      continue;
    }
    const ids = [...new Set(Array.isArray(raw.sourceIds) ? raw.sourceIds.filter((x) => typeof x === 'string') : [])];
    const sources = ids.map((id) => candidatesById.get(id)).filter(Boolean).slice(0, 4);
    if (sources.length === 0) {
      dropped.push({ reason: 'no_valid_sources' });
      continue;
    }
    if (!sources.some((s) => s.categories.has(category))) {
      dropped.push({ reason: 'category_unsupported' });
      continue;
    }
    const headline = cleanText(raw.headline, 200);
    const summary = cleanText(raw.summary, 700);
    const angle = cleanText(raw.angle, 500);
    const confirmed = cleanText(raw.confirmed, 700);
    const application = cleanText(raw.application, 700);
    if (!headline || !summary || !confirmed) {
      dropped.push({ reason: 'incomplete' });
      continue;
    }
    const urlKeys = sources.map((s) => s.key);
    const headlineKey = normalizeHeadline(headline);
    if (urlKeys.some((k) => seenUrls.has(k)) || seenHeadlines.has(headlineKey)) {
      dropped.push({ reason: 'duplicate_story' });
      continue;
    }
    if (counts[category] >= (quotas[category] ?? 0) + existingCounts[category]) {
      dropped.push({ reason: 'over_quota' });
      continue;
    }
    counts[category]++;
    urlKeys.forEach((k) => seenUrls.add(k));
    seenHeadlines.add(headlineKey);
    accepted.push({
      id: `idea-${n++}`,
      category,
      headline,
      summary,
      angle,
      confirmed,
      application,
      sources: sources.map(publicSource),
    });
  }
  return { ideas: accepted, dropped };
}

export function quotaStatus(ideas) {
  const out = {};
  for (const k of CATEGORY_KEYS) {
    const have = ideas.filter((i) => i.category === k).length;
    out[k] = { label: CATEGORIES[k].label, want: CATEGORIES[k].quota, have, missing: Math.max(0, CATEGORIES[k].quota - have) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchQueries(ctx, queries, { hours, start, end, now }) {
  let fatal = null;
  const failures = [];
  const items = [];
  let succeeded = 0;
  await pool(
    queries,
    ctx.config.searchConcurrency,
    async ({ category, q }) => {
      try {
        const results = await ctx.serp.news(q, hours);
        succeeded++;
        for (const item of results) items.push({ category, item });
      } catch (err) {
        if (err instanceof AppError && (err.code === 'invalid_serpapi_key' || err.code === 'quota_exhausted')) {
          fatal ??= err;
        } else {
          failures.push(err instanceof AppError ? err : new AppError('search_failed', 'A news search failed.'));
        }
      }
    },
    () => fatal !== null,
  );
  if (fatal) throw fatal;
  if (succeeded === 0 && failures.length) {
    const first = failures[0];
    throw first.code === 'search_failed' || first.code === 'rate_limit' || first.code === 'timeout' || first.code === 'network'
      ? first
      : new AppError('search_failed', 'Every news search failed.', { detail: first.message });
  }
  return { ...collectCandidates(items, { start, end, now }), failures, queries: queries.length };
}

// ---------------------------------------------------------------------------
// Idea generation
// ---------------------------------------------------------------------------

async function askForIdeas(ctx, { quotas, pool: candidates, window, avoid, existing, nextNumber }) {
  const byId = new Map();
  const payload = candidates.map((c, i) => {
    c.id = `c${i + 1}`;
    byId.set(c.id, c);
    return {
      id: c.id,
      title: c.title,
      source: c.source || c.host,
      publishedAt: new Date(c.time).toISOString(),
      primary: c.primary,
      categories: [...c.categories],
      snippet: c.snippet,
    };
  });
  const out = await withTransientRetry(() =>
    ctx.openai.json({
      system: RESEARCH_SYSTEM,
      user: researchUser({
        quotas,
        candidates: payload,
        window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
        avoid,
      }),
    }),
  );
  return assembleIdeas(out.ideas, byId, { quotas, existing, nextNumber });
}

async function fillIdeas(ctx, { candidates, quotas, window, existing, nextNumber }) {
  const wanted = Object.keys(quotas).filter((k) => quotas[k] > 0);
  const poolList = capCandidates(candidates, MAX_CANDIDATES, wanted);
  if (poolList.length === 0) return { ideas: [], dropped: [] };
  return askForIdeas(ctx, {
    quotas,
    pool: poolList,
    window,
    avoid: existing.map((i) => i.headline),
    existing,
    nextNumber,
  });
}

function sumMissing(status) {
  return CATEGORY_KEYS.reduce((n, k) => n + status[k].missing, 0);
}

function missingQuotas(ideas) {
  const status = quotaStatus(ideas);
  return Object.fromEntries(CATEGORY_KEYS.map((k) => [k, status[k].missing]));
}

function buildResponse(research) {
  const status = quotaStatus(research.ideas);
  const missing = sumMissing(status);
  const failedSearches = research.failedSearches;
  const complete = failedSearches === 0 && missing === 0 && research.ideas.length === TOTAL_IDEAS;
  let reason = null;
  if (!complete) {
    const parts = [];
    if (failedSearches > 0) parts.push(`${failedSearches} news search${failedSearches === 1 ? '' : 'es'} failed`);
    if (missing > 0) parts.push(`${missing} idea${missing === 1 ? ' is' : 's are'} still missing`);
    reason = `The last successful run time was not advanced because ${parts.join(' and ')}.`;
  }
  return {
    runId: research.runId,
    window: {
      start: new Date(research.window.start).toISOString(),
      end: new Date(research.window.end).toISOString(),
      mode: research.window.mode,
      effectiveMode: research.window.effectiveMode,
      clamped: research.window.clamped,
      notes: research.window.notes,
    },
    widened: research.widened.map((w) => ({ ...w, start: new Date(w.start).toISOString() })),
    ideas: research.ideas,
    quotas: status,
    missingTotal: missing,
    failedSearches,
    warnings: research.warnings,
    complete,
    marker: { advance: complete, value: complete ? new Date(research.window.end).toISOString() : null, reason },
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function runResearch(ctx, session, { mode, lastRunEnd }) {
  const now = ctx.config.now();
  const window = computeWindow({ mode, lastRunEnd, now });
  const hours = Math.max(1, Math.ceil((window.end - window.start) / HOUR));
  const search = await searchQueries(ctx, QUERIES, { hours, start: window.start, end: window.end, now });
  const warnings = [];
  if (search.failures.length) warnings.push(`${search.failures.length} of ${search.queries} searches failed; results may be incomplete.`);

  const quotas = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, CATEGORIES[k].quota]));
  const research = {
    runId: randomBytes(6).toString('hex'),
    window,
    ideas: [],
    allCandidates: search.candidates,
    nextNumber: 1,
    failedSearches: search.failures.length,
    warnings,
    widened: [],
  };

  const capped = capCandidates(search.candidates);
  if (capped.length) {
    const first = await askForIdeas(ctx, { quotas, pool: capped, window, avoid: [], existing: [], nextNumber: 1 });
    research.ideas = first.ideas;
    research.nextNumber = first.ideas.length + 1;
    // One fill pass if a category fell short but unused candidates exist for it.
    const miss = missingQuotas(research.ideas);
    if (Object.values(miss).some((n) => n > 0)) {
      const used = new Set(research.ideas.flatMap((i) => i.sources.map((s) => normalizeUrl(s.url))));
      const unused = search.candidates.filter((c) => !used.has(c.key));
      const fill = await fillIdeas(ctx, { candidates: unused, quotas: miss, window, existing: research.ideas, nextNumber: research.nextNumber });
      research.ideas = [...research.ideas, ...fill.ideas];
      research.nextNumber += fill.ideas.length;
    }
  }
  if (research.ideas.length === 0 && search.candidates.length === 0) {
    warnings.push('No dated articles were found inside the search window.');
  }
  session.research = research;
  return buildResponse(research);
}

export async function widenResearch(ctx, session, { runId, hours }) {
  const research = session.research;
  if (!research || research.runId !== runId) {
    throw new AppError('stale_run', 'These results were replaced by a newer search.');
  }
  if (!Number.isInteger(hours) || hours < WINDOW.minWidenHours || hours > WINDOW.maxHours) {
    throw new AppError('bad_request', `Choose a window between ${WINDOW.minWidenHours} hours and 30 days.`);
  }
  const end = research.window.end; // the original window end is kept
  const start = end - hours * HOUR;
  const status = quotaStatus(research.ideas);
  const missingCats = CATEGORY_KEYS.filter((k) => status[k].missing > 0);
  if (missingCats.length === 0) {
    throw new AppError('bad_request', 'No ideas are missing, so there is nothing to widen.');
  }
  const previousSpan = Math.max(research.window.end - research.window.start, ...research.widened.map((w) => end - w.start));
  if (hours * HOUR <= previousSpan) {
    throw new AppError('bad_request', 'Choose a window wider than the one already searched.');
  }
  const now = ctx.config.now();
  const queries = QUERIES.filter((q) => missingCats.includes(q.category));
  const search = await searchQueries(ctx, queries, { hours: Math.ceil((now - start) / HOUR), start, end, now });

  const used = new Set(research.ideas.flatMap((i) => i.sources.map((s) => normalizeUrl(s.url))));
  const fresh = search.candidates.filter((c) => !used.has(c.key));
  const quotas = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, status[k].missing]));
  const fill = await fillIdeas(ctx, {
    candidates: fresh,
    quotas,
    window: { start, end },
    existing: research.ideas,
    nextNumber: research.nextNumber,
  });
  research.ideas = [...research.ideas, ...fill.ideas];
  research.nextNumber += fill.ideas.length;
  research.failedSearches += search.failures.length;
  if (search.failures.length) {
    research.warnings.push(`${search.failures.length} of ${search.queries} widened searches failed.`);
  }
  research.widened.push({ categories: missingCats, hours, start });
  return buildResponse(research);
}

/** Look up approved ideas (server-held, with their real source URLs). */
export function ideasById(session) {
  const map = new Map();
  for (const idea of session.research?.ideas ?? []) map.set(idea.id, idea);
  return map;
}
