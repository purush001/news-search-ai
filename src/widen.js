import { WINDOW } from '../shared/index.js';

const HOUR = 3_600_000;

/** Hours already searched for the current results (the widest of the original and widened windows). */
export function searchedHours(research) {
  if (!research) return 0;
  const end = Date.parse(research.window.end);
  return Math.max(
    (end - Date.parse(research.window.start)) / HOUR,
    ...research.widened.map((w) => (end - Date.parse(w.start)) / HOUR),
  );
}

/** Window sizes that are wider than what was already searched. */
export function widenChoices(research) {
  const searched = searchedHours(research);
  return WINDOW.widenOptions.filter((h) => h > searched + 0.5);
}

/** The value the select displays is the value the button must send. */
export function effectiveWidenHours(choices, wanted) {
  return choices.includes(wanted) ? wanted : choices[0];
}
