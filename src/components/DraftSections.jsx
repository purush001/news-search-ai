import { LINKEDIN, X, charCount, weightedLength } from '../../shared/index.js';
import { settingsProblem } from '../drafting.js';
import AutoTextarea from './AutoTextarea.jsx';
import CopyButton from './CopyButton.jsx';
import ErrorAlert from './ErrorAlert.jsx';

function Messages({ item }) {
  if (item.edited) return null; // server findings describe the generated text, not the edited one
  return (
    <>
      {(item.issues || []).map((i, n) => (
        <p key={`i${n}`} className="notice bad" data-testid="draft-issue" data-code={i.code}>
          {i.message}
        </p>
      ))}
      {(item.warnings || []).map((w, n) => (
        <p key={`w${n}`} className="notice warn" data-testid="draft-warning" data-code={w.code}>
          {w.message}
        </p>
      ))}
    </>
  );
}

function platformSummary(items, ids) {
  const list = ids.map((id) => items[id]).filter(Boolean);
  const running = list.filter((i) => i.status === 'running').length;
  const failed = list.filter((i) => i.status === 'error').length;
  const done = list.filter((i) => i.status === 'ok').length;
  if (running) return { state: 'running', text: `Drafting… ${done} of ${list.length} ready` };
  if (failed) return { state: 'attention', text: `${done} of ${list.length} ready · ${failed} failed` };
  return { state: 'done', text: `All ${list.length} drafts ready` };
}

function Section({ platform, title, subtitle, ideas, platformState, onRetryFailed, onRegenerateAll, children }) {
  const ids = ideas.map((i) => i.id);
  const summary = platformSummary(platformState.items, ids);
  const anyFailed = ids.some((id) => platformState.items[id]?.status === 'error');
  const running = summary.state === 'running';
  return (
    <section className="card draft-section" aria-labelledby={`${platform}-title`} data-testid={`${platform}-section`} data-state={summary.state}>
      <div className="card-head">
        <div>
          <h2 id={`${platform}-title`}>{title}</h2>
          <p className="muted">{subtitle}</p>
        </div>
        <div className="row">
          <span className={`status status-${summary.state}`} role="status" aria-live="polite" data-testid={`${platform}-status`}>
            {running ? <span className="spinner" aria-hidden="true" /> : null}
            {summary.text}
          </span>
          <button type="button" className="btn btn-small" disabled={!anyFailed || running} onClick={onRetryFailed} data-testid={`${platform}-retry`}>
            Retry failed
          </button>
          <button type="button" className="btn btn-small" disabled={running} onClick={onRegenerateAll} data-testid={`${platform}-regen-all`}>
            Regenerate all
          </button>
        </div>
      </div>
      <div className="draft-list">{children}</div>
    </section>
  );
}

export function LinkedInSection({ drafts, actions, onEditKeys }) {
  const { ideas, linkedin, settings } = drafts;
  return (
    <Section
      platform="linkedin"
      title="3. LinkedIn Agent"
      subtitle="One standalone post per approved idea."
      ideas={ideas}
      platformState={linkedin}
      onRetryFailed={() => actions.retryFailed('linkedin')}
      onRegenerateAll={() => actions.regenerateAll('linkedin')}
    >
      {ideas.map((idea) => {
        const item = linkedin.items[idea.id];
        const s = settings[idea.id];
        const problem = settingsProblem(s).ctaUrl;
        const running = item.status === 'running';
        const text = item.draft?.text ?? '';
        const len = charCount(text);
        return (
          <article key={idea.id} className="draft" data-testid="linkedin-card" data-idea-id={idea.id} data-state={item.status}>
            <h3>{idea.headline}</h3>
            {running && !item.draft ? (
              <p className="status">
                <span className="spinner" aria-hidden="true" /> Drafting…
              </p>
            ) : null}
            {item.error ? <ErrorAlert error={item.error} onEditKeys={onEditKeys} title={item.draft ? 'Regeneration failed — the previous draft is kept.' : 'This draft failed.'} /> : null}
            {item.draft ? (
              <>
                <label className="field">
                  <span className="sr-only">LinkedIn post</span>
                  <AutoTextarea
                    className={`post ${running ? 'dim' : ''}`}
                    minRows={8}
                    value={text}
                    onChange={(e) => actions.editDraft('linkedin', idea.id, (d) => ({ ...d, text: e.target.value }))}
                    data-testid="linkedin-text"
                  />
                </label>
                <div className="row between">
                  <span className={`counter ${len > LINKEDIN.limit ? 'over' : ''}`} data-testid="linkedin-counter">
                    {len}/{LINKEDIN.limit}
                  </span>
                  <CopyButton text={text} label="Copy post" testId="copy-post" />
                </div>
                <Messages item={item} />
              </>
            ) : null}
            <div className="row draft-controls">
              <label className="field grow">
                <span>CTA URL (optional)</span>
                <input type="url" inputMode="url" placeholder="https://…" value={s.ctaUrl} onChange={(e) => actions.setSetting(idea.id, { ctaUrl: e.target.value })} />
                {problem ? <small className="error-text">{problem}</small> : null}
              </label>
              <button type="button" className="btn" disabled={running || Boolean(problem)} onClick={() => actions.regenerate('linkedin', [idea.id])} data-testid="linkedin-regen">
                Regenerate this post
              </button>
            </div>
          </article>
        );
      })}
    </Section>
  );
}

