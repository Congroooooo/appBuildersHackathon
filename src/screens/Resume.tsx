import { useState } from 'react';
import { ArrowRight, Play, CornerDownLeft, AppWindow, Sparkles, Clock, FileText, ChevronRight, Radio, StickyNote, Square } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { Session } from '../types';
import { RecapView, Empty, Location } from '../components';
import { duration, when, day, time } from '../format';

export function StartSession({ ctx, autoFocus = false }: { ctx: AppContext; autoFocus?: boolean }) {
  const [title, setTitle] = useState('');
  const disabled = ctx.busy || !!ctx.snapshot.active;
  const start = async () => {
    if (!title.trim()) return;
    const id = await ctx.run(() => call<string>('startSession', { title }), ctx.snapshot.settings.captureConsented ? 'Session started. Capture is recording.' : 'Session started in notes-only mode.');
    if (id) { setTitle(''); ctx.navigate({ page: 'live' }); }
  };
  return (
    <div className="command-input">
      <Play size={16} aria-hidden="true" className="muted" />
      <label htmlFor="start-title" className="sr-only">What are you working on?</label>
      <input id="start-title" autoFocus={autoFocus} value={title} maxLength={120} disabled={disabled} placeholder={ctx.snapshot.active ? 'End the current session to start another' : 'What are you working on? e.g. Fix authentication callback'}
        onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void start(); }} />
      <button className="primary small-button" disabled={disabled || !title.trim()} onClick={start}>Start session <kbd className="kbd-inline"><CornerDownLeft size={11} /></kbd></button>
    </div>
  );
}

export function SessionRow({ session, onOpen }: { session: Session; onOpen: () => void }) {
  return (
    <button className="row" onClick={onOpen}>
      <span className={`row-icon status-${session.status}`}>{session.summaryGenerator === 'model' ? <Sparkles size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}</span>
      <span className="row-main"><strong>{session.summaryTitle ?? session.title}</strong>{session.summaryTitle && session.summaryTitle !== session.title && <span className="muted"> {session.title}</span>}</span>
      <span className="row-meta">{session.status !== 'ended' ? <span className="tag tag-live">{session.status === 'active' ? 'In progress' : 'Paused'}</span> : null}{day(session.startedAt)} · {time(session.startedAt)} · {duration(session.trackedMs)}</span>
      <ChevronRight size={16} aria-hidden="true" className="row-go" />
    </button>
  );
}

export function Resume({ ctx }: { ctx: AppContext }) {
  const { snapshot, navigate, run, busy } = ctx;
  const latest = snapshot.latest;
  const summary = latest?.summary;
  const recent = snapshot.sessions.filter(s => s.id !== latest?.session.id).slice(0, 5);
  const jobForLatest = snapshot.job?.sessionId === latest?.session.id;
  return (
    <div className="page">
      {latest ? (
        <section className="hero" aria-labelledby="main-heading">
          <div className="hero-head">
            <p className="meta-pill"><Clock size={13} aria-hidden="true" /> Where you left off · {when(latest.session.endedAt ?? latest.session.startedAt)} · {duration(latest.session.trackedMs)} tracked</p>
            <h1 id="main-heading" tabIndex={-1}>{summary?.output.task_title ?? latest.session.title}</h1>
            {summary?.output.last && <p className="last-seen"><AppWindow size={15} aria-hidden="true" /> You were last in <strong>{summary.output.last.app}</strong>{summary.output.last.window ? <> — {summary.output.last.window}</> : null}</p>}
          </div>
          {summary ? <RecapView summary={summary} compact /> : (
            <div className="card">
              <p>{jobForLatest ? 'The local model is writing this recap…' : 'This session has no recap yet.'}</p>
              {!jobForLatest && <button className="primary" disabled={busy || !!snapshot.job} onClick={() => run(() => call('summarize', { sessionId: latest.session.id }), 'Recap ready.')}><Sparkles size={15} aria-hidden="true" /> Write recap on this device</button>}
            </div>
          )}
          {summary?.output.resources && summary.output.resources.length > 0 && <div className="resources">
            <h4>Where you spent time</h4>
            <ul>{summary.output.resources.slice(0, 4).map(r => <li key={`${r.app}${r.window}${r.location ?? ''}`}><span className="res-app">{r.app}</span><span className="res-window">{r.window ?? '—'}{r.location && <Location url={/^[a-z]+:\/\//i.test(r.location) ? r.location : null} path={/^[a-z]+:\/\//i.test(r.location) ? null : r.location} />}</span><span className="muted small">{duration(r.durationMs)}</span><span className="res-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, Math.round(r.durationMs / Math.max(...summary.output.resources!.map(x => x.durationMs), 1) * 100))}%` }} /></span></li>)}</ul>
          </div>}
          <div className="hero-actions">
            <button className="primary" onClick={() => navigate({ page: 'session', sessionId: latest.session.id })}>Open session details <ArrowRight size={15} aria-hidden="true" /></button>
            <button className="ghost" onClick={ctx.openPalette}>Search memory <kbd>Ctrl K</kbd></button>
          </div>
        </section>
      ) : (
        <section className="hero" aria-labelledby="main-heading">
          <h1 id="main-heading" tabIndex={-1}>Nothing to resume yet.</h1>
          <p className="lead">Start a session, work as usual, then end it. Continuum writes a short recap on this device so tomorrow-you knows exactly where to pick up.</p>
          <ol className="how">
            <li><Radio size={15} aria-hidden="true" /><span><strong>Start</strong> a session with what you're about to do</span></li>
            <li><StickyNote size={15} aria-hidden="true" /><span><strong>Work</strong> as usual and drop notes when you decide something</span></li>
            <li><Square size={14} aria-hidden="true" /><span><strong>End</strong> it — the local model writes your recap</span></li>
          </ol>
        </section>
      )}

      <section aria-label="Start a new session" className="section">
        <h2 className="section-title">Start a session</h2>
        <StartSession ctx={ctx} />
        <p className="muted small hint">{snapshot.settings.captureConsented ? 'Records foreground app and redacted window title until you pause or end.' : 'Notes-only mode: activity capture is off. Turn it on in the Privacy center.'}</p>
      </section>

      <section className="section" aria-label="Recent sessions">
        <div className="section-head"><h2 className="section-title">Recent sessions</h2>{snapshot.sessions.length > 6 && <button className="ghost small-button" onClick={() => navigate({ page: 'history' })}>All sessions <ArrowRight size={14} aria-hidden="true" /></button>}</div>
        {recent.length ? <div className="rows">{recent.map(s => <SessionRow key={s.id} session={s} onOpen={() => navigate({ page: s.status === 'ended' ? 'session' : 'live', sessionId: s.id })} />)}</div>
          : <Empty icon={<Clock size={20} aria-hidden="true" />} title="Your session history appears here" />}
      </section>
    </div>
  );
}
