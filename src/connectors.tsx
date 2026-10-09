import { useEffect, useState, type ReactNode } from 'react';
import { GitBranch, FolderPlus, Trash2, Check, X, Bot, Folder } from 'lucide-react';
import { call } from './api';
import type { AppContext } from './App';
import { when } from './format';

// One consistent switch row used across the Privacy center.
export function Toggle({ checked, disabled, onChange, title, children }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; title: string; children?: ReactNode }) {
  return (
    <label className="scope toggle-row">
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span><strong>{title}</strong>{children && <span className="muted small"> {children}</span>}</span>
    </label>
  );
}

export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return <details className="more-details"><summary>{summary}</summary><div className="more-body">{children}</div></details>;
}

function PathList({ items, icon, empty, onRemove, busy }: { items: string[]; icon: ReactNode; empty: string; onRemove: (path: string) => void; busy: boolean }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  return <div className="path-list">{items.map(p => (
    <div className="connector-row" key={p}>{icon}<code title={p}>{p}</code>
      <button className="ghost small-button" disabled={busy} onClick={() => onRemove(p)} aria-label={`Remove ${p}`}><Trash2 size={13} aria-hidden="true" /> Remove</button></div>
  ))}</div>;
}

// Browser extension + native-messaging helper setup (shown when "web pages" is on).
export function BrowserHelper({ ctx }: { ctx: AppContext }) {
  const [status, setStatus] = useState<{ installed: boolean; extensionDir?: string } | null>(null);
  useEffect(() => { call<{ installed: boolean; extensionDir: string }>('browserHelper', {}).then(setStatus).catch(() => setStatus(null)); }, []);
  const install = () => ctx.run(async () => { await call('browserHelper', { action: 'install' }); setStatus(await call('browserHelper', {})); }, 'Browser helper registered for Chrome, Edge, Brave and Chromium.');
  return (
    <ol className="setup-steps">
      <li>{status?.installed ? <span className="ok-text small" style={{ display: 'inline-flex' }}><Check size={13} aria-hidden="true" /> Local helper registered</span> : <><button className="secondary small-button" disabled={ctx.busy} onClick={install}>Register local helper</button> <span className="muted small">one per-user registry entry per browser</span></>}</li>
      {status?.installed && <li className="small"><button className="ghost small-button" disabled={ctx.busy} onClick={() => ctx.run(async () => { await call('browserHelper', { action: 'uninstall' }); setStatus(await call('browserHelper', {})); }, 'Browser helper removed.')}>Remove local helper</button> <span className="muted">removes the registry entries</span></li>}
      <li className="small">Open <code>chrome://extensions</code> or <code>edge://extensions</code>, turn on <em>Developer mode</em>, choose <em>Load unpacked</em> and select:<pre className="snippet">{status?.extensionDir ?? '…'}</pre></li>
    </ol>
  );
}

