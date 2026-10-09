import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Circle, Pause, Play, Eye, User, Sparkles, X, LoaderCircle, Ban, Coffee, ShieldAlert, Folder, Globe, GitBranch, GitCommitHorizontal, FileDiff, Bot, Sun, Moon, Monitor, CircleCheck, CircleAlert } from 'lucide-react';
import type { Snapshot, Recap, Ref, Summary } from './types';
import { duration, time } from './format';
import type { ThemePref } from './theme';

export function useElapsed(since?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return '00:00';
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Keeps a closing overlay mounted long enough for its exit animation.
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: open || mounted, state: open ? 'open' as const : 'closed' as const };
}

export function captureStatus(snapshot: Snapshot) {
  const active = snapshot.active?.session;
  if (!active) return { key: 'idle', label: 'Not recording', detail: 'No active session' };
  if (active.status === 'paused') return { key: 'paused', label: 'Paused', detail: 'Nothing is being recorded' };
  if (!snapshot.settings.captureConsented) return { key: 'notes', label: 'Notes only', detail: 'Activity capture is off' };
  const { state, current, error } = snapshot.capture;
  if (state === 'unavailable') return { key: 'notes', label: 'Notes only', detail: error ?? 'Activity capture unavailable' };
  if (state === 'away') return { key: 'away', label: 'Recording · away', detail: 'No input for a few minutes' };
  if (state === 'recording') return { key: 'recording', label: 'Recording', detail: current ? (current.excluded ? 'Excluded app — not recorded' : current.appLabel ?? '') : 'Continuum window is never recorded' };
  return { key: 'idle', label: 'Starting capture', detail: '' };
}

export function StatusPill({ snapshot, onPause, onResume, busy }: { snapshot: Snapshot; onPause: () => void; onResume: () => void; busy: boolean }) {
  const status = captureStatus(snapshot);
  const active = snapshot.active?.session;
  const Icon = status.key === 'recording' ? Circle : status.key === 'paused' ? Pause : status.key === 'away' ? Coffee : status.key === 'notes' ? ShieldAlert : Ban;
  return (
    <div className={`status-pill status-${status.key}`} role="status" aria-live="polite">
      <Icon size={14} aria-hidden="true" className="status-icon" />
      <span><strong>{status.label}</strong>{status.detail && <span className="status-detail"> · {status.detail}</span>}</span>
      {active && (active.status === 'active'
        ? <button className="pill-action" onClick={onPause} disabled={busy}><Pause size={14} aria-hidden="true" /> Pause</button>
        : <button className="pill-action" onClick={onResume} disabled={busy}><Play size={14} aria-hidden="true" /> Resume</button>)}
    </div>
  );
}

// Folder path or web address attached to an activity entry (only when that capture category is allowed).
export function Location({ path, url }: { path?: string | null; url?: string | null }) {
  if (!path && !url) return null;
  return <span className="location" title={url ?? path ?? ''}>{url ? <Globe size={12} aria-hidden="true" /> : <Folder size={12} aria-hidden="true" />}<span>{url ?? path}</span></span>;
}

export function Badge({ kind }: { kind: 'observed' | 'note' | 'inference' | 'fallback' | 'edited' | 'git' | 'agent' }) {
  const map = {
    observed: [Eye, 'Observed'], git: [GitBranch, 'Git change'], agent: [Bot, 'Agent-reported'], note: [User, 'Your note'], inference: [Sparkles, 'AI suggestion'], fallback: [Ban, 'Not AI-generated'], edited: [User, 'Edited by you'],
  } as const;
  const [Icon, label] = map[kind];
  return <span className={`badge badge-${kind}`}><Icon size={12} aria-hidden="true" />{label}</span>;
}

