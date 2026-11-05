import { useCallback, useRef, useState } from 'react';
import { api, errorInfo } from './api.js';
import { X, isValidHttpUrl } from '../shared/index.js';

const PLATFORMS = ['linkedin', 'x'];

export function settingsProblem(settings) {
  const problems = {};
  const n = settings.tweetCount;
  if (!Number.isInteger(n) || n < X.minTweets || n > X.maxTweets) {
    problems.tweetCount = `Use a whole number from ${X.minTweets} to ${X.maxTweets}.`;
  }
  const cta = (settings.ctaUrl || '').trim();
  if (cta && !isValidHttpUrl(cta)) problems.ctaUrl = 'Enter a full URL starting with https:// or leave it blank.';
  return problems;
}

function runningItems(ids, prev = {}) {
  const out = { ...prev };
  for (const id of ids) out[id] = { ...(prev[id] || {}), status: 'running', error: null };
  return out;
}

/**
 * Parallel drafting state. Every run is tagged with a generation id; discarding bumps it,
 * so late responses for discarded drafts are ignored. All updates tolerate cleared state.
 */
export function useDrafting() {
  const [drafts, setDrafts] = useState(null);
  const genRef = useRef(0);
  const draftsRef = useRef(null);
  draftsRef.current = drafts;

  const update = useCallback((gen, fn) => {
    if (genRef.current !== gen) return; // stale response from a discarded run
    setDrafts((prev) => (prev && prev.gen === gen ? fn(prev) : prev));
  }, []);

  const runPlatform = useCallback(
    (platform, gen, ids) => {
      const current = draftsRef.current;
      if (!current || current.gen !== gen || ids.length === 0) return;
      const items = ids.map((id) => {
        const s = current.settings[id];
        return platform === 'linkedin'
          ? { ideaId: id, notes: s.notes, ctaUrl: (s.ctaUrl || '').trim() }
          : { ideaId: id, notes: s.notes, tweetCount: s.tweetCount };
      });
      update(gen, (d) => ({ ...d, [platform]: { items: runningItems(ids, d[platform].items) } }));
      const request = platform === 'linkedin' ? api.draftLinkedIn : api.draftX;
      request({ runId: current.runId, items }).then(
        (res) =>
          update(gen, (d) => {
            const next = { ...d[platform].items };
            for (const r of res.results) {
              if (!(r.ideaId in next)) continue;
              next[r.ideaId] =
                r.status === 'ok'
                  ? { status: 'ok', draft: r.draft, issues: r.issues, warnings: r.warnings, error: null, edited: false }
                  : { ...next[r.ideaId], status: 'error', error: r.error };
            }
            return { ...d, [platform]: { items: next } };
          }),
        (err) =>
          update(gen, (d) => {
            const info = errorInfo(err);
            const next = { ...d[platform].items };
            for (const id of ids) if (next[id]) next[id] = { ...next[id], status: 'error', error: info };
            return { ...d, [platform]: { items: next } };
          }),
      );
    },
    [update],
  );

  /** Starts both agents at the same moment. */
  const start = useCallback(
    (runId, ideas, settings) => {
      const gen = ++genRef.current;
      const ids = ideas.map((i) => i.id);
      const blank = Object.fromEntries(ids.map((id) => [id, { status: 'running', error: null }]));
      const next = { gen, runId, ideas, settings, linkedin: { items: blank }, x: { items: blank } };
      draftsRef.current = next; // runPlatform reads this synchronously
      setDrafts(next);
      for (const p of PLATFORMS) runPlatform(p, gen, ids);
    },
    [runPlatform],
  );

  const discard = useCallback(() => {
    genRef.current++;
    draftsRef.current = null;
    setDrafts(null);
  }, []);

  const regenerate = useCallback(
    (platform, ids) => {
      const d = draftsRef.current;
      if (d) runPlatform(platform, d.gen, ids);
    },
    [runPlatform],
  );

  const retryFailed = useCallback(
    (platform) => {
      const d = draftsRef.current;
      if (!d) return;
      const ids = Object.entries(d[platform].items)
        .filter(([, it]) => it.status === 'error')
        .map(([id]) => id);
      runPlatform(platform, d.gen, ids);
    },
    [runPlatform],
  );

  const regenerateAll = useCallback(
    (platform) => {
      const d = draftsRef.current;
      if (d) runPlatform(platform, d.gen, d.ideas.map((i) => i.id));
    },
    [runPlatform],
  );

  const setSetting = useCallback((id, patch) => {
    setDrafts((prev) => (prev ? { ...prev, settings: { ...prev.settings, [id]: { ...prev.settings[id], ...patch } } } : prev));
  }, []);

  const editDraft = useCallback((platform, id, fn) => {
    setDrafts((prev) => {
      const item = prev?.[platform]?.items?.[id];
      if (!item?.draft) return prev;
      return { ...prev, [platform]: { items: { ...prev[platform].items, [id]: { ...item, edited: true, draft: fn(item.draft) } } } };
    });
  }, []);

  return { drafts, start, discard, regenerate, retryFailed, regenerateAll, setSetting, editDraft };
}
