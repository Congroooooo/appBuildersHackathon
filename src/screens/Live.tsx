import { useState } from 'react';
import { Pause, Play, Square, StickyNote, AppWindow, EyeOff, Eye, ShieldAlert, Coffee, CornerDownLeft, Radio, Bot, FileDiff, GitCommitHorizontal, TerminalSquare, FolderInput } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { ActivityEvent, AgentEvent, Note, FileOp, Command } from '../types';
import { StartSession } from './Resume';
import { captureStatus, Badge, Location, useElapsed } from '../components';
import { duration, time, span } from '../format';
import { CaptureHint } from '../capture-hint';

const AGENT = { claude_code: 'Claude Code', opencode: 'OpenCode' } as const;
const agentText = (a: AgentEvent) => a.event === 'session_start' ? 'session started' : a.event === 'turn_end' ? 'finished a response' : a.event === 'file_edit' ? `edited ${a.file}` : `ran ${a.tool}${a.file ? ` on ${a.file}` : ''}`;

export function Timeline({ events, notes, agentEvents = [], fileActivity = [], commands = [], ctx, newestFirst = false }: { events: ActivityEvent[]; notes: Note[]; agentEvents?: AgentEvent[]; fileActivity?: FileOp[]; commands?: Command[]; ctx: AppContext; newestFirst?: boolean }) {
  type Entry = { at: string; event?: ActivityEvent; note?: Note; agent?: AgentEvent; file?: FileOp; cmd?: Command };
  const entries: Entry[] = [...events.map(e => ({ at: e.startedAt, event: e })), ...notes.map(n => ({ at: n.createdAt, note: n })), ...agentEvents.map(a => ({ at: a.at, agent: a })), ...fileActivity.map(f => ({ at: f.at, file: f })), ...commands.map(c => ({ at: c.at, cmd: c }))].sort((a, b) => a.at.localeCompare(b.at));
  if (newestFirst) entries.reverse();
  if (!entries.length) return <p className="muted">Nothing recorded yet. Switch to the apps you work in; visits shorter than 3 seconds are ignored.</p>;
  return (
    <ol className="timeline">
      {entries.map(entry => entry.cmd ? (
        <li key={entry.cmd.id} className="tl-command">
          <span className="tl-time">{time(entry.cmd.at)}</span>
          <span className="tl-body"><TerminalSquare size={14} aria-hidden="true" /><strong>{entry.cmd.shell}</strong><code className="tl-code">{entry.cmd.command}</code></span>
        </li>
      ) : entry.file ? (
        <li key={entry.file.id} className="tl-file">
          <span className="tl-time">{time(entry.file.at)}</span>
          <span className="tl-body"><FolderInput size={14} aria-hidden="true" /><strong>{entry.file.op === 'modified' ? 'Saved' : entry.file.op.charAt(0).toUpperCase() + entry.file.op.slice(1)}{entry.file.isDir ? ' folder' : ''}</strong><span className="tl-window">{entry.file.from ? `${entry.file.from.split(/[\\/]/).pop()} → ` : ''}{entry.file.path}</span></span>
        </li>
      ) : entry.agent ? (
        <li key={entry.agent.id} className="tl-agent">
          <span className="tl-time">{time(entry.agent.at)}</span>
          <span className="tl-body"><Bot size={14} aria-hidden="true" /><strong>{AGENT[entry.agent.agent]}</strong><span className="tl-window">{agentText(entry.agent)}</span>{entry.agent.ok === false && <span className="tag">failed</span>}<Badge kind="agent" /></span>
        </li>
      ) : entry.note ? (
        <li key={entry.note.id} className="tl-note">
          <span className="tl-time">{time(entry.note.createdAt)}</span>
          <span className="tl-body"><Badge kind="note" /> <span>{entry.note.body}</span></span>
          <button className="ghost small-button" disabled={ctx.busy} onClick={() => ctx.run(() => call('deleteNote', { id: entry.note!.id }), 'Note deleted.')}>Delete</button>
        </li>
      ) : (
        <li key={entry.event!.id} className={`tl-event ${entry.event!.hidden ? 'tl-hidden' : ''}`}>
          <span className="tl-time">{time(entry.event!.startedAt)}</span>
          <span className="tl-body">
            {entry.event!.source === 'lifecycle' ? <Coffee size={14} aria-hidden="true" /> : <AppWindow size={14} aria-hidden="true" />}
            <strong>{entry.event!.appLabel}</strong>
            {entry.event!.window && <span className="tl-window">{entry.event!.window}</span>}
            <Location path={entry.event!.path} url={entry.event!.url} />
            <span className="muted small">{duration(entry.event!.durationMs)}</span>
            {entry.event!.redacted && <span className="tag">redacted</span>}
            {entry.event!.hidden && <span className="tag">hidden from AI</span>}
          </span>
          <button className="ghost small-button" disabled={ctx.busy} aria-label={`${entry.event!.hidden ? 'Include' : 'Hide'} ${entry.event!.appLabel} ${entry.event!.window ?? ''} ${entry.event!.hidden ? 'in' : 'from'} recaps`}
            onClick={() => ctx.run(() => call('hideEvent', { id: entry.event!.id, hidden: !entry.event!.hidden }))}>
            {entry.event!.hidden ? <><Eye size={13} aria-hidden="true" /> Include</> : <><EyeOff size={13} aria-hidden="true" /> Hide</>}
          </button>
        </li>
      ))}
    </ol>
  );
}

