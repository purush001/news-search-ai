// The only thing the browser stores: the end time of the last successful research run (not a secret).
const KEY = 'nsai.lastRunEnd';

export function loadLastRunEnd() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v && !Number.isNaN(Date.parse(v)) ? v : null;
  } catch {
    return null;
  }
}

export function saveLastRunEnd(iso) {
  try {
    window.localStorage.setItem(KEY, iso);
  } catch {
    /* storage unavailable; the next run falls back to 24 hours */
  }
}
