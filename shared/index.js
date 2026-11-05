// Limits and definitions shared by the server and the browser bundle.
// Nothing in here may contain credentials.

export const CATEGORIES = {
  oracle: {
    label: 'Oracle',
    quota: 2,
    description:
      'AI developments relevant to Oracle Database, OCI, integrations, or production operations',
  },
  peoplesoft: {
    label: 'PeopleSoft',
    quota: 2,
    description:
      'AI relevant to PeopleSoft HCM, FSCM, PeopleTools, Integration Broker, or ERP modernization',
  },
  general: {
    label: 'General AI',
    quota: 6,
    description: 'Agentic AI, developer tooling, models, research, applied AI',
  },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES);
export const TOTAL_IDEAS = CATEGORY_KEYS.reduce((n, k) => n + CATEGORIES[k].quota, 0); // 10
export const APPROVALS_REQUIRED = 3;

export const WINDOW = {
  defaultHours: 24,
  maxHours: 30 * 24,
  minWidenHours: 48,
  widenOptions: [48, 168, 336, 720],
};
export const WINDOW_MODES = ['24h', 'since_last'];

export const LINKEDIN = {
  limit: 3000,
  hookMaxLines: 2,
  hookMaxChars: 220,
  bodyMinChars: 400,
  bodyMaxChars: 2400,
  audience:
    'technical professionals with 10-20 years of experience who may be new to agentic AI',
};

export const X = {
  tweetLimit: 280,
  urlWeight: 23,
  minTweets: 1,
  maxTweets: 25,
  defaultTweets: 5,
  audience: 'developers at tech startups in San Francisco and the Bay Area',
};

export const REPAIR_ATTEMPTS = 4;
export const MAX_NOTES_CHARS = 1000;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Strict http(s) URL check used for CTA URLs and source URLs. */
export function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return false;
  if (/\s/.test(value)) return false;
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  if (!u.hostname.includes('.')) return false;
  return true;
}

const TRACKING_PARAMS = /^(utm_[a-z0-9_]+|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|cmpid|ocid|taid)$/i;

/** Canonical form used to detect the same page reached by different links. */
export function normalizeUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '') path = '';
  return `${host}${path}${query}`;
}

export function normalizeHeadline(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// twitter-text v3 weighting
// ---------------------------------------------------------------------------

const KNOWN_TLDS = new Set(
  (
    'com net org edu gov mil int info biz name pro mobi io ai dev app co me tv cc ly gg sh so to ws fm am is it ' +
    'in us uk de fr jp cn ru br es nl se no fi dk ch at be pl cz ie nz sg hk kr tw au ca eu id mx ar za il ae ' +
    'sa tr gr pt ro hu ua xyz tech cloud online site blog news store shop page link live fun top club space ' +
    'systems software tools digital network agency solutions studio design media press world today email ' +
    'zone works group team codes run build ventures capital finance bank'
  ).split(' '),
);

const EXPLICIT_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const BARE_DOMAIN =
  /(?<![\w@.\-/:#$%])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,24})(?![\w@-])((?::\d{2,5})?(?:\/[^\s<>"'`]*)?)/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

/**
 * Locate URLs the way X counts them: explicit http(s) links, plus scheme-less
 * domains whose TLD is known. Returns [{ start, end, text, kind }].
 */
export function findUrls(text) {
  const found = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(EXPLICIT_URL)) {
    let t = m[0].replace(TRAILING_PUNCT, '');
    // keep a closing bracket if the URL itself opened one
    if (m[0].endsWith(')') && (t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length) t = m[0];
    if (t.length <= 'https://'.length) continue;
    found.push({ start: m.index, end: m.index + t.length, text: t, kind: 'explicit' });
  }
  for (const m of s.matchAll(BARE_DOMAIN)) {
    const tld = m[2].toLowerCase();
    if (!KNOWN_TLDS.has(tld)) continue;
    let t = m[0].replace(TRAILING_PUNCT, '');
    const start = m.index;
    const end = start + t.length;
    if (found.some((f) => start < f.end && end > f.start)) continue;
    found.push({ start, end, text: t, kind: 'bare' });
  }
  return found.sort((a, b) => a.start - b.start);
}

function codePointWeight(cp) {
  if (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  ) {
    return 1;
  }
  return 2;
}

const EMOJI_LIKE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

function plainWeight(text) {
  const normalized = text.normalize('NFC');
  let total = 0;
  const graphemes = segmenter ? Array.from(segmenter.segment(normalized), (g) => g.segment) : Array.from(normalized);
  for (const g of graphemes) {
    const cps = Array.from(g);
    if (cps.length > 1 && EMOJI_LIKE.test(g)) {
      total += 2; // emoji sequences (ZWJ, flags, keycaps, skin tones) count once
      continue;
    }
    for (const ch of cps) total += codePointWeight(ch.codePointAt(0));
  }
  return total;
}

/** Weighted tweet length, twitter-text v3 rules (limit is X.tweetLimit). */
export function weightedLength(text) {
  const s = String(text ?? '');
  const urls = findUrls(s);
  let total = 0;
  let cursor = 0;
  for (const u of urls) {
    total += plainWeight(s.slice(cursor, u.start));
    total += X.urlWeight;
    cursor = u.end;
  }
  total += plainWeight(s.slice(cursor));
  return total;
}

export function isTweetWithinLimit(text) {
  return weightedLength(text) <= X.tweetLimit;
}

export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}
