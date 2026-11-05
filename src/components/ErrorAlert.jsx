import { isKeyError } from '../api.js';

/** Clear provider/server errors. Key problems get an "Edit API keys" action. */
export default function ErrorAlert({ error, onEditKeys, onDismiss, title }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert" data-testid="error-alert" data-code={error.code}>
      <div className="alert-body">
        <strong>{title || error.message}</strong>
        {title ? <div>{error.message}</div> : null}
        {error.hint ? <div className="muted">{error.hint}</div> : null}
        {error.retryAfter != null ? <div className="muted">Retry in about {error.retryAfter}s.</div> : null}
        {error.detail ? (
          <details>
            <summary>Details</summary>
            <code>{error.detail}</code>
          </details>
        ) : null}
      </div>
      <div className="alert-actions">
        {isKeyError(error) && onEditKeys ? (
          <button type="button" className="btn btn-small" onClick={onEditKeys}>
            Edit API keys
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onDismiss} aria-label="Dismiss error">
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