export function refLabel(id: string, ref: Ref | undefined) {
  if (!ref) return `${id}: no longer available`;
  if (ref.kind === 'note') return `${id}: your note “${ref.text}”`;
  if (ref.kind === 'file') return `${id}: ${ref.op}${ref.isDir ? ' folder' : ''} ${ref.from ? `${ref.from} → ` : ''}${ref.path}${ref.count && ref.count > 1 ? ` (${ref.count}×)` : ''}${ref.at ? ` at ${time(ref.at)}` : ''}`;
  if (ref.kind === 'page') return `${id}: read “${ref.title}” (${ref.host})${ref.selections?.length ? ` and highlighted “${ref.selections[0].slice(0, 80)}”` : ''}`;
  if (ref.kind === 'search') return `${id}: searched ${ref.engine} for “${ref.query}”${ref.at ? ` at ${time(ref.at)}` : ''}`;
  if (ref.kind === 'command') return `${id}: ran ${ref.command} in ${ref.shell}${ref.at ? ` at ${time(ref.at)}` : ''}`;
  if (ref.kind === 'agent') return `${id}: ${ref.agent} ${ref.event === 'tool' ? `ran ${ref.tool}${ref.path ? ` on ${ref.path}` : ''}` : ref.event === 'file_edit' ? `edited ${ref.path}` : ref.event === 'turn_end' ? 'finished a response' : 'started a session'}${ref.count && ref.count > 1 ? ` (${ref.count}×)` : ''}`;
  if (ref.kind === 'git') return ref.commit ? `${id}: commit ${ref.commit} “${ref.subject}” in ${ref.repo}` : `${id}: ${ref.status} ${ref.path} in ${ref.repo}${ref.added != null ? ` (+${ref.added} −${ref.deleted})` : ''}`;
  return `${id}: ${ref.app}${ref.window ? ` — ${ref.window}` : ''}${ref.startedAt ? ` at ${time(ref.startedAt)}` : ''}${ref.durationMs ? ` for ${duration(ref.durationMs)}` : ''}`;
}

export function EvidenceChips({ ids, refs, selected, onSelect }: { ids: string[]; refs?: Record<string, Ref>; selected?: string | null; onSelect: (id: string) => void }) {
  if (!ids.length) return null;
  return (
    <span className="chips">
      {ids.map(id => (
        <button key={id} className={`chip ${refs?.[id]?.kind === 'note' ? 'chip-note' : refs?.[id]?.kind === 'git' ? 'chip-git' : refs?.[id]?.kind === 'agent' ? 'chip-agent' : ''} ${selected === id ? 'chip-selected' : ''}`} aria-pressed={selected === id} aria-label={`Show evidence ${refLabel(id, refs?.[id])}`} title={refLabel(id, refs?.[id])} onClick={() => onSelect(id)}>{id}</button>
      ))}
    </span>
  );
}

