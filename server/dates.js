// Strict publication-date parsing. Returns an interval {start, end, precision}
// (epoch ms) or null. Lenient Date.parse is deliberately never used.

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const DAY_MS = 86_400_000;
const UNIT_MS = {
  minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000,
  day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS,
};

function utc(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const t = Date.UTC(y, mo, d, h, mi, s, ms);
  const dt = new Date(t);
  // reject rolled-over values such as Feb 30 or hour 25
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
  if (dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s) return null;
  return t;
}

function dayInterval(y, mo, d) {
  const start = utc(y, mo, d);
  if (start === null) return null;
  return { start, end: start + DAY_MS - 1, precision: 'day' };
}

function exact(t) {
  return t === null ? null : { start: t, end: t, precision: 'time' };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s?(Z|[+-]\d{2}:?\d{2})?)?$/i;
const SERP = /^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM),\s*([+-]\d{4})\s*UTC$/i;
const MDY = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/;
const DMY = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/;
const REL = /^(\d{1,3}|an?|one) (minute|min|hour|hr|day|week|month)s? ago$/i;

export function parsePublished(raw, nowMs) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 60) return null;
  let m;

  if ((m = ISO.exec(s))) {
    const [, Y, Mo, D, h, mi, sec, frac, tz] = m;
    if (h === undefined) return dayInterval(+Y, +Mo - 1, +D);
    const base = utc(+Y, +Mo - 1, +D, +h, +mi, sec ? +sec : 0);
    if (base === null) return null;
    let t = base + (frac ? +frac.padEnd(3, '0') : 0);
    if (tz && tz.toUpperCase() !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      const oh = +digits.slice(0, 2);
      const om = +digits.slice(2, 4);
      if (oh > 14 || om > 59) return null;
      t -= sign * (oh * 60 + om) * 60_000;
    }
    return exact(t);
  }

  if ((m = SERP.exec(s))) {
    const [, Mo, D, Y, h12, mi, ap, tz] = m;
    let h = +h12;
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0);
    const base = utc(+Y, +Mo - 1, +D, h, +mi);
    if (base === null) return null;
    const sign = tz[0] === '-' ? -1 : 1;
    return exact(base - sign * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5)) * 60_000);
  }

  if ((m = MDY.exec(s))) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo === undefined ? null : dayInterval(+m[3], mo, +m[2]);
  }
  if ((m = DMY.exec(s))) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo === undefined ? null : dayInterval(+m[3], mo, +m[1]);
  }

  if (typeof nowMs === 'number') {
    if (/^yesterday$/i.test(s)) return { start: nowMs - 2 * DAY_MS, end: nowMs - DAY_MS, precision: 'relative' };
    if ((m = REL.exec(s))) {
      const n = /^\d/.test(m[1]) ? +m[1] : 1;
      const unit = UNIT_MS[m[2].toLowerCase()];
      // "N units ago" is floored by the provider: the true time lies in [N, N+1) units back.
      return { start: nowMs - (n + 1) * unit, end: nowMs - n * unit, precision: 'relative' };
    }
  }
  return null;
}

/** An interval is in the window if it overlaps it. Day-only dates therefore count when any part of that UTC day does. */
export function isInWindow(info, windowStart, windowEnd) {
  if (!info) return false;
  if (info.start === info.end) return info.start >= windowStart && info.start <= windowEnd;
  return info.end > windowStart && info.start <= windowEnd;
}

/** Best single timestamp for display and sorting. */
export function representativeTime(info, windowEnd) {
  if (info.precision === 'time') return info.start;
  return Math.min(info.end, windowEnd);
}
