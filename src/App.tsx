import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History as HistoryIcon, Home, Radio, Search as SearchIcon, ScanSearch, ShieldCheck, Settings2, Infinity as InfinityIcon, Square, Pause, Play } from 'lucide-react';
import { bridge, call } from './api';
import type { Snapshot } from './types';
import { StatusPill, JobBanner, captureStatus, useElapsed, usePresence, ThemeSwitch, Toast } from './components';
import { CommandPalette } from './palette';
import { useTheme, type ThemePref } from './theme';
import { Setup } from './screens/Setup';
import { Resume } from './screens/Resume';
import { Live } from './screens/Live';
import { SessionDetail } from './screens/SessionDetail';
import { HistoryPage } from './screens/History';
import { SearchPage } from './screens/Search';
import { Privacy } from './screens/Privacy';
import { SettingsPage } from './screens/Settings';

export type Page = 'resume' | 'live' | 'history' | 'search' | 'privacy' | 'settings' | 'session';
export interface Nav { page: Page; sessionId?: string; query?: string }
export interface AppContext {
  snapshot: Snapshot; busy: boolean; navigate: (nav: Nav) => void;
  run: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>; notify: (message: string) => void;
  theme: { pref: ThemePref; choose: (next: ThemePref, origin?: { x: number; y: number }) => void };
  openPalette: () => void;
}

const NAV_GROUPS: { label: string; items: { page: Page; label: string; icon: typeof Home; key: string }[] }[] = [
  { label: 'Workspace', items: [
    { page: 'resume', label: 'Resume', icon: Home, key: '1' },
    { page: 'live', label: 'Live session', icon: Radio, key: '2' },
    { page: 'history', label: 'Sessions', icon: HistoryIcon, key: '3' },
    { page: 'search', label: 'Search memory', icon: ScanSearch, key: 'F' },
  ] },
  { label: 'Trust & AI', items: [
    { page: 'privacy', label: 'Privacy center', icon: ShieldCheck, key: '4' },
    { page: 'settings', label: 'Local AI', icon: Settings2, key: '5' },
  ] },
];
const NAV = NAV_GROUPS.flatMap(g => g.items);
const TITLES: Record<Page, string> = { resume: 'Resume', live: 'Live session', history: 'Sessions', search: 'Search memory', privacy: 'Privacy center', settings: 'Local AI', session: 'Session' };
const TOAST_MS = { ok: 4000, error: 9000 };

function SessionPill({ ctx }: { ctx: AppContext }) {
  const active = ctx.snapshot.active?.session;
  const elapsed = useElapsed(active?.startedAt);
  if (!active) return null;
  const status = captureStatus(ctx.snapshot);
  return (
    <div className={`session-pill status-${status.key}`} role="region" aria-label="Current session">
      <span className="pill-timer" aria-label={`Elapsed ${elapsed}`}>{elapsed}</span>
      <button className="pill-title" onClick={() => ctx.navigate({ page: 'live' })}>{active.title}<span className="muted"> · {status.label}</span></button>
      {active.status === 'active'
        ? <button className="icon-button" aria-label="Pause capture" title="Pause capture" disabled={ctx.busy} onClick={() => ctx.run(() => call('pauseSession'))}><Pause size={15} /></button>
        : <button className="icon-button" aria-label="Resume capture" title="Resume capture" disabled={ctx.busy} onClick={() => ctx.run(() => call('resumeSession'))}><Play size={15} /></button>}
      <button className="icon-button" aria-label="End session and recap" title="End session and recap" disabled={ctx.busy || !!ctx.snapshot.job} onClick={() => { ctx.navigate({ page: 'session', sessionId: active.id }); void ctx.run(() => call('endSession')); }}><Square size={14} /></button>
    </div>
  );
}

