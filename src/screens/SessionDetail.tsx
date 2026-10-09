import { useEffect, useState } from 'react';
import { Sparkles, Pencil, Trash2, RefreshCw, ArrowLeft, Check, Clock, AppWindow } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { Detail } from '../types';
import { RecapView, ConfirmDialog, Empty } from '../components';
import { SessionReport } from '../report';
import { CaptureHint } from '../capture-hint';
import { Timeline, NoteInput } from './Live';
import { duration, span, day } from '../format';

export function SessionDetail({ ctx, sessionId }: { ctx: AppContext; sessionId: string }) {
  const { snapshot, run, busy, navigate } = ctx;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState({ taskTitle: '', recap: '', nextSteps: '' });
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  useEffect(() => {
    let live = true;
    call<Detail>('sessionDetail', { id: sessionId }).then(d => { if (live) { setDetail(d); setMissing(false); } }).catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [sessionId, snapshot]);

  if (missing) return <div className="page"><h1 id="main-heading" tabIndex={-1}>Session not found</h1><p className="muted">It may have been deleted.</p><button className="secondary" onClick={() => navigate({ page: 'history' })}><ArrowLeft size={15} aria-hidden="true" /> All sessions</button></div>;
  if (!detail) return <div className="page" aria-busy="true"><p className="muted">Decrypting session…</p><div className="skeleton" aria-hidden="true"><i style={{ height: 32, width: '60%' }} /><i /><i /><i /></div></div>;
  const { session, summary } = detail;
  const working = snapshot.job?.sessionId === session.id;

  const startEdit = () => {
    if (!summary) return;
    setForm({ taskTitle: summary.output.task_title, recap: summary.output.recap, nextSteps: summary.output.next_steps.map(n => n.text).join('\n') });
    setEditing(true);
  };
  const save = async () => {
    const result = await run(() => call<{ indexError: string | null }>('editSummary', { sessionId: session.id, taskTitle: form.taskTitle, recap: form.recap, nextSteps: form.nextSteps.split('\n').map(s => s.trim()).filter(Boolean) }), 'Recap updated.');
    if (result) setEditing(false);
  };

  return (
    <div className="page">
      <button className="ghost back" onClick={() => navigate({ page: 'history' })}><ArrowLeft size={15} aria-hidden="true" /> Sessions</button>
      <p className="eyebrow"><Clock size={13} aria-hidden="true" /> {day(session.startedAt)} · {span(session.startedAt, session.endedAt)} · {duration(session.trackedMs)} tracked · {session.eventCount} entr{session.eventCount === 1 ? 'y' : 'ies'} · {session.noteCount} note{session.noteCount === 1 ? '' : 's'}{detail.indexed ? ' · searchable' : ''}</p>
      <div className="title-row">
        {renaming ? (
          <div className="inline-form grow">
            <label htmlFor="rename" className="sr-only">Session name</label>
            <input id="rename" value={title} maxLength={120} onChange={e => setTitle(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Escape') setRenaming(false); }} />
            <button className="primary small-button" disabled={busy || !title.trim()} onClick={async () => { await run(() => call('renameSession', { id: session.id, title }), 'Renamed.'); setRenaming(false); }}><Check size={14} aria-hidden="true" /> Save</button>
          </div>
        ) : <h1 id="main-heading" tabIndex={-1}>{session.title} <button className="icon-button" aria-label="Rename session" onClick={() => { setTitle(session.title); setRenaming(true); }}><Pencil size={14} /></button></h1>}
        {session.status !== 'ended' && <button className="secondary" onClick={() => navigate({ page: 'live' })}>Open live view</button>}
      </div>
      {session.lastApp && <p className="last-seen"><AppWindow size={15} aria-hidden="true" /> Last seen in <strong>{session.lastApp}</strong>{session.lastWindow ? <> — {session.lastWindow}</> : null}</p>}

      <section className="panel" aria-labelledby="recap-heading">
        <div className="section-head">
          <h2 className="section-title" id="recap-heading"><Sparkles size={15} aria-hidden="true" /> What Continuum remembers</h2>
          {summary && !editing && <div className="actions">
            <button className="ghost small-button" onClick={startEdit} disabled={busy}><Pencil size={13} aria-hidden="true" /> Correct</button>
            <button className="ghost small-button" disabled={busy || !!snapshot.job || session.status !== 'ended'} onClick={() => run(() => call('summarize', { sessionId: session.id }), 'New recap ready.')}><RefreshCw size={13} aria-hidden="true" /> Regenerate</button>
          </div>}
        </div>
        {working && !summary ? <p className="muted">The local model is reading this session's timeline. This usually takes 20–40 seconds on this laptop.</p>
          : editing && summary ? (
            <div className="edit-form">
              <label htmlFor="edit-title">Task</label>
              <input id="edit-title" value={form.taskTitle} maxLength={90} onChange={e => setForm({ ...form, taskTitle: e.target.value })} />
              <label htmlFor="edit-recap">Recap</label>
              <textarea id="edit-recap" value={form.recap} maxLength={600} rows={3} onChange={e => setForm({ ...form, recap: e.target.value })} />
              <label htmlFor="edit-next">Next steps (one per line, up to 3)</label>
              <textarea id="edit-next" value={form.nextSteps} rows={3} onChange={e => setForm({ ...form, nextSteps: e.target.value })} />
              <div className="actions"><button className="ghost" onClick={() => setEditing(false)}>Cancel</button><button className="primary" disabled={busy || !form.taskTitle.trim() || !form.recap.trim()} onClick={save}>Save correction</button></div>
            </div>
          ) : summary ? <RecapView key={summary.id} summary={summary} />
          : session.status === 'ended' ? <Empty icon={<Sparkles size={20} aria-hidden="true" />} title="No recap yet"><button className="primary" disabled={busy || !!snapshot.job} onClick={() => run(() => call('summarize', { sessionId: session.id }), 'Recap ready.')}>Write recap on this device</button></Empty>
          : <p className="muted">The recap is written when you end the session.</p>}
      </section>

      {summary?.output.files?.some(f => f.edited) && !(summary.output.changes ?? []).some(c => c.path) && <CaptureHint ctx={ctx} reason="You edited files, but the exact changes were not captured." />}
      {summary?.output.report && <section className="section" aria-labelledby="report-heading"><h2 className="section-title" id="report-heading">Session report</h2><SessionReport detail={detail} /></section>}

      <section className="section" aria-labelledby="tl-heading">
        <h2 className="section-title" id="tl-heading">Evidence timeline</h2>
        <p className="muted small">Hide anything you don't want in future recaps. Regenerate the recap afterwards to update it.</p>
        <NoteInput ctx={ctx} sessionId={session.id} />
        <Timeline events={detail.events} notes={detail.notes} agentEvents={detail.agentEvents} fileActivity={detail.fileActivity} commands={detail.commands} ctx={ctx} />
      </section>

      <section className="section danger-zone" aria-label="Delete session">
        <button className="danger-outline" disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={15} aria-hidden="true" /> Delete this session</button>
        <span className="muted small">Removes its activity, notes, recap and search index.</span>
      </section>
      {confirm && <ConfirmDialog title="Delete this session?" confirmLabel="Delete session"
        body={<p>“{session.title}” and everything derived from it (activity entries, notes, Git records, agent reports, AI recap and search embeddings) will be permanently removed from Continuum's database.</p>}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); const ok = await run(() => call('deleteSession', { id: session.id }), 'Session deleted.'); if (ok) navigate({ page: 'history' }); }} />}
    </div>
  );
}
