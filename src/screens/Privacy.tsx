import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck, Download, Trash2, Check, X, LayoutGrid, Radio, Code2, EyeOff, Database, AppWindow, Folder, Globe, FolderInput, TerminalSquare, BookOpen, FileDiff, Bot, ChevronRight } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import { ConfirmDialog } from '../components';
import { ExclusionEditor } from '../exclusions';
import { Toggle, Details, WorkActivity, CodeChanges, CodingAgents } from '../connectors';
import type { Exclusions } from '../types';
import { when } from '../format';
import { enableAllCapture } from '../capture-hint';

type Tab = 'overview' | 'recording' | 'code' | 'exclusions' | 'data';
const TABS: { id: Tab; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'recording', label: 'Recording', icon: Radio },
  { id: 'code', label: 'Code & tools', icon: Code2 },
  { id: 'exclusions', label: 'Exclusions', icon: EyeOff },
  { id: 'data', label: 'Data', icon: Database },
];
const STORE_KEY = 'continuum.privacyTab';
const readTab = (): Tab => { try { const t = localStorage.getItem(STORE_KEY); return TABS.some(x => x.id === t) ? t as Tab : 'overview'; } catch { return 'overview'; } };

function Group({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel group-card">
      <div className="section-head"><h2 className="section-title">{icon} {title}</h2>{aside}</div>
      {children}
    </section>
  );
}

