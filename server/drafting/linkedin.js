import { LINKEDIN, charCount, findUrls } from '../../shared/index.js';
import { AppError } from '../errors.js';
import { LINKEDIN_SYSTEM, inputBlock } from '../prompts.js';
import { ideaForModel, sourceUrls } from './common.js';

const text = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : '');

export function assemble(draft, item) {
  let out = `${draft.hook}\n\n${draft.body}\n\nSources:\n${sourceUrls(item.idea).join('\n')}`;
  if (item.ctaUrl) out += `\n\n${draft.cta}\n${item.ctaUrl}`;
  return out;
}

export const linkedinAdapter = {
  platform: 'linkedin',
  system: LINKEDIN_SYSTEM,

  generateUser(item) {
    return `Write one LinkedIn post for this idea.\n\n${inputBlock('linkedin_draft', {
      audience: LINKEDIN.audience,
      limits: LINKEDIN,
      ctaUrl: item.ctaUrl || null,
      idea: ideaForModel(item.idea, item.notes),
    })}`;
  },

  repairUser(draft, issues, item) {
    return `Fix every issue below and return the complete corrected JSON. Change as little else as possible.\n\n${inputBlock('linkedin_repair', {
      audience: LINKEDIN.audience,
      limits: LINKEDIN,
      ctaUrl: item.ctaUrl || null,
      idea: ideaForModel(item.idea, item.notes),
      draft: { hook: draft.hook, body: draft.body, cta: draft.cta },
      issues: issues.map(({ code, message }) => ({ code, message })),
    })}`;
  },

  reviewUser(draft, item) {
    return `Review the opening of this LinkedIn post.\n\n${inputBlock('linkedin_review', {
      platform: 'linkedin',
      audience: LINKEDIN.audience,
      opening: draft.hook,
      draft: { hook: draft.hook, body: draft.body },
      idea: ideaForModel(item.idea, item.notes),
    })}`;
  },

  parse(raw, item) {
    if (typeof raw?.hook !== 'string' || typeof raw?.body !== 'string') {
      throw new AppError('invalid_output', 'The LinkedIn draft was missing its hook or body.', { provider: 'openai' });
    }
    return {
      hook: text(raw.hook),
      body: text(raw.body),
      cta: item.ctaUrl ? text(raw.cta).replace(/\s*\n\s*/g, ' ') : '',
    };
  },

  validate(draft, item) {
    const issues = [];
    const add = (code, message) => issues.push({ code, message });
    const hookLines = draft.hook.split('\n').filter((l) => l.trim());
    if (!draft.hook) add('hook_missing', 'The post needs a hook.');
    if (hookLines.length > LINKEDIN.hookMaxLines) add('hook_too_many_lines', `The hook must be at most ${LINKEDIN.hookMaxLines} lines.`);
    if (charCount(draft.hook) > LINKEDIN.hookMaxChars) add('hook_too_long', `The hook must be at most ${LINKEDIN.hookMaxChars} characters.`);
    const bodyLen = charCount(draft.body);
    if (bodyLen < LINKEDIN.bodyMinChars) add('body_too_short', `The body must be at least ${LINKEDIN.bodyMinChars} characters.`);
    if (bodyLen > LINKEDIN.bodyMaxChars) add('body_too_long', `The body must be at most ${LINKEDIN.bodyMaxChars} characters.`);
    if ([draft.hook, draft.body, draft.cta].some((t) => findUrls(t).length > 0)) {
      add('url_in_text', 'Do not write URLs or domain names; the server appends the source links.');
    }
    if (item.ctaUrl && !draft.cta) add('cta_missing', 'A call-to-action line is required because a CTA URL was given.');
    if (charCount(assemble(draft, item)) > LINKEDIN.limit) {
      add('post_too_long', `The finished post (with source links) must be at most ${LINKEDIN.limit} characters.`);
    }
    return issues;
  },

  applyRewrite(draft, rewrite) {
    return { ...draft, hook: text(rewrite) };
  },

  finalize(draft, item) {
    const full = assemble(draft, item);
    return {
      text: full,
      hook: draft.hook,
      body: draft.body,
      cta: draft.cta,
      ctaUrl: item.ctaUrl || null,
      sourceUrls: sourceUrls(item.idea),
      length: charCount(full),
      limit: LINKEDIN.limit,
    };
  },
};
