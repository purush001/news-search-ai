import { WINDOW } from '../../shared/index.js';
import { formatDateTime, formatSpan } from '../format.js';

export default function ResearchPanel({ mode, onMode, lastRunEnd, phase, disabled, onRun, research, onWiden, widenHours, onWidenHours }) {
  const running = phase !== 'idle';
  const missing = research?.missingTotal ?? 0;
  const searched = research
    ? Math.max(
        (Date.parse(research.window.end) - Date.parse(research.window.start)) / 3_600_000,
        ...research.widened.map((w) => (Date.parse(research.window.end) - Date.parse(w.start)) / 3_600_000),
      )
    : 0;
  const options = WINDOW.widenOptions.filter((h) => h > searched + 0.5);

  return (
    <section className="card" aria-labelledby="research-title" data-testid="research-panel">
      <h2 id="research-title">1. Research Agent</h2>
      <fieldset className="radio-group" disabled={running}>
        <legend>Search window</legend>
        <label>
          <input type="radio" name="mode" value="24h" checked={mode === '24h'} onChange={() => onMode('24h')} />
          Past 24 hours
        </label>
        <label>
          <input type="radio" name="mode" value="since_last" checked={mode === 'since_last'} onChange={() => onMode('since_last')} />
          Since last successful run
        </label>
      </fieldset>
      {mode === 'since_last' ? (
        <p className="muted" data-testid="marker-hint">
          {lastRunEnd
            ? `Last successful run ended ${formatDateTime(lastRunEnd)}.`
            : 'No successful run is recorded yet, so the first run covers the past 24 hours.'}
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={onRun} disabled={disabled || running} data-testid="run-research">
          {phase === 'searching' ? 'Searching…' : 'Find ideas'}
        </button>
        {phase !== 'idle' ? (
          <span className="status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            {phase === 'searching' ? 'Searching news and choosing ideas…' : 'Searching wider for the missing categories…'}
          </span>
        ) : null}
      </div>

      {research ? (
        <div className="stack" data-testid="research-summary">
          <p className="window" data-testid="window">
            <strong>Search window</strong> (local time): {formatDateTime(research.window.start)} → {formatDateTime(research.window.end)}
            {research.window.effectiveMode !== research.window.mode ? ' · fell back to 24 hours' : ''}
          </p>
          {research.window.notes.map((n) => (
            <p key={n} className="notice">
              {n}
            </p>
          ))}
          {research.widened.map((w) => (
            <p key={w.start} className="notice">
              Widened to {formatDateTime(w.start)} for {w.categories.map((c) => research.quotas[c].label).join(', ')}.
            </p>
          ))}
          <ul className="quota-list" aria-label="Ideas per category">
            {Object.entries(research.quotas).map(([key, q]) => (
              <li key={key} className={q.missing ? 'quota short' : 'quota'} data-testid={`quota-${key}`}>
                {q.label}: {q.have}/{q.want}
              </li>
            ))}
          </ul>
          {research.warnings.map((w) => (
            <p key={w} className="notice warn">
              {w}
            </p>
          ))}
          {missing > 0 ? (
            <div className="alert alert-warn" data-testid="shortfall">
              <div className="alert-body">
                <strong>
                  {missing} idea{missing === 1 ? ' is' : 's are'} missing
                </strong>{' '}
                (
                {Object.values(research.quotas)
                  .filter((q) => q.missing)
                  .map((q) => `${q.label}: ${q.missing}`)
                  .join(', ')}
                ). Widen the window for only those categories; the ideas you already have stay as they are.
                {options.length === 0 ? <div className="muted">The window is already at its 30-day maximum.</div> : null}
              </div>
              {options.length ? (
                <div className="alert-actions row">
                  <label className="inline">
                    <span className="sr-only">Wider window</span>
                    <select value={options.includes(widenHours) ? widenHours : options[0]} onChange={(e) => onWidenHours(Number(e.target.value))} disabled={running} data-testid="widen-select">
                      {options.map((h) => (
                        <option key={h} value={h}>
                          Past {formatSpan(h)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn" onClick={onWiden} disabled={running} data-testid="widen">
                    Search wider for missing
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {research.marker.advance ? (
            <p className="notice ok" data-testid="marker-status">
              Run complete. Last successful run saved as {formatDateTime(research.marker.value)}.
            </p>
          ) : (
            <p className="notice warn" data-testid="marker-status">
              {research.marker.reason}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