// Small red/green view of a change excerpt ("-" removed, "+" added, "…" skipped lines).
export function DiffView({ diff }: { diff: string }) {
  return <pre className="diff" aria-label="Changed lines">{diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-ctx'}>{line || ' '}{'\n'}</span>)}</pre>;
}

export function EvidenceDetail({ id, refs, onClose }: { id: string; refs?: Record<string, Ref>; onClose: () => void }) {
  const ref = refs?.[id];
  return (
    <div className="evidence-detail" role="region" aria-label={`Evidence ${id}`}>
      <div className="evidence-head"><strong>Evidence {id}</strong><button className="icon-button" onClick={onClose} aria-label="Close evidence"><X size={16} /></button></div>
      {!ref ? <p>This evidence is no longer available.</p> : ref.kind === 'file' || ref.kind === 'command' || ref.kind === 'search' || ref.kind === 'page'
        ? <><Badge kind="observed" /><p>{ref.kind === 'command' ? <code>{ref.command}</code> : refLabel(id, ref).replace(`${id}: `, '')}</p><p className="muted small">{ref.kind === 'command' ? `Typed in ${ref.shell} at ${time(ref.at)}. Running a command does not show whether it succeeded.` : ref.kind === 'search' ? 'Read from the address of the search page.' : ref.kind === 'page' ? 'Sent by the Continuum browser extension (page text you saw or highlighted).' : 'Seen on disk through Windows file notifications (any app).'}</p></>
        : ref.kind === 'agent'
        ? <><Badge kind="agent" /><p><Bot size={13} aria-hidden="true" /> {refLabel(id, ref).replace(`${id}: `, '')}{ref.ok === false ? ' — reported a failure' : ''}</p><p className="muted small">Reported by the coding agent at {time(ref.at)}{ref.project ? ` in ${ref.project}` : ''}. Agent reports are not verified results.</p></>
        : ref.kind === 'git'
        ? <><Badge kind="git" /><p>{ref.commit ? <><GitCommitHorizontal size={13} aria-hidden="true" /> Commit <code>{ref.commit}</code> “{ref.subject}”</> : <><FileDiff size={13} aria-hidden="true" /> <code>{ref.path}</code> · {ref.status}{ref.added != null ? ` · +${ref.added} −${ref.deleted} lines` : ''}</>}</p>{ref.what && <p className="change-what-detail">{ref.what}</p>}{ref.diff && <DiffView diff={ref.diff} />}<p className="muted small">{ref.shadow ? `Project folder ${ref.repo} (compared with its snapshot at session start)` : `Repository ${ref.repo}${ref.branch ? ` · branch ${ref.branch}` : ''}`}. A change shows a file was edited, not that it works.</p></>
        : ref.kind === 'note'
        ? <><Badge kind="note" /><p className="quote">“{ref.text}”</p><p className="muted small">Written {time(ref.createdAt)}</p></>
        : <><Badge kind="observed" /><p><strong>{ref.app}</strong>{ref.window ? <> — {ref.window}</> : null}</p>{ref.location && <p><Location url={/^[a-z]+:\/\//i.test(ref.location) ? ref.location : null} path={/^[a-z]+:\/\//i.test(ref.location) ? null : ref.location} /></p>}<p className="muted small">Foreground from {time(ref.startedAt)} for {duration(ref.durationMs ?? 0)} · {ref.eventIds?.length ?? 0} recorded event(s)</p></>}
    </div>
  );
}

export function RecapView({ summary, compact = false }: { summary: Summary; compact?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const r: Recap = summary.output;
  const toggle = (id: string) => setSelected(current => current === id ? null : id);
  const evidenceKind = (ids: string[]) => ids.length && ids.every(id => r.refs?.[id]?.kind === 'note') ? 'note' : ids.length && ids.every(id => r.refs?.[id]?.kind === 'git') ? 'git' : ids.length && ids.every(id => r.refs?.[id]?.kind === 'agent') ? 'agent' : 'observed';
  return (
    <div className="recap">
      <div className="recap-meta">
        {summary.generator === 'fallback' ? <Badge kind="fallback" /> : <span className="badge badge-model"><Sparkles size={12} aria-hidden="true" />Local AI recap · {summary.modelId}</span>}
        {summary.edited && <Badge kind="edited" />}
        <span className={`confidence confidence-${r.confidence}`}>Confidence: {r.confidence}</span>
        {summary.elapsedMs ? <span className="muted small">{(summary.elapsedMs / 1000).toFixed(1)} s on this device</span> : null}
      </div>
      <p className="recap-text">{r.recap}</p>
      {selected && <EvidenceDetail id={selected} refs={r.refs} onClose={() => setSelected(null)} />}
      {r.files && r.files.length > 0 && <div className="changes">
        <h4><FileDiff size={13} aria-hidden="true" /> Files you worked on</h4>
        <ul>{r.files.slice(0, compact ? 5 : 12).map(f => (
          <li key={`${f.project}|${f.file}`}>
            <EvidenceChips ids={f.evidence.slice(0, 2)} refs={r.refs} selected={selected} onSelect={toggle} />
            <span className="change-main"><code>{f.file}</code>{f.project && <span className="muted small"> · {f.project}</span>}</span>
            {f.edited && <span className="change-stat change-untracked">edited</span>}
            <span className="muted small">{duration(f.durationMs)} in {f.app}</span>
          </li>))}</ul>
      </div>}
      {r.changes && r.changes.length > 0 && <div className="changes">
        <h4><GitBranch size={13} aria-hidden="true" /> Changes in your code</h4>
        <ul>{r.changes.slice(0, compact ? 5 : 20).map(c => (
          <li key={c.id}>
            <button className={`chip chip-git ${selected === c.id ? 'chip-selected' : ''}`} aria-pressed={selected === c.id} aria-label={`Show evidence ${refLabel(c.id, c)}`} onClick={() => toggle(c.id)}>{c.id}</button>
            {c.commit ? <><GitCommitHorizontal size={13} aria-hidden="true" /><span className="change-main">{c.subject}</span><code className="muted">{c.commit}</code></>
              : <><FileDiff size={13} aria-hidden="true" /><span className="change-main"><code>{c.path}</code>{c.what && <span className="change-what"> {c.what}</span>}</span><span className={`change-stat change-${c.status}`}>{c.status === 'untracked' ? 'new' : c.added != null ? <><span className="plus">+{c.added}</span> <span className="minus">−{c.deleted}</span></> : c.status}</span></>}
            <span className="muted small">{c.repo}{c.shadow ? ' · folder' : ''}{c.diff ? ' · lines' : ''}</span>
          </li>))}</ul>
        {compact && r.changes.length > 5 && <p className="muted small">+{r.changes.length - 5} more in session details</p>}
      </div>}
      <div className={compact ? 'recap-grid compact' : 'recap-grid'}>
        <section>
          <h4>What happened</h4>
          <ul className="claims">{r.observed.map((o, i) => <li key={i}><Badge kind={evidenceKind(o.evidence)} /> <span>{o.text}</span> <EvidenceChips ids={o.evidence} refs={r.refs} selected={selected} onSelect={toggle} /></li>)}</ul>
          {r.decisions.length > 0 && <><h4>Decisions you noted</h4><ul className="claims">{r.decisions.map((d, i) => <li key={i}><Badge kind="note" /> <span>{d.text}</span> <EvidenceChips ids={d.evidence} refs={r.refs} selected={selected} onSelect={toggle} /></li>)}</ul></>}
        </section>
        <section>
          <h4>Suggested next steps</h4>
          <ol className="claims next">{r.next_steps.map((n, i) => <li key={i}><Badge kind={n.edited ? 'edited' : 'inference'} /> <span>{n.text}</span> <EvidenceChips ids={n.evidence} refs={r.refs} selected={selected} onSelect={toggle} /></li>)}</ol>
          {r.open_questions.length > 0 && <><h4>Open questions</h4><ul className="plain">{r.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul></>}
        </section>
      </div>
      {!compact && <p className="limitations"><strong>Limits:</strong> {r.limitations.join(' ')}</p>}
    </div>
  );
}

export function JobBanner({ stage, onCancel }: { stage: string; onCancel: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const started = Date.now(); const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500); return () => clearInterval(t); }, []);
  return (
    <div className="job-banner" role="status" aria-live="polite">
      <LoaderCircle size={18} className="spin" aria-hidden="true" />
      <span><strong>{stage}</strong> <span className="muted">· {seconds}s</span></span>
      <button className="secondary small-button" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger = true, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  // Focus once on open; live snapshot updates re-render the dialog and must not move focus.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-body">
        <h2 id="dialog-title">{title}</h2>
        <div id="dialog-body">{body}</div>
        <div className="dialog-actions">
          <button ref={cancelRef} className="secondary" onClick={onCancel}>Cancel</button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<h3>{title}</h3>{children}</div>;
}

export function ListEditor({ label, values, onChange, placeholder, disabled }: { label: string; values: string[]; onChange: (values: string[]) => void; placeholder: string; disabled?: boolean }) {
  const [draft, setDraft] = useState('');
  const id = `list-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const add = () => { const v = draft.trim().toLowerCase(); if (v && !values.includes(v)) onChange([...values, v]); setDraft(''); };
  return (
    <div className="list-editor">
      <label htmlFor={id}>{label}</label>
      <div className="tag-list" role="list" aria-label={label}>
        {values.map(v => <span role="listitem" className="tag" key={v}>{v}<button className="tag-remove" disabled={disabled} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter(x => x !== v))}><X size={12} /></button></span>)}
      </div>
      <div className="inline-form">
        <input id={id} value={draft} disabled={disabled} maxLength={80} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button className="secondary" disabled={disabled || !draft.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

const THEMES = [['system', Monitor, 'System theme'], ['light', Sun, 'Light theme'], ['dark', Moon, 'Dark theme']] as const;

export function ThemeSwitch({ pref, choose }: { pref: ThemePref; choose: (next: ThemePref, origin?: { x: number; y: number }) => void }) {
  const index = THEMES.findIndex(([value]) => value === pref);
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      <span className="theme-thumb" aria-hidden="true" style={{ transform: `translateX(${index * 100}%)` }} />
      {THEMES.map(([value, Icon, label]) => (
        <button key={value} aria-label={label} title={label} aria-pressed={pref === value} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); choose(value, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }}>
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function Toast({ text, error, state, ms }: { text: string; error: boolean; state: 'open' | 'closed'; ms: number }) {
  return (
    <div className={`toast ${error ? 'toast-error' : ''}`} data-state={state} role={error ? 'alert' : 'status'} style={{ ['--toast-ms' as string]: `${ms}ms` }}>
      {error ? <CircleAlert size={16} aria-hidden="true" /> : <CircleCheck size={16} aria-hidden="true" />}<span>{text}</span>
    </div>
  );
}