export function NoteInput({ ctx, sessionId }: { ctx: AppContext; sessionId?: string }) {
  const [note, setNote] = useState('');
  const add = async () => { if (!note.trim()) return; const ok = await ctx.run(() => call('addNote', { text: note, sessionId }), 'Note saved.'); if (ok) setNote(''); };
  return (
    <div className="command-input">
      <StickyNote size={16} aria-hidden="true" className="muted" />
      <label htmlFor={`note-${sessionId ?? 'live'}`} className="sr-only">Add a note</label>
      <input id={`note-${sessionId ?? 'live'}`} value={note} maxLength={1000} disabled={ctx.busy} placeholder="Add a note — a decision, a blocker, what you'd do next…" onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
      <button className="secondary small-button" disabled={ctx.busy || !note.trim()} onClick={add}>Add note <kbd className="kbd-inline"><CornerDownLeft size={11} /></kbd></button>
    </div>
  );
}

export function Live({ ctx }: { ctx: AppContext }) {
  if (!ctx.snapshot.active) return (
    <div className="page">
      <h1 id="main-heading" tabIndex={-1}>No session running</h1>
      <p className="lead">Name what you're about to work on. Continuum records the apps and windows you use until you pause or end the session.</p>
      <StartSession ctx={ctx} autoFocus />
    </div>
  );
  return <LiveSession ctx={ctx} />;
}

