import { useCallback, useEffect, useMemo, useState } from 'react';
import { APPROVALS_REQUIRED, X } from '../shared/index.js';
import { api, errorInfo } from './api.js';
import { useDrafting } from './drafting.js';
import { loadLastRunEnd, saveLastRunEnd } from './storage.js';
import ApprovalPanel from './components/ApprovalPanel.jsx';
import ErrorAlert from './components/ErrorAlert.jsx';
import IdeaCard from './components/IdeaCard.jsx';
import KeyPanel from './components/KeyPanel.jsx';
import ResearchPanel from './components/ResearchPanel.jsx';
import { LinkedInSection, XSection } from './components/DraftSections.jsx';

export default function App() {
  const [session, setSession] = useState(null); // null while loading
  const [keysOpen, setKeysOpen] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('24h');
  const [lastRunEnd, setLastRunEnd] = useState(() => loadLastRunEnd());
  const [research, setResearch] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | searching | widening
  const [selected, setSelected] = useState([]);
  const [notes, setNotes] = useState({});
  const [settings, setSettings] = useState({});
  const [widenHours, setWidenHours] = useState(168);
  const drafting = useDrafting();
  const { drafts } = drafting;

  useEffect(() => {
    let alive = true;
    api.session().then(
      (s) => {
        if (!alive) return;
        setSession(s);
        if (!s.hasOpenAI || !s.hasSerpapi) setKeysOpen(true);
      },
      (e) => {
        if (!alive) return;
        setSession({ hasOpenAI: false, hasSerpapi: false, model: '' });
        setError(errorInfo(e));
        setKeysOpen(true);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Always re-read the server's view when the key panel opens: the server may have forgotten the keys (restart).
  const editKeys = useCallback(() => {
    api.session().then(setSession, () => {});
    setKeysOpen(true);
  }, []);
  const haveKeys = Boolean(session?.hasOpenAI && session?.hasSerpapi);

  function applyResearch(res) {
    setResearch(res);
    if (res.marker.advance) {
      saveLastRunEnd(res.marker.value);
      setLastRunEnd(res.marker.value);
    }
  }

  async function runResearch() {
    setError(null);
    setPhase('searching');
    drafting.discard();
    setSelected([]);
    setNotes({});
    setSettings({});
    setResearch(null);
    try {
      applyResearch(await api.research({ mode, lastRunEnd: lastRunEnd || undefined }));
    } catch (e) {
      setError(errorInfo(e));
    } finally {
      setPhase('idle');
    }
  }

  async function widen(hours) {
    if (!research) return;
    setError(null);
    setPhase('widening');
    try {
      applyResearch(await api.widen({ runId: research.runId, hours }));
    } catch (e) {
      setError(errorInfo(e));
    } finally {
      setPhase('idle');
    }
  }

  const ideaById = useMemo(() => new Map((research?.ideas ?? []).map((i) => [i.id, i])), [research]);
  const selectedIdeas = selected.map((id) => ideaById.get(id)).filter(Boolean);

  const settingFor = (id) => ({ tweetCount: X.defaultTweets, ctaUrl: '', ...(settings[id] || {}) });

  function toggle(id) {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return cur.length >= APPROVALS_REQUIRED ? cur : [...cur, id];
    });
  }

  function startDrafting() {
    const perIdea = Object.fromEntries(selectedIdeas.map((i) => [i.id, { ...settingFor(i.id), notes: (notes[i.id] || '').trim() }]));
    drafting.start(research.runId, selectedIdeas, perIdea);
  }

  function discard() {
    const anyDone = drafts && ['linkedin', 'x'].some((p) => Object.values(drafts[p].items).some((it) => it.status === 'ok'));
    if (anyDone && !window.confirm('Discard all drafts, including any edits you made?')) return;
    drafting.discard();
  }

  function onForget() {
    drafting.discard();
    setResearch(null);
    setSelected([]);
    setSession({ hasOpenAI: false, hasSerpapi: false, model: session?.model || '' });
  }

  const started = Boolean(drafts);

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>News Search AI</h1>
          <p className="muted">Research agent → you approve three ideas → LinkedIn and X agents draft in parallel.</p>
        </div>
        <div className="row">
          {session?.model ? (
            <span className="chip" title="Model used by all three agents">
              model: {session.model}
            </span>
          ) : null}
          <button type="button" className="btn btn-small" onClick={() => (keysOpen ? setKeysOpen(false) : editKeys())} data-testid="toggle-keys">
            {haveKeys ? 'Edit API keys' : 'Add API keys'}
          </button>
        </div>
      </header>

      <ErrorAlert error={error} onEditKeys={editKeys} onDismiss={() => setError(null)} />

      {session && keysOpen ? (
        <KeyPanel
          session={session}
          onSaved={(s) => {
            setSession(s);
            setError(null);
            if (s.hasOpenAI && s.hasSerpapi) setKeysOpen(false);
          }}
          onForget={onForget}
          onClose={() => setKeysOpen(false)}
        />
      ) : null}

      <ResearchPanel
        mode={mode}
        onMode={setMode}
        lastRunEnd={lastRunEnd}
        phase={phase}
        disabled={!haveKeys}
        onRun={runResearch}
        research={research}
        onWiden={widen}
        widenHours={widenHours}
        onWidenHours={setWidenHours}
      />

      {research && research.ideas.length > 0 ? (
        <>
          <section aria-label="Ideas" className="ideas" data-testid="ideas">
            {research.ideas.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                selected={selected.includes(idea.id)}
                canSelect={selected.length < APPROVALS_REQUIRED}
                locked={started}
                notes={notes[idea.id] || ''}
                onToggle={toggle}
                onNotes={(id, v) => setNotes((cur) => ({ ...cur, [id]: v }))}
              />
            ))}
          </section>
          {!started ? (
            <ApprovalPanel
              ideas={selectedIdeas}
              settings={Object.fromEntries(selectedIdeas.map((i) => [i.id, settingFor(i.id)]))}
              onSetting={(id, patch) => setSettings((cur) => ({ ...cur, [id]: { ...settingFor(id), ...patch } }))}
              onStart={startDrafting}
            />
          ) : null}
        </>
      ) : null}

      {drafts ? (
        <>
          <div className="row between drafts-bar">
            <p className="muted">Both agents started together with the same approved ideas, sources and notes.</p>
            <button type="button" className="btn" onClick={discard} data-testid="discard">
              Discard drafts
            </button>
          </div>
          <LinkedInSection drafts={drafts} actions={drafting} onEditKeys={editKeys} />
          <XSection drafts={drafts} actions={drafting} onEditKeys={editKeys} />
        </>
      ) : null}

      <footer className="foot muted">Keys live only in this server’s memory. Drafts are suggestions: check every claim against its sources before posting.</footer>
    </div>
  );
}
