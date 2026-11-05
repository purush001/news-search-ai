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

/**
 * Splits ids into those whose settings are valid for this platform and those that are not.
 * Batch actions (retry failed, regenerate all) must not send a request the server will reject as a whole.
 */
export function partitionBySettings(platform, ids, settings) {
  const key = platform === 'linkedin' ? 'ctaUrl' : 'tweetCount';
  const valid = [];
  const invalid = [];
  for (const id of ids) (settingsProblem(settings[id])[key] ? invalid : valid).push(id);
  return { valid, invalid };
}

function runningItems(ids, prev = {}) {
  const out = { ...prev };
  for (const id of ids) out[id] = { ...(prev[id] || {}), status: 'running', error: null, notice: null };
  return out;
}

/** Drafts skipped by a batch action get a plain notice (not an error: nothing was sent, nothing failed). */
export function annotateSkipped(items, ids, notice) {
  const out = { ...items };
  for (const id of ids) if (out[id]) out[id] = { ...out[id], notice };
  return out;
}

/** Changing a setting makes any "fix this setting" notice for that idea obsolete. */
export function clearNotices(drafts, id) {
  const out = { ...drafts };
  for (const platform of PLATFORMS) {
    const item = drafts[platform]?.items?.[id];
    if (item?.notice) out[platform] = { items: { ...drafts[platform].items, [id]: { ...item, notice: null } } };
  }
  return out;
}

/** True when at least one draft is finished, so discarding would lose work (including edits). */
export function hasFinishedDrafts(drafts) {
  return Boolean(drafts) && PLATFORMS.some((p) => Object.values(drafts[p].items).some((it) => it.status === 'ok'));
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
    (platform, gen, requestedIds) => {
      const current = draftsRef.current;
      if (!current || current.gen !== gen || requestedIds.length === 0) return;
      const { valid: ids, invalid } = partitionBySettings(platform, requestedIds, current.settings);
      if (invalid.length) {
        const notice = platform === 'linkedin' ? 'Not regenerated: fix the CTA URL first.' : 'Not regenerated: fix the tweet count first.';
        update(gen, (d) => ({ ...d, [platform]: { items: annotateSkipped(d[platform].items, invalid, notice) } }));
      }
      if (ids.length === 0) return;
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
    setDrafts((prev) => (prev ? clearNotices({ ...prev, settings: { ...prev.settings, [id]: { ...prev.settings[id], ...patch } } }, id) : prev));
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