function LiveSession({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy, navigate } = ctx;
  const active = snapshot.active!;
  const status = captureStatus(snapshot);
  const current = snapshot.capture.current;
  const s = active.session;
  const elapsed = useElapsed(s.startedAt);
  const notesOnly = status.key === 'notes';
  return (
    <div className="page">
      <p className="eyebrow"><Radio size={13} aria-hidden="true" /> Live session · started {time(s.startedAt)}</p>
      <div className="title-row">
        <h1 id="main-heading" tabIndex={-1}>{s.title}</h1>
        <div className="actions">
          {s.status === 'active'
            ? <button className="secondary" disabled={busy} onClick={() => run(() => call('pauseSession'), 'Paused. Nothing is being recorded.')}><Pause size={15} aria-hidden="true" /> Pause</button>
            : <button className="secondary" disabled={busy} onClick={() => run(() => call('resumeSession'), 'Recording resumed.')}><Play size={15} aria-hidden="true" /> Resume</button>}
          <button className="primary" disabled={busy || !!snapshot.job} onClick={() => { navigate({ page: 'session', sessionId: s.id }); void run(() => call('endSession'), undefined); }}><Square size={14} aria-hidden="true" /> End & write recap</button>
        </div>
      </div>

      <div className={`now-card status-${status.key}`}>
        <div aria-live="polite">
          <span className="now-label"><span className={`live-dot status-${status.key}`} aria-hidden="true" />{status.label}</span>
          {s.status === 'paused' ? <p>Capture is stopped. No activity is observed or saved until you resume.</p>
            : notesOnly ? <p><ShieldAlert size={15} aria-hidden="true" /> {snapshot.settings.captureConsented ? `Activity capture unavailable: ${snapshot.capture.error ?? 'unknown error'}.` : 'Activity capture is off.'} You can keep adding notes, and the recap will use them. <button className="link" onClick={() => navigate({ page: 'privacy' })}>Privacy center</button></p>
            : current ? (current.excluded ? <p><EyeOff size={15} aria-hidden="true" /> Current window is excluded and will not be saved.</p> : <p><AppWindow size={15} aria-hidden="true" /> Now: <strong>{current.appLabel}</strong>{current.window ? <> — {current.window}</> : null} <Location path={current.path} url={current.url} /> <span className="muted small">since {time(current.since)}</span></p>)
            : <p className="muted">Continuum's own window is never recorded. Switch to your work.</p>}
        </div>
        <p className="now-stats"><span><b>{active.events.length}</b> activity entr{active.events.length === 1 ? 'y' : 'ies'}</span><span><b>{active.notes.length}</b> note{active.notes.length === 1 ? '' : 's'}</span><span><b>{duration(s.trackedMs)}</b> tracked</span>{s.excludedCount ? <span><b>{s.excludedCount}</b> excluded window(s) dropped</span> : null}<span>{span(s.startedAt, null)}</span></p>
        <span className="now-timer" role="timer" aria-label={`Elapsed ${elapsed}`}>{elapsed}</span>
      </div>

      <section className="section" aria-label="Notes">
        <NoteInput ctx={ctx} />
      </section>

      {!ctx.snapshot.settings.autoTrack && <CaptureHint ctx={ctx} reason="Exact code changes, files and commands are not being recorded." />}

      {active.liveChanges && active.liveChanges.repos.length > 0 && (
        <section className="section" aria-labelledby="live-changes-heading" aria-live="polite">
          <div className="changes">
            <h4 id="live-changes-heading"><FileDiff size={13} aria-hidden="true" /> Code changes so far <span className="muted small">· checked {time(active.liveChanges.at)}</span></h4>
            <ul>{active.liveChanges.repos.flatMap(r => [
              ...r.commits.map(c => <li key={`${r.name}:${c.sha}`}><GitCommitHorizontal size={13} aria-hidden="true" /><span className="change-main">{c.subject}</span><span className="muted small">{r.name}</span></li>),
              ...r.files.map(f => (
                <li key={`${r.name}:${f.path}`}>
                  <FileDiff size={13} aria-hidden="true" />
                  <span className="change-main"><code>{f.path}</code>{f.what && <span className="change-what"> {f.what}</span>}</span>
                  <span className={`change-stat change-${f.status}`}>{f.status === 'untracked' || f.status === 'added' ? 'new' : f.added != null ? `+${f.added} −${f.deleted}` : f.status}</span>
                  <span className="muted small">{r.name}{r.shadow ? ' · folder' : ''}</span>
                </li>)),
            ])}</ul>
          </div>
        </section>
      )}

      <section className="section" aria-labelledby="timeline-heading">
        <h2 className="section-title" id="timeline-heading">Timeline</h2>
        <Timeline events={active.events} notes={active.notes} agentEvents={active.agentEvents} fileActivity={active.fileActivity} commands={active.commands} ctx={ctx} newestFirst />
      </section>
    </div>
  );
}
