import { REPAIR_ATTEMPTS } from '../../shared/index.js';
import { AppError, toAppError } from '../errors.js';
import { REVIEW_SYSTEM } from '../prompts.js';
import { withTransientRetry } from '../retry.js';

const issueKey = (i) => `${i.code}@${i.at ?? ''}`;

/**
 * Generate -> validate -> repair -> review -> result, once, for every platform.
 * Platform adapters supply prompts, parsing and validators.
 * Validators return structured issues { code, message, at? }; only codes are compared.
 */
export async function draftIdeas(ctx, adapter, items) {
  const settled = await Promise.all(
    items.map(async (item) => {
      try {
        return await draftOne(ctx, adapter, item);
      } catch (err) {
        const e = toAppError(err);
        return { ideaId: item.idea.id, status: 'error', error: e.toJSON(), _err: e };
      }
    }),
  );
  if (settled.every((r) => r.status === 'error')) {
    // Nothing could be drafted: surface the real provider error (and its HTTP status).
    throw settled[0]._err;
  }
  return settled.map(({ _err, ...r }) => r);
}

async function draftOne(ctx, adapter, item) {
  const call = (system, user, parse) =>
    withTransientRetry(async () => parse(await ctx.openai.json({ system, user })));

  const warnings = [];
  let draft = await call(adapter.system, adapter.generateUser(item), (raw) => adapter.parse(raw, item));
  let issues = adapter.validate(draft, item);

  for (let attempt = 0; issues.length > 0 && attempt < REPAIR_ATTEMPTS; attempt++) {
    try {
      const repaired = await call(adapter.system, adapter.repairUser(draft, issues, item), (raw) => adapter.parse(raw, item));
      draft = repaired; // the last usable draft
      issues = adapter.validate(draft, item);
    } catch (err) {
      const e = toAppError(err);
      warnings.push({
        code: 'repair_failed',
        message: `A repair attempt failed (${e.code}); the last usable draft is shown.`,
      });
      break;
    }
  }

  await reviewOpening(ctx, adapter, item, { get: () => draft, set: (d) => (draft = d) }, () => issues, (i) => (issues = i), warnings);

  return {
    ideaId: item.idea.id,
    status: 'ok',
    draft: adapter.finalize(draft, item),
    issues,
    warnings,
  };
}

async function reviewOpening(ctx, adapter, item, ref, getIssues, setIssues, warnings) {
  let verdict;
  try {
    const raw = await withTransientRetry(() => ctx.openai.json({ system: REVIEW_SYSTEM, user: adapter.reviewUser(ref.get(), item) }));
    verdict = normalizeVerdict(raw);
  } catch (err) {
    const e = toAppError(err);
    warnings.push({ code: 'review_failed', message: `The opening could not be reviewed (${e.code}).` });
    return;
  }
  if (verdict.passes) return;

  if (!verdict.rewrite) {
    warnings.push({ code: 'weak_opening', message: `Opening flagged by the reviewer: ${verdict.problems || 'it may not hold the reader.'}` });
    return;
  }
  const candidate = adapter.applyRewrite(ref.get(), verdict.rewrite, item);
  const baseline = new Set(getIssues().map(issueKey));
  const candidateIssues = adapter.validate(candidate, item);
  const introduced = candidateIssues.filter((i) => !baseline.has(issueKey(i)));
  if (introduced.length === 0) {
    ref.set(candidate);
    setIssues(candidateIssues);
    warnings.push({ code: 'hook_rewritten', message: 'The reviewer rewrote the opening.' });
  } else {
    warnings.push({
      code: 'hook_rewrite_rejected',
      message: `The reviewer suggested a new opening, but it would introduce ${introduced.map((i) => i.code).join(', ')}. The original is kept.`,
    });
    warnings.push({ code: 'weak_opening', message: `Opening flagged by the reviewer: ${verdict.problems || 'it may not hold the reader.'}` });
  }
}

export function normalizeVerdict(raw) {
  if (!raw || typeof raw !== 'object') throw new AppError('invalid_output', 'Review returned no verdict.');
  const checks = ['standsAlone', 'reasonToKeepReading', 'bodySupportsClaim', 'notInterchangeable'];
  const passes = checks.every((k) => raw[k] === true); // never trust a self-reported "passes"
  const rewrite = typeof raw.rewrite === 'string' && raw.rewrite.trim() ? raw.rewrite.trim() : null;
  return { passes, rewrite, problems: typeof raw.problems === 'string' ? raw.problems.slice(0, 300) : '' };
}
