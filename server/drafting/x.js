import { X, findUrls, weightedLength } from '../../shared/index.js';
import { AppError } from '../errors.js';
import { X_SYSTEM, inputBlock } from '../prompts.js';
import { sourceUrls } from './linkedin.js';

function ideaForModel(idea, notes) {
  return {
    headline: idea.headline,
    summary: idea.summary,
    angle: idea.angle,
    confirmedBySources: idea.confirmed,
    proposedApplicationOurInference: idea.application,
    sources: idea.sources.map((s) => ({ title: s.title, source: s.source, publishedAt: s.publishedAt, primary: s.primary, url: s.url })),
    editorialNotes: notes || '',
  };
}

export const xAdapter = {
  platform: 'x',
  system: X_SYSTEM,

  generateUser(item) {
    return `Write one X thread of exactly ${item.tweetCount} tweet(s) for this idea.\n\n${inputBlock('x_draft', {
      audience: X.audience,
      tweetCount: item.tweetCount,
      tweetLimit: X.tweetLimit,
      urlWeight: X.urlWeight,
      sourceUrls: sourceUrls(item.idea),
      idea: ideaForModel(item.idea, item.notes),
    })}`;
  },

  repairUser(draft, issues, item) {
    return `Fix every issue below and return the complete corrected thread of exactly ${item.tweetCount} tweet(s). Change as little else as possible.\n\n${inputBlock('x_repair', {
      audience: X.audience,
      tweetCount: item.tweetCount,
      tweetLimit: X.tweetLimit,
      urlWeight: X.urlWeight,
      sourceUrls: sourceUrls(item.idea),
      idea: ideaForModel(item.idea, item.notes),
      tweets: draft.tweets,
      issues: issues.map(({ code, message, at }) => ({ code, message, tweetIndex: at })),
    })}`;
  },

  reviewUser(draft, item) {
    return `Review the opening tweet of this X thread.\n\n${inputBlock('x_review', {
      platform: 'x',
      audience: X.audience,
      opening: draft.tweets[0],
      draft: { tweets: draft.tweets },
      idea: ideaForModel(item.idea, item.notes),
    })}`;
  },

  parse(raw) {
    if (!Array.isArray(raw?.tweets) || raw.tweets.length === 0 || raw.tweets.some((t) => typeof t !== 'string')) {
      throw new AppError('invalid_output', 'The X draft did not contain a list of tweets.', { provider: 'openai' });
    }
    return { tweets: raw.tweets.map((t) => t.replace(/\r\n/g, '\n').trim()) };
  },

  validate(draft, item) {
    const issues = [];
    const add = (code, message, at) => issues.push(at === undefined ? { code, message } : { code, message, at });
    const allowed = new Set(sourceUrls(item.idea));
    if (draft.tweets.length !== item.tweetCount) {
      add('tweet_count', `The thread must have exactly ${item.tweetCount} tweet(s) but has ${draft.tweets.length}.`);
    }
    let sourceSeen = false;
    draft.tweets.forEach((t, i) => {
      if (!t) add('tweet_empty', `Tweet ${i + 1} is empty.`, i);
      const w = weightedLength(t);
      if (w > X.tweetLimit) add('tweet_too_long', `Tweet ${i + 1} weighs ${w}; the limit is ${X.tweetLimit}.`, i);
      for (const u of findUrls(t)) {
        if (u.kind === 'bare') add('bare_domain', `Tweet ${i + 1} contains "${u.text}" without https://.`, i);
        else if (!allowed.has(u.text)) add('url_not_provided', `Tweet ${i + 1} contains a URL that was not provided.`, i);
        else sourceSeen = true;
      }
    });
    if (!sourceSeen) add('source_link_missing', 'At least one provided source link must appear in the thread.');
    return issues;
  },

  applyRewrite(draft, rewrite) {
    const tweets = [...draft.tweets];
    tweets[0] = String(rewrite).trim();
    return { tweets };
  },

  finalize(draft, item) {
    return {
      tweets: draft.tweets.map((text) => ({ text, weight: weightedLength(text) })),
      count: item.tweetCount,
      sourceUrls: sourceUrls(item.idea),
      limit: X.tweetLimit,
    };
  },
};