// How the user works: files and folders, terminal commands, web pages.
export function WorkActivity({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const s = snapshot.settings;
  return (
    <>
      <Toggle title="Files and folders I create, rename, delete or save" checked={s.watchFiles} disabled={busy} onChange={v => run(() => call('setObserve', { watchFiles: v }), v ? 'Recording file and folder activity.' : 'File activity off.')}>From any app, including File Explorer. Paths only.</Toggle>
      <Toggle title="Terminal commands I run" checked={s.captureCommands} disabled={busy} onChange={v => run(() => call('setObserve', { captureCommands: v }), v ? 'Recording terminal commands.' : 'Terminal commands off.')}>PowerShell and Git Bash. Secrets redacted.</Toggle>
      <Toggle title="What I read on web pages" checked={s.browserContext} disabled={busy} onChange={v => run(() => call('setObserve', { browserContext: v }), v ? 'Including pages you read.' : 'Page context off.')}>Titles, headings, excerpts and highlights, via the Continuum extension.</Toggle>
      {s.browserContext && <BrowserHelper ctx={ctx} />}
      <Details summary="What exactly is recorded?">
        <ul className="plain">
          <li><strong>Files and folders:</strong> watched in Desktop, Documents, Downloads, your projects and folders you open in Explorer. node_modules, caches and excluded folders are skipped.</li>
          <li><strong>Terminal commands:</strong> only commands typed while recording; passwords, tokens and keys in arguments are redacted. Command Prompt (cmd.exe) keeps no history Continuum can read, so use PowerShell to include commands. For Git Bash, run this once so commands are saved as you type them:<pre className="snippet">{`echo 'PROMPT_COMMAND="history -a; $PROMPT_COMMAND"' >> ~/.bashrc`}</pre></li>
          <li><strong>Web pages:</strong> Chrome, Edge, Brave and Chromium through the browser's native messaging to a local helper (no network). The helper writes only while a session is recording with this option on. Never form fields, never incognito. Excluded sites and keywords apply.</li>
          <li>Nothing is observed while a session is paused or ended.</li>
        </ul>
      </Details>
    </>
  );
}

// Code changes: editor tracking, changed lines, repositories and plain project folders.
export function CodeChanges({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const git = snapshot.connectors.git;
  const pick = (purpose: 'repo' | 'project') => run(async () => {
    const folder = await call<string | null>('pickFolder', { purpose });
    if (!folder) return;
    if (purpose === 'repo') ctx.notify(`Connected ${await call<string>('addGitRepo', { path: folder })}`);
    else { await call<string>('addProjectFolder', { path: folder }); ctx.notify(`Added ${folder}`); }
  });
  return (
    <>
      <Toggle title="Track code changes in projects I open in my editor" checked={git.autoTrack} disabled={busy} onChange={v => run(() => call('setAutoTrack', { enabled: v }), v ? 'Tracking code changes in projects you open.' : 'Editor project tracking off.')}>VS Code-family editors (VS Code, Cursor, Windsurf, VSCodium), and any project where a file is saved while file activity is on.</Toggle>
      <Toggle title="Include the changed lines" checked={git.includeDiffs} disabled={busy} onChange={v => run(() => call('setIncludeDiffs', { enabled: v }), v ? 'Code excerpts on.' : 'Code excerpts off.')}>So the recap can say exactly what changed (e.g. 3000 → 5173).</Toggle>
      <Toggle title="Read the repositories and folders below" checked={git.enabled} disabled={busy} onChange={v => run(() => call('setGitEnabled', { enabled: v }), v ? 'Git connector on.' : 'Git connector off.')}>Read-only: baseline at session start, checked every 15 s while recording and at the end.</Toggle>

      <div className="sub-group">
        <div className="sub-group-head"><h4><GitBranch size={14} aria-hidden="true" /> Git repositories</h4><button className="secondary small-button" disabled={busy} onClick={() => pick('repo')}><FolderPlus size={13} aria-hidden="true" /> Add repository</button></div>
        <PathList items={git.repos} icon={<GitBranch size={14} aria-hidden="true" />} empty="No repositories connected." busy={busy} onRemove={p => run(() => call('removeGitRepo', { path: p }), 'Repository removed.')} />
      </div>
      <div className="sub-group">
        <div className="sub-group-head"><h4><Folder size={14} aria-hidden="true" /> Project folders (no Git needed)</h4><button className="secondary small-button" disabled={busy} onClick={() => pick('project')}><FolderPlus size={13} aria-hidden="true" /> Add folder</button></div>
        <PathList items={git.folders} icon={<Folder size={14} aria-hidden="true" />} empty="No project folders added." busy={busy} onRemove={p => run(() => call('removeProjectFolder', { path: p }), 'Project folder removed.')} />
      </div>
      {(git.lastAt || git.error) && <p className="small" role={git.error ? 'alert' : undefined}>{git.error ? <span className="warn-text"><X size={13} aria-hidden="true" /> {git.error}</span> : <span className="ok-text"><Check size={13} aria-hidden="true" /> Last read {when(git.lastAt)}</span>}</p>}
      <Details summary="What exactly is read?">
        <ul className="plain">
          <li>Branch, new commits (short id and message), changed file names and line counts.</li>
          <li>With <em>changed lines</em> on: up to 6 files × 40 lines per session, redacted, stored encrypted, read by the local model only. Lock, minified, binary, key and .env files are never read.</li>
          <li>Project folders: a private snapshot inside Continuum's data folder at session start, compared at the end, then deleted. Nothing is written to your folder; up to 3,000 files.</li>
          <li>Git runs without a shell, with repository hooks and external tools disabled.</li>
        </ul>
      </Details>
    </>
  );
}

export function CodingAgents({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const agents = snapshot.connectors.agents;
  const dir = (snapshot.connectorsDir ?? '<continuum>/connectors').replace(/\\/g, '/');
  const hookCmd = `node "${dir}/claude-code-hook.mjs"`;
  const hookJson = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCmd }] }], PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd }] }], Stop: [{ hooks: [{ type: 'command', command: hookCmd }] }] } }, null, 2);
  return (
    <>
      <Toggle title="Include what Claude Code or OpenCode reports doing" checked={agents.enabled} disabled={busy} onChange={v => run(() => call('setAgentsEnabled', { enabled: v }), v ? 'Coding-agent connector on.' : 'Coding-agent connector off; inbox cleared.')}>Tool, file and success only; labeled “Agent-reported”.</Toggle>
      {(agents.lastAt || agents.error) && <p className="small" role={agents.error ? 'alert' : undefined}>{agents.error ? <span className="warn-text"><X size={13} aria-hidden="true" /> {agents.error}</span> : <span className="ok-text"><Bot size={13} aria-hidden="true" /> Last agent report {when(agents.lastAt)}</span>}</p>}
      <Details summary="Set up the adapters">
        <p className="small"><strong>Claude Code:</strong> merge into <code>%USERPROFILE%\.claude\settings.json</code> (or a project's <code>.claude/settings.json</code>):</p>
        <pre className="snippet">{hookJson}</pre>
        <p className="small"><strong>OpenCode:</strong> copy <code>{dir}/opencode-plugin.js</code> to <code>%USERPROFILE%\.config\opencode\plugins\continuum.js</code> and restart OpenCode.</p>
        <p className="muted small">Never prompts, replies, shell commands or tool output. Adapters write to a local inbox file (<code>{agents.inbox ?? '—'}</code>), read only while recording; no network port.</p>
      </Details>
    </>
  );
}

