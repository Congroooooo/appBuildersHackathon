import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, ScanSearch, Play, Pause, Square, Sparkles, FileText, Home, Radio, History, ShieldCheck, Settings2, Sun, Moon, Monitor, CornerDownLeft, ArrowUp, ArrowDown, Infinity as InfinityIcon, type LucideIcon } from 'lucide-react';
import { call } from './api';
import type { AppContext, Page } from './App';
import { day, time } from './format';

interface Command { id: string; group: string; text: string; icon: LucideIcon; label?: ReactNode; meta?: ReactNode; keywords?: string; run: () => void }

const PAGES: { page: Page; text: string; icon: LucideIcon; keys: string; keywords: string }[] = [
  { page: 'resume', text: 'Go to Resume', icon: Home, keys: 'Ctrl 1', keywords: 'home dashboard continue' },
  { page: 'live', text: 'Go to Live session', icon: Radio, keys: 'Ctrl 2', keywords: 'timeline recording now' },
  { page: 'history', text: 'Go to Sessions', icon: History, keys: 'Ctrl 3', keywords: 'history memory list' },
  { page: 'search', text: 'Go to Search memory', icon: ScanSearch, keys: 'Ctrl F', keywords: 'find semantic' },
  { page: 'privacy', text: 'Go to Privacy center', icon: ShieldCheck, keys: 'Ctrl 4', keywords: 'exclusions connectors git delete export consent' },
  { page: 'settings', text: 'Go to Local AI', icon: Settings2, keys: 'Ctrl 5', keywords: 'model ollama diagnostics runtime' },
];

// Marks the part of the label that matches what was typed.
function highlight(text: string, query: string) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<em>{text.slice(at, at + q.length)}</em>{text.slice(at + q.length)}</>;
}

// Ctrl+K: jump anywhere, act on the current session, switch theme, or search memory semantically.
export function CommandPalette({ ctx, state, onClose }: { ctx: AppContext; state: 'open' | 'closed'; onClose: (restoreFocus: boolean) => void }) {
  const { snapshot, navigate, run, theme } = ctx;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim();

  const commands = useMemo(() => {
    const go = (fn: () => void) => () => { onClose(false); fn(); };
    const session = snapshot.active?.session;
    const out: Command[] = [];
    if (q) out.push({ id: 'search', group: 'Search', text: `Search memory for “${q}”`, icon: Sparkles, meta: 'On this device', run: go(() => navigate({ page: 'search', query: q })) });
    if (q && !session) out.push({ id: 'start-q', group: 'Search', text: `Start session “${q}”`, icon: Play, run: go(() => void run(() => call<string>('startSession', { title: q }), 'Session started.').then(id => { if (id) navigate({ page: 'live' }); })) });
    const sessions = snapshot.sessions.filter(s => !q || `${s.summaryTitle ?? ''} ${s.title}`.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 6 : 4);
    const found: Command[] = [];
    for (const s of sessions) found.push({ id: `s-${s.id}`, group: q ? 'Sessions' : 'Recent sessions', text: s.summaryTitle ?? s.title, icon: s.summaryGenerator === 'model' ? Sparkles : FileText, meta: s.status === 'ended' ? `${day(s.startedAt)} · ${time(s.startedAt)}` : 'In progress', run: go(() => navigate({ page: s.status === 'ended' ? 'session' : 'live', sessionId: s.id })) });
    const actions: Command[] = [];
    if (!session) actions.push({ id: 'start', group: 'Actions', text: 'Start a new session…', icon: Play, keywords: 'begin record new', run: go(() => navigate({ page: 'live' })) });
    else {
      actions.push(session.status === 'active'
        ? { id: 'pause', group: 'Actions', text: 'Pause capture', icon: Pause, keywords: 'stop recording', run: go(() => void run(() => call('pauseSession'), 'Paused. Nothing is being recorded.')) }
        : { id: 'resume', group: 'Actions', text: 'Resume capture', icon: Play, keywords: 'continue recording', run: go(() => void run(() => call('resumeSession'), 'Recording resumed.')) });
      if (!snapshot.job) actions.push({ id: 'end', group: 'Actions', text: 'End session & write recap', icon: Square, keywords: 'finish stop summarize', run: go(() => { navigate({ page: 'session', sessionId: session.id }); void run(() => call('endSession')); }) });
    }
    const pages: Command[] = PAGES.map(p => ({ id: `p-${p.page}`, group: 'Navigation', text: p.text, icon: p.icon, keywords: p.keywords, meta: <kbd>{p.keys}</kbd>, run: go(() => navigate({ page: p.page })) }));
    const themes: Command[] = ([['light', Sun, 'Light'], ['dark', Moon, 'Dark'], ['system', Monitor, 'System']] as const).map(([value, icon, label]) => ({
      id: `t-${value}`, group: 'Appearance', text: `Use ${label.toLowerCase()} theme`, icon, keywords: 'theme appearance mode color', meta: theme.pref === value ? 'Current' : undefined, run: go(() => void theme.choose(value)),
    }));
    const match = (c: Command) => q.toLowerCase().split(/\s+/).every(w => `${c.text} ${c.keywords ?? ''}`.toLowerCase().includes(w));
    // Typing a command name runs that command; anything else searches memory first.
    if (!q) return [...actions, ...found, ...pages, ...themes];
    return [...[...actions, ...pages, ...themes].filter(match), ...out, ...found];
  }, [q, snapshot.active, snapshot.sessions, snapshot.job, theme, navigate, run, onClose]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % Math.max(commands.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + commands.length) % Math.max(commands.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); commands[active]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(true); }
    else if (e.key === 'Tab') e.preventDefault();
  };

  let lastGroup = '';
  return (
    <div className="cmdk-backdrop" data-state={state} onMouseDown={e => { if (e.target === e.currentTarget) onClose(true); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input">
          <Search size={18} aria-hidden="true" />
          <label htmlFor="cmdk-input" className="sr-only">Describe the work you're looking for, or type a command</label>
          <input id="cmdk-input" autoFocus value={query} maxLength={300} autoComplete="off" spellCheck={false} placeholder="Search memory, jump to a page, or run a command…"
            role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" aria-activedescendant={commands[active] ? `cmdk-${commands[active].id}` : undefined}
            onChange={e => setQuery(e.target.value)} onKeyDown={onKey} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Commands" ref={listRef}>
          {commands.length === 0 && <p className="cmdk-empty">Nothing matches “{q}”.</p>}
          {commands.map((c, i) => {
            const heading = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id} role="presentation">
                {heading && <p className="cmdk-group" role="presentation">{heading}</p>}
                <div id={`cmdk-${c.id}`} data-index={i} role="option" aria-selected={i === active} className="cmdk-item" onMouseMove={() => { if (i !== active) setActive(i); }} onClick={c.run}>
                  <c.icon size={16} aria-hidden="true" />
                  <span className="cmdk-text">{c.label ?? highlight(c.text, q)}</span>
                  {c.meta && <span className="cmdk-meta">{c.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span className="mark"><InfinityIcon /></span>
          <span><kbd><ArrowUp size={11} /></kbd><kbd><ArrowDown size={11} /></kbd> Move</span>
          <span><kbd><CornerDownLeft size={11} /></kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </div>
  );
}