export function Privacy({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const { settings } = snapshot;
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(STORE_KEY, t); } catch { /* per-viewer convenience only */ } };
  const fromSettings = (): Exclusions => ({ excludedApps: settings.excludedApps, excludedFolders: settings.excludedFolders, excludedSites: settings.excludedSites, excludedKeywords: settings.excludedKeywords });
  const [exclusions, setExclusions] = useState<Exclusions>(fromSettings);
  const [confirm, setConfirm] = useState<'clear' | 'revoke' | null>(null);
  const saved = JSON.stringify(fromSettings());
  useEffect(() => { setExclusions(fromSettings()); }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(exclusions) !== saved;
  const totals = snapshot.sessions.reduce((acc, s) => ({ events: acc.events + s.eventCount, notes: acc.notes + s.noteCount, excluded: acc.excluded + s.excludedCount }), { events: 0, notes: 0, excluded: 0 });
  const git = snapshot.connectors.git, agents = snapshot.connectors.agents;
  const exclusionCount = settings.excludedApps.length + settings.excludedFolders.length + settings.excludedSites.length + settings.excludedKeywords.length;

  // Everything that can be recorded, at a glance.
  const categories: { title: string; on: boolean; detail: string; icon: ReactNode; tab: Tab }[] = [
    { title: 'Apps and windows', on: settings.captureConsented, detail: 'App name and redacted window title', icon: <AppWindow size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Explorer folders', on: settings.captureConsented && settings.capturePaths, detail: 'Folder open in File Explorer', icon: <Folder size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Web addresses', on: settings.captureConsented && settings.captureUrls, detail: 'Full address of the tab in front', icon: <Globe size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Files and folders', on: settings.watchFiles, detail: 'Created, renamed, deleted, saved', icon: <FolderInput size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Terminal commands', on: settings.captureCommands, detail: 'PowerShell and Git Bash', icon: <TerminalSquare size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Web pages read', on: settings.browserContext, detail: 'Titles, headings, highlights', icon: <BookOpen size={15} aria-hidden="true" />, tab: 'recording' },
    { title: 'Code changes', on: git.autoTrack || (git.enabled && git.repos.length + git.folders.length > 0), detail: git.includeDiffs ? 'Including the changed lines' : 'File names and line counts', icon: <FileDiff size={15} aria-hidden="true" />, tab: 'code' },
    { title: 'Coding agents', on: agents.enabled, detail: 'Claude Code and OpenCode reports', icon: <Bot size={15} aria-hidden="true" />, tab: 'code' },
  ];
  const onCount = categories.filter(c => c.on).length;

  return (
    <div className="page privacy">
      <h1 id="main-heading" tabIndex={-1}>You decide what Continuum knows</h1>
      <p className="lead">{onCount} of {categories.length} kinds of activity are allowed. Everything stays encrypted on this laptop and is recorded only while a session you started is running.</p>

      <div className="privacy-tabs" role="tablist" aria-label="Privacy center sections">
        {TABS.map(t => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
            onKeyDown={e => { const i = TABS.findIndex(x => x.id === tab); if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]; setTab(next.id); requestAnimationFrame(() => document.getElementById(`tab-${next.id}`)?.focus()); } }}>
            <t.icon size={14} aria-hidden="true" />{t.label}
            {t.id === 'exclusions' && exclusionCount > 0 && <span className="tab-count">{exclusionCount}</span>}
            {t.id === 'exclusions' && dirty && <span className="tab-dot" aria-label="unsaved changes" />}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="privacy-panel">
        {tab === 'overview' && <>
          {onCount < categories.length && (
            <div className="enable-all">
              <span><strong>Capture everything for developer work</strong><span className="muted small"> Turns on all categories below in one step (each is still its own permission, and nothing is recorded until you start a session). For web pages you also need the browser extension.</span></span>
              <button className="primary small-button" disabled={busy} onClick={() => run(enableAllCapture, 'All developer capture is on.')}>Turn on everything</button>
            </div>
          )}
          <div className="category-grid">
            {categories.map(c => (
              <button key={c.title} className={`category-card ${c.on ? 'on' : ''}`} onClick={() => setTab(c.tab)}>
                <span className="category-icon">{c.icon}</span>
                <span className="category-main"><strong>{c.title}</strong><span className="muted small">{c.detail}</span></span>
                <span className={`tag ${c.on ? 'tag-on' : ''}`}>{c.on ? 'On' : 'Off'}</span>
                <ChevronRight size={14} aria-hidden="true" className="muted" />
              </button>
            ))}
          </div>
          <Group title="Never recorded" icon={<ShieldCheck size={15} aria-hidden="true" />}>
            <ul className="crosses two-col-list">
              <li><X size={14} aria-hidden="true" />Screenshots, screen recording, OCR</li>
              <li><X size={14} aria-hidden="true" />Keystrokes, clipboard, microphone</li>
              <li><X size={14} aria-hidden="true" />Form fields and passwords</li>
              <li><X size={14} aria-hidden="true" />Incognito / private windows</li>
              <li><X size={14} aria-hidden="true" />Anything while paused or ended</li>
              <li><X size={14} aria-hidden="true" />Any upload to a cloud service</li>
            </ul>
          </Group>
        </>}

        {tab === 'recording' && <>
          <Group title="Basic capture" icon={<AppWindow size={15} aria-hidden="true" />} aside={<span className={`tag ${settings.captureConsented ? 'tag-on' : ''}`}>{settings.captureConsented ? 'Allowed' : 'Off'}</span>}>
            <p className="muted small">{settings.captureConsented ? 'While a session records: the app in front, its redacted window title, and when you switched.' : 'Notes-only mode: no app or window information is observed.'}</p>
            {settings.captureConsented
              ? <button className="danger-outline small-button" disabled={busy} onClick={() => setConfirm('revoke')}>Revoke capture permission</button>
              : <button className="primary" disabled={busy} onClick={() => run(() => call('setConsent', { granted: true }), 'Capture allowed. It records only during sessions you start.')}>Allow activity capture</button>}
          </Group>
          <Group title="Extra detail" icon={<Globe size={15} aria-hidden="true" />}>
            {!settings.captureConsented && <p className="muted small">Allow basic capture first.</p>}
            <Toggle title="Folders I open in File Explorer" checked={settings.capturePaths} disabled={busy || !settings.captureConsented} onChange={v => run(() => call('setCaptureScopes', { paths: v, urls: settings.captureUrls }), 'Capture permissions updated.')}>The full folder path of the Explorer window in front.</Toggle>
            <Toggle title="Full web addresses" checked={settings.captureUrls} disabled={busy || !settings.captureConsented} onChange={v => run(() => call('setCaptureScopes', { paths: settings.capturePaths, urls: v }), 'Capture permissions updated.')}>The address bar of the browser in front; login codes and tokens redacted. Also shows your web searches.</Toggle>
          </Group>
          <Group title="How you work" icon={<FolderInput size={15} aria-hidden="true" />}>
            <WorkActivity ctx={ctx} />
          </Group>
        </>}

        {tab === 'code' && <>
          <Group title="Code changes" icon={<FileDiff size={15} aria-hidden="true" />}><CodeChanges ctx={ctx} /></Group>
          <Group title="Coding agents" icon={<Bot size={15} aria-hidden="true" />} aside={<span className={`tag ${agents.enabled ? 'tag-on' : ''}`}>{agents.enabled ? 'On' : 'Off'}</span>}><CodingAgents ctx={ctx} /></Group>
        </>}

        {tab === 'exclusions' && <>
          <p className="muted small">Matching activity is dropped before saving and never reaches the AI; only a count is kept. Private windows are always excluded, and emails, tokens and login codes are always redacted.</p>
          <ExclusionEditor value={exclusions} onChange={setExclusions} disabled={busy} />
          {dirty && (
            <div className="save-bar" role="region" aria-label="Unsaved exclusions">
              <span>You have unsaved changes to exclusions.</span>
              <button className="ghost small-button" onClick={() => setExclusions(fromSettings())}>Discard</button>
              <button className="primary small-button" disabled={busy} onClick={() => run(() => call('updateExclusions', exclusions), 'Exclusions saved.')}>Save exclusions</button>
            </div>
          )}
        </>}

        {tab === 'data' && <>
          <Group title="Your data on this device" icon={<Database size={15} aria-hidden="true" />}>
            <dl className="stats">
              <div><dt>Sessions</dt><dd>{snapshot.sessions.length}</dd></div>
              <div><dt>Activity entries</dt><dd>{totals.events}</dd></div>
              <div><dt>Notes</dt><dd>{totals.notes}</dd></div>
              <div><dt>Excluded windows dropped</dt><dd>{totals.excluded}</dd></div>
            </dl>
            <p className="muted small">Encrypted SQLite (AES-256-GCM fields, key protected by Windows DPAPI) in your app data folder. Deleting removes rows and runs VACUUM; SSD secure erase and external backups are outside the app's control.</p>
            <div className="actions">
              <button className="secondary" disabled={busy} onClick={() => run(async () => { const path = await call<string | null>('export'); if (path) ctx.notify(`Exported to ${path}`); })}><Download size={15} aria-hidden="true" /> Export as JSON</button>
              <button className="danger-outline" disabled={busy} onClick={() => setConfirm('clear')}><Trash2 size={15} aria-hidden="true" /> Delete everything</button>
            </div>
            <p className="muted small">An export is a plaintext file saved where you choose. Keep it somewhere safe.</p>
          </Group>
          <Group title="Permission history" icon={<Check size={15} aria-hidden="true" />} aside={<span className="muted small">{snapshot.consentRecords.length} records</span>}>
            {snapshot.consentRecords.length === 0 ? <p className="muted small">No permission has been granted.</p> : (
              <Details summary="Show all permission records">
                <ul className="plain">{snapshot.consentRecords.map(r => <li key={r.id}><code>{r.scope}</code> · granted {when(r.consentedAt)}{r.revokedAt ? ` · revoked ${when(r.revokedAt)}` : ' · active'}</li>)}</ul>
              </Details>
            )}
          </Group>
        </>}
      </div>

      {confirm === 'clear' && <ConfirmDialog title="Delete everything?" confirmLabel="Delete all data"
        body={<p>All sessions, activity, notes, recaps, search embeddings and permission records will be removed, and setup will start again. This cannot be undone.</p>}
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await run(() => call('clearAll'), 'All Continuum data deleted.'); }} />}
      {confirm === 'revoke' && <ConfirmDialog title="Revoke capture permission?" confirmLabel="Revoke" danger={false}
        body={<p>Capture stops immediately. Existing sessions stay until you delete them. You can keep working in notes-only mode.</p>}
        onCancel={() => setConfirm(null)} onConfirm={async () => { setConfirm(null); await run(() => call('setConsent', { granted: false }), 'Capture permission revoked.'); }} />}
    </div>
  );
}
