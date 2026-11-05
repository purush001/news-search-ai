import http from 'node:http';
import { X, weightedLength } from '../../shared/index.js';
import { listen, sendJson, sleep, keyProblem } from './util.js';

/** Return this from a `respond` override to send a raw HTTP response instead of a JSON answer. */
export const httpResponse = (status, body, headers = {}) => ({ __http: { status, body, headers } });

function extractInput(userText) {
  const m = /INPUT JSON:\s*```json\s*([\s\S]*?)\s*```\s*$/.exec(userText || '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const WORKFLOW = {
  oracle: 'Oracle Database and OCI operations',
  peoplesoft: 'PeopleSoft integration and upgrade work',
  general: 'agent and developer-tooling decisions',
};

function stripMock(t) {
  return String(t).replace(/^\[Mock\]\s*/, '');
}

function fitTweet(text, reserve = 0) {
  let t = text.replace(/\s+/g, ' ').trim();
  while (weightedLength(t) + reserve > X.tweetLimit && t.length > 10) {
    t = t.slice(0, t.lastIndexOf(' ', t.length - 2) > 0 ? t.lastIndexOf(' ', t.length - 2) : t.length - 2).trim() + '…';
    if (t.endsWith('……')) t = t.slice(0, -1);
  }
  return t;
}

// ---- default behaviours (deterministic, and valid by construction) ----------

const defaults = {
  research_ideas(input) {
    const used = new Set();
    const ideas = [];
    for (const cat of ['oracle', 'peoplesoft', 'general']) {
      const want = input.quotas?.[cat] ?? 0;
      let n = 0;
      for (const c of input.candidates) {
        if (n >= want) break;
        if (used.has(c.id) || !c.categories.includes(cat)) continue;
        used.add(c.id);
        n++;
        const title = stripMock(c.title);
        ideas.push({
          category: cat,
          headline: title,
          summary: `${title}. Relevant to teams working on ${WORKFLOW[cat]}.`,
          angle: `Explain what changed for ${WORKFLOW[cat]} and what to evaluate first.`,
          confirmed: c.snippet || title,
          application: `Inference: this could change how teams plan ${WORKFLOW[cat]}, but the source does not say so directly.`,
          sourceIds: [c.id],
        });
      }
    }
    return { ideas };
  },

  linkedin_draft(input) {
    const idea = input.idea;
    const cat = guessCategory(idea);
    const hook = `${idea.headline}: here is what changes for ${WORKFLOW[cat]}.`;
    const body = [
      `${idea.summary}`,
      `What the sources confirm: ${idea.confirmedBySources}`,
      `My read: ${idea.proposedApplicationOurInference.replace(/^Inference:\s*/, '')} If agentic AI is new to you, think of an agent as software that plans a few steps and calls tools on your behalf instead of answering once.`,
      `Worth evaluating next: which of your current workflows already depend on this component, who owns the integration, and what a safe pilot would look like for your team.`,
      idea.editorialNotes ? `Editor's note: ${idea.editorialNotes.replace(/\[mock:[^\]]*\]/g, '').trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { hook, body, cta: input.ctaUrl ? 'If this is on your roadmap, read the details and compare notes with your team.' : '' };
  },

  x_draft(input) {
    const idea = input.idea;
    const n = input.tweetCount;
    const url = input.sourceUrls[0];
    const tweets = [];
    const hook = `${idea.headline} — what changes for developers shipping agents this quarter.`;
    for (let i = 0; i < n; i++) {
      let text;
      if (i === 0) text = hook;
      else if (i === 1) text = `What the sources confirm: ${idea.confirmedBySources}`;
      else if (i === n - 1) text = `Try it: evaluate this against one real workflow this week.`;
      else text = `Step ${i}: ${idea.angle}`;
      if (i === n - 1) {
        // the last tweet carries the source link, as a full https:// URL
        tweets.push(`${fitTweet(text, X.urlWeight + 1)} ${url}`);
      } else tweets.push(fitTweet(text));
    }
    return { tweets };
  },
};

function guessCategory(idea) {
  const t = `${idea.headline} ${idea.summary}`;
  if (/peoplesoft|peopletools/i.test(t)) return 'peoplesoft';
  if (/oracle|oci/i.test(t)) return 'oracle';
  return 'general';
}

function applyMarkers(task, draft, input) {
  const notes = input?.idea?.editorialNotes || '';
  if (task === 'x_draft' && /\[mock:overlong\]/.test(notes) && draft.tweets.length > 1) {
    draft.tweets[1] = 'This tweet is deliberately far too long. '.repeat(10).trim();
  }
  if (task === 'x_draft' && /\[mock:weakhook\]/.test(notes)) draft.tweets[0] = 'Big news in tech today.';
  if (task === 'linkedin_draft' && /\[mock:weakhook\]/.test(notes)) draft.hook = 'Big news in tech today.';
  return draft;
}

const taskHandlers = {
  research_ideas: (i) => defaults.research_ideas(i),
  linkedin_draft: (i) => applyMarkers('linkedin_draft', defaults.linkedin_draft(i), i),
  linkedin_repair: (i) => defaults.linkedin_draft(i), // repair = regenerate cleanly
  x_draft: (i) => applyMarkers('x_draft', defaults.x_draft(i), i),
  x_repair: (i) => defaults.x_draft(i),
  linkedin_review: reviewDefault,
  x_review: reviewDefault,
};

function reviewDefault(input) {
  const weak = /Big news in tech today/.test(input.opening || '');
  if (!weak) {
    return { standsAlone: true, reasonToKeepReading: true, bodySupportsClaim: true, notInterchangeable: true, problems: '', rewrite: null };
  }
  const title = input.idea?.headline || 'this change';
  return {
    standsAlone: false,
    reasonToKeepReading: false,
    bodySupportsClaim: true,
    notInterchangeable: false,
    problems: 'The opening could fit any story.',
    rewrite: `${title}: the practical consequence for your team is worth a closer look.`,
  };
}

/**
 * Mock of the OpenAI wire format used by this app:
 *   GET  /v1/models/{model}          (free key + model check)
 *   POST /v1/chat/completions        (JSON mode)
 * `respond(task, input, ctx)` may override any answer; call ctx.default() for the stock one.
 * Editorial-note markers: [mock:overlong] [mock:weakhook] [mock:delay=MS].
 */
export async function startMockOpenAI({ port = 0, respond, models = null, modelsDenied = [], modelsNeedScope = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const auth = String(req.headers.authorization || '');
      const key = auth.replace(/^Bearer\s+/i, '');
      const problem = keyProblem(key);
      if (problem === 'bad' || problem === 'missing') {
        // Real OpenAI echoes (part of) the key in this message; the app must not surface it.
        return sendJson(res, 401, { error: { message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.openai.com/account/api-keys.`, type: 'invalid_request_error', code: 'invalid_api_key' } });
      }
      if (problem === 'ratelimit') {
        return sendJson(res, 429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '11' });
      }
      if (problem === 'quota') {
        return sendJson(res, 429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota' } });
      }

      const modelMatch = /^\/v1\/models\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && modelMatch) {
        const model = decodeURIComponent(modelMatch[1]);
        calls.push({ task: 'verify', key, model });
        if (modelsNeedScope) {
          return sendJson(res, 403, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.', type: 'invalid_request_error', code: null } });
        }
        if (modelsDenied.includes(model) || (models && !models.includes(model))) {
          return sendJson(res, 404, { error: { message: `The model '${model}' does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });
        }
        return sendJson(res, 200, { id: model, object: 'model' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        const input = extractInput(user);
        const task = input?.task ?? 'unknown';
        const call = { task, key, model: body.model, system, user, input, responseFormat: body.response_format };
        calls.push(call);

        const delay = /\[mock:delay=(\d+)\]/.exec(user);
        if (delay) await sleep(Number(delay[1]));

        const stock = () => (taskHandlers[task] ? taskHandlers[task](input) : {});
        let result;
        if (respond) result = await respond(task, input, { default: stock, call, count: calls.filter((c) => c.task === task).length });
        if (result === undefined) result = stock();
        if (result?.__http) return sendJson(res, result.__http.status, result.__http.body, result.__http.headers);
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        return sendJson(res, 200, {
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        });
      }
      sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err?.message || err), type: 'server_error' } });
    }
  });
  const handle = await listen(server, port);
  return { ...handle, calls };
}
