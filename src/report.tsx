import { useState } from 'react';
import { BookOpen, Highlighter, Search, AppWindow, Globe, FileDiff, FolderPlus, FilePlus, FileX, FolderX, FilePen, ArrowRight, TerminalSquare, GitCommitHorizontal, Bot, StickyNote, ChevronDown, FolderInput } from 'lucide-react';
import type { Detail, SessionReportData } from './types';
import { duration, time } from './format';

// Organized, easy-to-read account of how the session went: built from recorded evidence, not from the AI.
function Section({ icon, title, count, children, open = true }: { icon: React.ReactNode; title: string; count?: number; children: React.ReactNode; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  return (
    <section className="report-section">
      <button className="report-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {icon}<span className="report-title">{title}</span>{count !== undefined && <span className="report-count">{count}</span>}<ChevronDown size={14} aria-hidden="true" className={`report-chevron ${expanded ? 'open' : ''}`} />
      </button>
      {expanded && <div className="report-body">{children}</div>}
    </section>
  );
}

const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
const folder = (path: string) => path.split(/[\\/]/).slice(0, -1).join('\\');

export function SessionReport({ detail }: { detail: Detail }) {
  const output = detail.summary?.output;
  const report: SessionReportData | undefined = output?.report;
  if (!output || !report) return null;
  const { created, deleted, renamed, modified } = report.files;
  const fileCount = created.length + deleted.length + renamed.length + modified.length;
  const code = output.changes ?? [];
  const notes = detail.notes;
  const agent = detail.agentEvents ?? [];
  const totalMs = report.apps.reduce((sum, a) => sum + a.durationMs, 0) || 1;
  return (
    <div className="report" aria-label="Session report">
      {code.length > 0 && (
        <Section icon={<FileDiff size={15} aria-hidden="true" />} title="Code changes" count={code.filter(c => c.path).length}>
          <ul className="report-list">{code.map(c => c.commit
            ? <li key={c.id}><GitCommitHorizontal size={13} aria-hidden="true" /><span><strong>Commit</strong> {c.subject} <code className="muted">{c.commit}</code></span><span className="muted small">{c.repo}</span></li>
            : <li key={c.id}><FilePen size={13} aria-hidden="true" /><span><code>{c.path}</code>{c.what ? <span className="report-what"> — {c.what}</span> : <span className="muted"> — {c.status}{c.added != null ? ` (+${c.added} −${c.deleted})` : ''}</span>}</span><span className="muted small">{c.repo}{c.shadow ? ' · folder' : ''}</span></li>)}</ul>
        </Section>
      )}

      {fileCount > 0 && (
        <Section icon={<FolderInput size={15} aria-hidden="true" />} title="Files and folders" count={fileCount}>
          <ul className="report-list">
            {created.map(f => <li key={f.id}>{f.isDir ? <FolderPlus size={13} aria-hidden="true" /> : <FilePlus size={13} aria-hidden="true" />}<span><strong>Created {f.isDir ? 'folder' : 'file'}</strong> <code>{name(f.path)}</code></span><span className="muted small">{folder(f.path)}</span></li>)}
            {renamed.map(f => <li key={f.id}><ArrowRight size={13} aria-hidden="true" /><span><strong>Renamed</strong> <code>{name(f.from ?? '')}</code> → <code>{name(f.path)}</code></span><span className="muted small">{folder(f.path)}</span></li>)}
            {deleted.map(f => <li key={f.id}>{f.isDir ? <FolderX size={13} aria-hidden="true" /> : <FileX size={13} aria-hidden="true" />}<span><strong>Deleted {f.isDir ? 'folder' : 'file'}</strong> <code>{name(f.path)}</code></span><span className="muted small">{folder(f.path)}</span></li>)}
            {modified.map(f => <li key={f.id}><FilePen size={13} aria-hidden="true" /><span><strong>Saved</strong> <code>{name(f.path)}</code>{f.count > 1 ? <span className="muted"> · {f.count}×</span> : null}</span><span className="muted small">{folder(f.path)}</span></li>)}
          </ul>
        </Section>
      )}

      {report.commands.length > 0 && (
        <Section icon={<TerminalSquare size={15} aria-hidden="true" />} title="Terminal commands" count={report.commands.length}>
          <ol className="report-commands">{report.commands.map(c => <li key={c.id}><span className="muted small">{time(c.at)}</span><code>{c.command}</code><span className="muted small">{c.shell}</span></li>)}</ol>
        </Section>
      )}

      {(report.pages?.length ?? 0) > 0 && (
        <Section icon={<BookOpen size={15} aria-hidden="true" />} title="Pages read" count={report.pages!.length}>
          <ul className="report-list">{report.pages!.map(p => (
            <li key={p.id}><BookOpen size={13} aria-hidden="true" /><span>
              <strong>{p.title || p.host}</strong> <span className="muted small">{p.host}</span>
              {p.headings.length > 0 && <span className="report-pages">{p.headings.map(h => <span key={h} className="muted small">• {h}</span>)}</span>}
              {p.selections.map((s, i) => <span key={i} className="report-highlight"><Highlighter size={12} aria-hidden="true" /> “{s}”</span>)}
              {!p.selections.length && p.excerpt && <span className="report-excerpt">{p.excerpt}…</span>}
            </span><span className="muted small">{time(p.at)}</span></li>))}</ul>
        </Section>
      )}

      {(report.searches?.length ?? 0) > 0 && (
        <Section icon={<Search size={15} aria-hidden="true" />} title="Web searches" count={report.searches!.length}>
          <ol className="report-commands">{report.searches!.map(q => <li key={q.id}><span className="muted small">{time(q.at)}</span><span className="report-query">“{q.query}”</span><span className="muted small">{q.engine}</span></li>)}</ol>
        </Section>
      )}

      {report.sites.length > 0 && (
        <Section icon={<Globe size={15} aria-hidden="true" />} title="Websites" count={report.sites.length} open={false}>
          <ul className="report-list">{report.sites.map(s => <li key={s.host}><Globe size={13} aria-hidden="true" /><span><strong>{s.host}</strong>{s.pages.length > 1 ? <span className="muted"> · {s.pages.length} pages</span> : null}<span className="report-pages">{s.pages.slice(0, 3).map(p => <code key={p}>{p}</code>)}</span></span><span className="muted small">{duration(s.durationMs)}</span></li>)}</ul>
        </Section>
      )}

      {report.apps.length > 0 && (
        <Section icon={<AppWindow size={15} aria-hidden="true" />} title="Time in apps" count={report.apps.length} open={false}>
          <ul className="report-apps">{report.apps.map(a => <li key={a.app}><span>{a.app}</span><span className="report-bar" aria-hidden="true"><i style={{ width: `${Math.max(3, Math.round(a.durationMs / totalMs * 100))}%` }} /></span><span className="muted small">{duration(a.durationMs)}</span></li>)}</ul>
        </Section>
      )}

      {agent.length > 0 && (
        <Section icon={<Bot size={15} aria-hidden="true" />} title="Coding agent (reported)" count={agent.length} open={false}>
          <ul className="report-list">{agent.map(a => <li key={a.id}><Bot size={13} aria-hidden="true" /><span>{a.event === 'tool' ? `${a.tool}${a.file ? ` on ${a.file}` : ''}${a.ok === false ? ' (failed)' : ''}` : a.event === 'file_edit' ? `edited ${a.file}` : a.event === 'turn_end' ? 'finished a response' : 'session started'}</span><span className="muted small">{time(a.at)}</span></li>)}</ul>
        </Section>
      )}

      {notes.length > 0 && (
        <Section icon={<StickyNote size={15} aria-hidden="true" />} title="Your notes" count={notes.length} open={false}>
          <ul className="report-list">{notes.map(n => <li key={n.id}><StickyNote size={13} aria-hidden="true" /><span>{n.body}</span><span className="muted small">{time(n.createdAt)}</span></li>)}</ul>
        </Section>
      )}
    </div>
  );
}