export function XSection({ drafts, actions, onEditKeys }) {
  const { ideas, x, settings } = drafts;
  return (
    <Section
      platform="x"
      title="4. X / Twitter Agent"
      subtitle="One thread per approved idea, with the tweet count you chose."
      ideas={ideas}
      platformState={x}
      onRetryFailed={() => actions.retryFailed('x')}
      onRegenerateAll={() => actions.regenerateAll('x')}
    >
      {ideas.map((idea) => {
        const item = x.items[idea.id];
        const s = settings[idea.id];
        const problem = settingsProblem(s).tweetCount;
        const running = item.status === 'running';
        const tweets = item.draft?.tweets ?? [];
        return (
          <article key={idea.id} className="draft" data-testid="x-card" data-idea-id={idea.id} data-state={item.status}>
            <div className="row between">
              <h3>{idea.headline}</h3>
              {tweets.length ? <CopyButton text={tweets.map((t) => t.text).join('\n\n')} label="Copy thread" testId="copy-thread" /> : null}
            </div>
            {running && !item.draft ? (
              <p className="status">
                <span className="spinner" aria-hidden="true" /> Drafting…
              </p>
            ) : null}
            {item.error ? <ErrorAlert error={item.error} onEditKeys={onEditKeys} title={item.draft ? 'Regeneration failed — the previous draft is kept.' : 'This draft failed.'} /> : null}
            {tweets.length ? (
              <ol className={`tweets ${running ? 'dim' : ''}`}>
                {tweets.map((t, i) => {
                  const weight = weightedLength(t.text);
                  const over = weight > X.tweetLimit;
                  return (
                    <li key={i} className={`tweet ${over ? 'over' : ''}`} data-testid="tweet">
                      <AutoTextarea
                        aria-label={`Tweet ${i + 1} of ${tweets.length}`}
                        minRows={2}
                        value={t.text}
                        onChange={(e) =>
                          actions.editDraft('x', idea.id, (d) => ({
                            ...d,
                            tweets: d.tweets.map((tw, n) => (n === i ? { ...tw, text: e.target.value, weight: weightedLength(e.target.value) } : tw)),
                          }))
                        }
                      />
                      <div className="row between">
                        <span className={`counter ${over ? 'over' : ''}`} data-testid="tweet-counter" aria-live="polite">
                          {i + 1}/{tweets.length} · {weight}/{X.tweetLimit}
                          {over ? ' — too long' : ''}
                        </span>
                        <CopyButton text={t.text} label="Copy tweet" testId="copy-tweet" />
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {item.draft ? <Messages item={item} /> : null}
            <div className="row draft-controls">
              <label className="field">
                <span>Tweets ({X.minTweets}–{X.maxTweets})</span>
                <input
                  type="number"
                  min={X.minTweets}
                  max={X.maxTweets}
                  step="1"
                  value={Number.isNaN(s.tweetCount) ? '' : s.tweetCount}
                  onChange={(e) => actions.setSetting(idea.id, { tweetCount: e.target.value === '' ? NaN : Number(e.target.value) })}
                />
                {problem ? <small className="error-text">{problem}</small> : null}
              </label>
              <button type="button" className="btn" disabled={running || Boolean(problem)} onClick={() => actions.regenerate('x', [idea.id])} data-testid="x-regen">
                Regenerate this thread
              </button>
            </div>
          </article>
        );
      })}
    </Section>
  );
}
