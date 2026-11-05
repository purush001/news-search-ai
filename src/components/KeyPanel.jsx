import { useState } from 'react';
import { api, errorInfo } from '../api.js';
import ErrorAlert from './ErrorAlert.jsx';

/**
 * Masked key entry. Each key is sent once to the local server, verified with a free call and kept
 * only in server memory. Typed values are cleared after a successful save and never stored here.
 */
export default function KeyPanel({ session, onSaved, onForget, onClose }) {
  const [openaiKey, setOpenaiKey] = useState('');
  const [serpapiKey, setSerpapiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    const body = {};
    if (openaiKey.trim()) body.openaiKey = openaiKey.trim();
    if (serpapiKey.trim()) body.serpapiKey = serpapiKey.trim();
    if (!body.openaiKey && !body.serpapiKey) {
      setError({ code: 'bad_request', message: 'Enter at least one key.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const status = await api.saveKeys(body);
      setOpenaiKey('');
      setSerpapiKey('');
      onSaved(status);
    } catch (err) {
      setError(errorInfo(err));
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    try {
      await api.clearSession();
      setOpenaiKey('');
      setSerpapiKey('');
      setError(null);
      onForget();
    } catch (err) {
      setError(errorInfo(err));
    } finally {
      setBusy(false);
    }
  }

  const haveBoth = session?.hasOpenAI && session?.hasSerpapi;

  return (
    <section className="card" aria-labelledby="keys-title" data-testid="key-panel">
      <div className="card-head">
        <h2 id="keys-title">API keys</h2>
        {haveBoth && onClose ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      <p className="muted">
        Each key is sent once to this app’s local server, checked with a call that costs nothing, and held only in the
        server’s memory. It is never stored in the browser or returned to it.
      </p>
      <form onSubmit={save} autoComplete="off" className="stack">
        <label className="field">
          <span>
            OpenAI API key <Chip ok={session?.hasOpenAI} />
          </span>
          <input
            type="password"
            name="nsai-openai"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder={session?.hasOpenAI ? 'Saved — type to replace' : 'sk-…'}
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
          />
        </label>
        <label className="field">
          <span>
            SerpAPI key <Chip ok={session?.hasSerpapi} />
          </span>
          <input
            type="password"
            name="nsai-serpapi"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder={session?.hasSerpapi ? 'Saved — type to replace' : 'SerpAPI key'}
            value={serpapiKey}
            onChange={(e) => setSerpapiKey(e.target.value)}
          />
        </label>
        <ErrorAlert error={error} />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Checking…' : 'Save & verify'}
          </button>
          {session?.hasOpenAI || session?.hasSerpapi ? (
            <button type="button" className="btn" onClick={forget} disabled={busy}>
              Forget keys
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function Chip({ ok }) {
  return <em className={`chip ${ok ? 'chip-ok' : 'chip-warn'}`}>{ok ? 'saved' : 'not set'}</em>;
}
