import { CATEGORIES, APPROVALS_REQUIRED, MAX_NOTES_CHARS } from '../../shared/index.js';
import { formatPublished } from '../format.js';

export default function IdeaCard({ idea, selected, canSelect, notes, onToggle, onNotes, locked }) {
  const disabled = locked || (!selected && !canSelect);
  const id = idea.id;
  return (
    <article className={`card idea ${selected ? 'selected' : ''}`} data-testid="idea-card" data-idea-id={id} data-category={idea.category}>
      <div className="idea-head">
        <span className={`badge badge-${idea.category}`}>{CATEGORIES[idea.category].label}</span>
        <button
          type="button"
          className={`btn ${selected ? 'btn-primary' : ''}`}
          aria-pressed={selected}
          disabled={disabled}
          onClick={() => onToggle(id)}
          title={!selected && !canSelect ? `Only ${APPROVALS_REQUIRED} ideas can be approved` : undefined}
          data-testid="approve-toggle"
        >
          {selected ? '✓ Approved' : 'Approve'}
        </button>
      </div>
      <h3>{idea.headline}</h3>
      <p>{idea.summary}</p>
      <p>
        <strong>Proposed angle:</strong> {idea.angle}
      </p>
      <div className="split">
        <div className="panel panel-confirmed">
          <h4>Confirmed by sources</h4>
          <p>{idea.confirmed}</p>
        </div>
        <div className="panel panel-inference">
          <h4>Proposed application (our inference)</h4>
          <p>{idea.application}</p>
        </div>
      </div>
      <ul className="sources" aria-label="Sources">
        {idea.sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.title}
            </a>
            <span className="muted">
              {' '}
              — {s.source} · {formatPublished(s)}
            </span>
            {s.primary ? <span className="chip chip-ok">primary source</span> : null}
          </li>
        ))}
      </ul>
      <label className="field">
        <span>Editorial notes for the writers (optional)</span>
        <textarea rows={2} maxLength={MAX_NOTES_CHARS} value={notes} disabled={locked} onChange={(e) => onNotes(id, e.target.value)} placeholder="Angle to stress, audience context, things to avoid…" />
      </label>
    </article>
  );
}