// Sidebar navigation with one highlight that glides to the active item.
function Sidebar({ ctx, page, aiState, aiOk }: { ctx: AppContext; page: Page; aiState: string; aiOk: boolean }) {
  const { snapshot, navigate, theme } = ctx;
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<number | null>(null);
  const current = page === 'session' ? 'history' : page;
  useLayoutEffect(() => {
    const measure = () => { const el = navRef.current?.querySelector<HTMLElement>(`[data-page="${current}"]`); setIndicator(el ? el.offsetTop : null); };
    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [current]);
  return (
    <aside className="sidebar">
      <div className="brand"><span className="mark"><InfinityIcon aria-hidden="true" /></span><span>Continuum</span></div>
      <button className="palette-trigger" aria-label="Search or jump to" onClick={ctx.openPalette}><SearchIcon size={14} aria-hidden="true" /><span>Search or jump to…</span><kbd>Ctrl K</kbd></button>
      <nav aria-label="Main" ref={navRef}>
        <span className="nav-indicator" aria-hidden="true" style={{ transform: `translateY(${indicator ?? 0}px)`, opacity: indicator == null ? 0 : 1 }} />
        {NAV_GROUPS.map(group => (
          <div className="nav-group" key={group.label}>
            <p className="nav-label">{group.label}</p>
            <div className="nav-list">
              {group.items.map(item => (
                <button key={item.page} data-page={item.page} aria-label={item.label} title={item.label} className={`nav-item ${current === item.page ? 'active' : ''}`} aria-current={page === item.page ? 'page' : undefined} onClick={() => navigate({ page: item.page })}>
                  <item.icon size={16} aria-hidden="true" /><span>{item.label}</span>
                  {item.page === 'live' && snapshot.active ? <span className={`live-dot status-${captureStatus(snapshot).key}`} aria-label="Session in progress" /> : <kbd>Ctrl {item.key}</kbd>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className={`ai-status ${aiOk ? 'ok' : 'warn'}`} onClick={() => navigate({ page: 'settings' })}><span className="ai-dot" aria-hidden="true" /><span>{aiState}</span></button>
        <ThemeSwitch pref={theme.pref} choose={theme.choose} />
      </div>
    </aside>
  );
}

function Crumbs({ nav, snapshot, navigate }: { nav: Nav; snapshot: Snapshot; navigate: (nav: Nav) => void }) {
  const session = nav.page === 'session' ? snapshot.sessions.find(s => s.id === nav.sessionId) : null;
  return (
    <ol className="crumbs" aria-label="Breadcrumb">
      <li><button onClick={() => navigate({ page: 'resume' })}>Continuum</button></li>
      {nav.page === 'session'
        ? <><li><button onClick={() => navigate({ page: 'history' })}>Sessions</button></li><li key={nav.sessionId}><span aria-current="page">{session?.summaryTitle ?? session?.title ?? 'Session'}</span></li></>
        : <li key={nav.page}><span aria-current="page">{TITLES[nav.page]}</span></li>}
    </ol>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [nav, setNav] = useState<Nav>({ page: 'resume' });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string; error: boolean } | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const theme = useTheme();
  const toastPresence = usePresence(toastOpen, 200);
  const palette = usePresence(paletteOpen, 140);

  const show = useCallback((text: string, error: boolean) => { setToast({ id: Date.now(), text, error }); setToastOpen(true); }, []);
  const refresh = useCallback(async () => { try { setSnapshot(await call<Snapshot>('snapshot')); } catch (e) { show((e as Error).message, true); } }, [show]);
  useEffect(() => {
    if (!bridge) return;
    void refresh();
    const offSnap = bridge.onSnapshot(setSnapshot);
    const offProgress = bridge.onProgress(setStage);
    return () => { offSnap(); offProgress(); };
  }, [refresh]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToastOpen(false), toast.error ? TOAST_MS.error : TOAST_MS.ok); return () => clearTimeout(t); }, [toast]);

  const navigate = useCallback((next: Nav) => { setNav(next); requestAnimationFrame(() => document.getElementById('main-heading')?.focus()); }, []);
  const notify = useCallback((text: string) => show(text, false), [show]);
  const run = useCallback(async <T,>(work: () => Promise<T>, success?: string) => {
    setBusy(true);
    try { const value = await work(); if (success) show(success, false); return value; }
    catch (e) { show((e as Error).message, true); return undefined; }
    finally { setBusy(false); void refresh(); }
  }, [refresh, show]);
  const openPalette = useCallback(() => { returnFocus.current = document.activeElement as HTMLElement | null; setPaletteOpen(true); }, []);
  const closePalette = useCallback((restore: boolean) => { setPaletteOpen(false); if (restore) requestAnimationFrame(() => returnFocus.current?.focus()); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || !snapshot?.settings?.onboardedAt) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); if (paletteOpen) closePalette(true); else openPalette(); return; }
      const target = NAV.find(n => n.key.toLowerCase() === e.key.toLowerCase());
      if (target) { e.preventDefault(); setPaletteOpen(false); navigate({ page: target.page }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openPalette, closePalette, paletteOpen, snapshot?.settings?.onboardedAt]);

  const toastNode = toast && toastPresence.mounted && <Toast key={toast.id} text={toast.text} error={toast.error} state={toastPresence.state} ms={toast.error ? TOAST_MS.error : TOAST_MS.ok} />;
  if (!bridge) return <div className="boot"><span className="mark"><InfinityIcon aria-hidden="true" /></span><h1>Continuum</h1><p>Open this window through the desktop app (<code>npm start</code>). The encrypted store and local AI bridge exist only there.</p></div>;
  if (!snapshot) return <div className="boot"><span className="mark pulse"><InfinityIcon aria-hidden="true" /></span><p>Opening your encrypted memory…</p></div>;
  if (snapshot.loadError) return <div className="boot"><span className="mark"><InfinityIcon aria-hidden="true" /></span><h1>Continuum could not start</h1><p role="alert">{snapshot.loadError}</p><p className="muted">Nothing was written in plaintext. Fix the problem above and restart.</p></div>;

  const ctx: AppContext = { snapshot, busy, navigate, run, notify, theme: { pref: theme.pref, choose: theme.choose }, openPalette };
  if (!snapshot.settings.onboardedAt) return <><Setup ctx={ctx} />{toastNode}</>;

  const health = snapshot.health;
  const aiOk = !!health?.ready && !snapshot.runtimeError;
  const aiState = snapshot.runtimeError ? 'Runtime unavailable' : !health ? 'Checking local AI…' : health.ready ? `Local AI ready · ${snapshot.settings.generationModel}` : `Missing ${health.missing.join(', ')}`;
  const page = nav.page;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <Sidebar ctx={ctx} page={page} aiState={aiState} aiOk={aiOk} />
      <div className="main-column">
        <header className="topbar">
          <Crumbs nav={nav} snapshot={snapshot} navigate={navigate} />
          <StatusPill snapshot={snapshot} busy={busy} onPause={() => run(() => call('pauseSession'))} onResume={() => run(() => call('resumeSession'))} />
        </header>
        {snapshot.job && <JobBanner key={snapshot.job.sessionId + snapshot.job.kind} stage={stage ?? snapshot.job.stage} onCancel={() => run(() => call('cancel'))} />}
        <main id="main" className="content" tabIndex={-1}>
          {page === 'resume' && <Resume ctx={ctx} />}
          {page === 'live' && <Live ctx={ctx} />}
          {page === 'history' && <HistoryPage ctx={ctx} />}
          {page === 'search' && <SearchPage key={nav.query ?? ''} ctx={ctx} initialQuery={nav.query} />}
          {page === 'privacy' && <Privacy ctx={ctx} />}
          {page === 'settings' && <SettingsPage ctx={ctx} />}
          {page === 'session' && nav.sessionId && <SessionDetail key={nav.sessionId} ctx={ctx} sessionId={nav.sessionId} />}
        </main>
        {page !== 'live' && <SessionPill ctx={ctx} />}
      </div>
      {palette.mounted && <CommandPalette ctx={ctx} state={palette.state} onClose={closePalette} />}
      {toastNode}
    </div>
  );
}
