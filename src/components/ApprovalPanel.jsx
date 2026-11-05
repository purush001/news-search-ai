import { APPROVALS_REQUIRED, X } from '../../shared/index.js';
import { settingsProblem } from '../drafting.js';

export default function ApprovalPanel({ ideas, settings, onSetting, onStart, starting }) {
  const count = ideas.length;
  const problems = ideas.map((i) => settingsProblem(settings[i.id]));
  const valid = count === APPROVALS_REQUIRED && problems.every((p) => Object.keys(p).length === 0);
  return (
    <section className="card approval" aria-labelledby="approve-title" data-testid="approval-panel">
      <h2 id="approve-title">2. Approve exactly {APPROVALS_REQUIRED} ideas</h2>
      <p role="status" data-testid="approval-count">
        {count} of {APPROVALS_REQUIRED} approved. Nothing is drafted until you start below.
      </p>
      {count > 0 ? (
        <div className="settings-grid">
          {ideas.map((idea, i) => (
            <fieldset key={idea.id} className="setting">
              <legend>{idea.headline}</legend>
              <label className="field">
                <span>X thread: number of tweets ({X.minTweets}–{X.maxTweets})</span>
                <input
                  type="number"
                  min={X.minTweets}
                  max={X.maxTweets}
                  step="1"
                  inputMode="numeric"
                  value={Number.isNaN(settings[idea.id].tweetCount) ? '' : settings[idea.id].tweetCount}
                  onChange={(e) => onSetting(idea.id, { tweetCount: e.target.value === '' ? NaN : Number(e.target.value) })}
                  data-testid="tweet-count"
                />
                {problems[i].tweetCount ? <small className="error-text">{problems[i].tweetCount}</small> : null}
              </label>
              <label className="field">
                <span>LinkedIn call-to-action URL (optional)</span>
                <input type="url" inputMode="url" placeholder="https://…" value={settings[idea.id].ctaUrl} onChange={(e) => onSetting(idea.id, { ctaUrl: e.target.value })} data-testid="cta-url" />
                {problems[i].ctaUrl ? <small className="error-text">{problems[i].ctaUrl}</small> : <small className="muted">Blank: no CTA, source links only.</small>}
              </label>
            </fieldset>
          ))}
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!valid || starting} onClick={onStart} data-testid="start-drafting">
          Approve these {APPROVALS_REQUIRED} ideas &amp; start drafting
        </button>
      </div>
    </section>
  );
}
