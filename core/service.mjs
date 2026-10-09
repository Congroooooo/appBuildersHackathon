import { EventEmitter } from 'node:events';
import { DEFAULT_EXCLUDED_APPS, DEFAULT_EXCLUDED_KEYWORDS, normalizeApp, normalizeSite, redact } from './privacy.mjs';
import { RECAP_SCHEMA, SYSTEM_PROMPT, PROMPT_VERSION, buildBundle, buildUserPrompt, validateRecap, fallbackRecap, topResources, lastForeground, summaryText, gitEvidence, sessionReport } from './summarize.mjs';
import * as gitConnector from './git.mjs';
import { readInbox, pruneInbox, clearInbox } from './agents.mjs';
import { rm, stat } from 'node:fs/promises';
import { editorFolders } from './editors.mjs';
import { FileActivityWatcher, watchableRoot } from './activity.mjs';
import { TerminalHistory } from './terminal.mjs';
import { readPages, prunePages, setRecordingFlag } from './browser.mjs';
import { existsSync } from 'node:fs';
import { join as joinPath, dirname as dirnamePath } from 'node:path';
import { editorFile } from './summarize.mjs';
import { parse as parsePath } from 'node:path';

export const CONSENT_VERSION = 'capture-v1';
export const CAPTURE_SCOPE = 'foreground-app-and-window-title';
export const PATH_SCOPE = 'file-explorer-folder-paths';
export const URL_SCOPE = 'browser-full-addresses';
export const GIT_SCOPE = 'git-repositories-read-only';
export const AGENT_SCOPE = 'coding-agent-activity';
export const DIFF_SCOPE = 'code-change-excerpts';
export const TRACK_SCOPE = 'editor-project-tracking';
export const FILES_SCOPE = 'file-and-folder-activity';
export const COMMANDS_SCOPE = 'terminal-commands';
export const PAGES_SCOPE = 'browser-page-context';
export const COMMAND_POLL_MS = 3000;
export const MAX_ACTIVITY = 2000;
export const LIVE_PROBE_MS = 15000;
export const FOLDER_SCOPE = 'project-folder-snapshots';
export const MAX_FOLDERS = 10;
export const AGENT_POLL_MS = 3000;
export const MAX_REPOS = 10;
export const DEFAULT_MODELS = { generation: 'qwen3:1.7b', embedding: 'all-minilm' };
export const LIMITS = { title: 120, note: 1000, query: 300, sessions: 200, exclusions: 60 };

const text = (value, max, field) => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be text.`);
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result) throw new Error(`${field} cannot be empty.`);
  if (result.length > max) throw new Error(`${field} must be under ${max} characters.`);
  return result;
};

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const chunk = (value, size = 380) => {
  const parts = [];
  let rest = value.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
};

export class ContinuumService extends EventEmitter {
  constructor({ repo, capture, provider, git = gitConnector, inboxDir = null, shadowRoot = null, editors = editorFolders, liveProbeMs = LIVE_PROBE_MS, terminal = new TerminalHistory(), defaultWatchRoots = null, dataDir = null }) {
    super();
    this.repo = repo; this.capture = capture; this.provider = provider; this.git = git;
    this.gitStatus = { lastAt: null, error: null }; this.gitPending = null;
    this.shadowRoot = shadowRoot; this.editors = editors; this.liveProbeMs = liveProbeMs;
    this.terminal = terminal; this.commandTimer = null; this.commandBusy = null; this.dataDir = dataDir; this.pageCursor = null; this.pageBusy = null; this.observeGen = 0;
    if (inboxDir) { void prunePages(inboxDir, new Date().toISOString()).catch(() => {}); void setRecordingFlag(inboxDir, false); }
    this.defaultWatchRoots = defaultWatchRoots ?? ['Desktop', 'Documents', 'Downloads'].map(d => joinPath(process.env.USERPROFILE ?? '', d)).filter(p => existsSync(p));
    this.files = null;
    this.tracking = { sessionId: null, paths: new Set(), pending: Promise.resolve(), folders: null, foldersAt: 0 };
    this.live = { sessionId: null, timer: null, busy: false, at: null, repos: [] };
    // Folder snapshot repositories never outlive a session; leftovers from a crash are removed at startup.
    if (shadowRoot) this.shadowReady = rm(shadowRoot, { recursive: true, force: true }).catch(() => {});
    this.inboxDir = inboxDir; this.agentState = { cursor: null, timer: null, busy: null, gen: 0, lastAt: null, error: null, count: 0 };
    // Anything an adapter wrote while no session was recording is discarded, never stored.
    if (inboxDir) this.inboxReady = pruneInbox(inboxDir, new Date().toISOString()).catch(() => {});
    this.job = null; this.lastHealth = null;
    // A session left active by a previous run is paused: capture never resumes without a user action.
    const leftover = repo.activeSession();
    if (leftover?.status === 'active') repo.setSessionStatus(leftover.id, 'paused');
    capture.on('segment', event => { const s = this.repo.activeSession(); if (s?.status === 'active') { this.repo.addEvent(s.id, event); this.#changed(); } });
    capture.on('excluded', () => { const s = this.repo.activeSession(); if (s?.status === 'active') { this.repo.countExcluded(s.id); this.#changed(); } });
    capture.on('state', () => this.#changed());
    capture.on('current', () => { this.#changed(); this.#trackCurrent(); this.#watchExplorerFolder(); });
  }

  static defaults() {
    return { excludedApps: DEFAULT_EXCLUDED_APPS, excludedKeywords: DEFAULT_EXCLUDED_KEYWORDS, generationModel: process.env.CONTINUUM_MODEL || DEFAULT_MODELS.generation, embeddingModel: DEFAULT_MODELS.embedding };
  }

  #changed() { this.emit('changed'); }
  #progress(stage) { this.emit('progress', stage); }
  #models() { const s = this.repo.settings(); return { generation: s.generationModel, embedding: s.embeddingModel }; }

  snapshot() {
    const settings = this.repo.settings();
    const active = this.repo.activeSession();
    const sessions = this.repo.sessions(LIMITS.sessions).map(s => {
      const summary = this.repo.latestSummary(s.id);
      return { ...s, summaryTitle: summary?.output.task_title ?? null, summaryGenerator: summary?.generator ?? null };
    });
    const latestEnded = sessions.find(s => s.status === 'ended');
    return {
      settings, consentRecords: this.repo.consentRecords(),
      capture: { state: this.capture.state, error: this.capture.error, current: this.capture.current() },
      active: active ? this.sessionDetail(active.id) : null,
      latest: latestEnded ? this.sessionDetail(latestEnded.id) : null,
      sessions, job: this.job ? { kind: this.job.kind, sessionId: this.job.sessionId, stage: this.job.stage } : null,
      health: this.lastHealth, promptVersion: PROMPT_VERSION,
      observe: { watchFiles: settings.watchFiles, captureCommands: settings.captureCommands, browserContext: settings.browserContext, roots: this.files?.roots() ?? [] },
      connectors: { git: { enabled: settings.gitEnabled, autoTrack: settings.autoTrack, repos: settings.gitRepos, folders: settings.projectFolders, includeDiffs: settings.includeDiffs, ...this.gitStatus }, agents: { enabled: settings.agentsEnabled, lastAt: this.agentState.lastAt, error: this.agentState.error, count: this.agentState.count, inbox: this.inboxDir } },
    };
  }

  sessionDetail(id) {
    const session = this.repo.session(id);
    if (!session) throw new Error('That session no longer exists.');
    return { session, events: this.repo.events(id), agentEvents: this.repo.agentEvents(id), fileActivity: this.repo.activity(id, 'file'), commands: this.repo.activity(id, 'command'), pages: this.repo.pages(id), liveChanges: this.live.sessionId === id && session.status !== 'ended' ? { at: this.live.at, repos: this.live.repos } : null, notes: this.repo.notes(id), summary: this.repo.latestSummary(id), indexed: this.repo.embeddingCount(id) > 0 };
  }

  async health() {
    this.lastHealth = { ...(await this.provider.health(this.#models())), checkedAt: new Date().toISOString() };
    this.#changed();
    return this.lastHealth;
  }

  completeOnboarding({ excludedApps, excludedKeywords, excludedFolders, excludedSites, generationModel } = {}) {
    this.updateExclusions({ excludedApps, excludedKeywords, excludedFolders, excludedSites });
    if (generationModel) this.repo.updateSettings({ generationModel: text(generationModel, 80, 'Model') });
    this.repo.updateSettings({ onboardedAt: new Date().toISOString() });
    this.#changed();
    return true;
  }

  setConsent({ granted }) {
    if (typeof granted !== 'boolean') throw new TypeError('Consent must be yes or no.');
    if (granted === this.repo.settings().captureConsented) return true;
    this.repo.setConsent(granted, CAPTURE_SCOPE, CONSENT_VERSION);
    if (!granted) this.capture.stop();
    else if (this.repo.activeSession()?.status === 'active') this.capture.start();
    this.#changed();
    return true;
  }

  updateExclusions({ excludedApps, excludedKeywords, excludedFolders, excludedSites }) {
    const current = this.repo.settings();
    const clean = (values, field, normalize, max = 80) => {
      if (!Array.isArray(values) || values.length > LIMITS.exclusions) throw new TypeError(`${field} must be a list of up to ${LIMITS.exclusions} entries.`);
      return [...new Set(values.map(v => normalize(text(v, max, field))).filter(Boolean))];
    };
    this.repo.updateSettings({
      excludedApps: clean(excludedApps ?? current.excludedApps, 'Excluded apps', normalizeApp),
      excludedKeywords: clean(excludedKeywords ?? current.excludedKeywords, 'Excluded keywords', v => v.toLowerCase()),
      excludedFolders: clean(excludedFolders ?? current.excludedFolders, 'Excluded folders', v => v.replace(/\//g, '\\').replace(/\\+$/, ''), 260),
      excludedSites: clean(excludedSites ?? current.excludedSites, 'Excluded websites', normalizeSite, 200),
    });
    this.#changed();
    return true;
  }

  // Optional capture categories, each a separate permission on top of basic capture consent.
  setCaptureScopes({ paths, urls }) {
    const settings = this.repo.settings();
    if ((paths || urls) && !settings.captureConsented) throw new Error('Allow activity capture first.');
    const patch = {};
    if (typeof paths === 'boolean' && paths !== settings.capturePaths) { patch.capturePaths = paths; this.repo.recordScope(PATH_SCOPE, paths); }
    if (typeof urls === 'boolean' && urls !== settings.captureUrls) { patch.captureUrls = urls; this.repo.recordScope(URL_SCOPE, urls); }
    if (!Object.keys(patch).length) return true;
    this.repo.updateSettings(patch);
    this.capture.restart();
    this.#changed();
    return true;
  }

  setModel({ generationModel }) {
    this.repo.updateSettings({ generationModel: text(generationModel, 80, 'Model') });
    this.lastHealth = null; this.#changed();
    return true;
  }

  // Coding-agent connector: reads the local inbox only while a session is actively recording.
  async setAgentsEnabled({ enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be yes or no.');
    if (enabled === this.repo.settings().agentsEnabled) return true;
    this.repo.updateSettings({ agentsEnabled: enabled });
    this.repo.recordScope(AGENT_SCOPE, enabled);
    const active = this.repo.activeSession();
    if (enabled && active?.status === 'active') this.#agentsStart(active.id);
    if (!enabled) { this.#agentsHalt(); if (this.inboxDir) await clearInbox(this.inboxDir).catch(() => {}); }
    this.#changed();
    return true;
  }

  // The generation counter makes a late final read (from a pause) unable to move the cursor of a newer start, so
  // reports written while paused are never ingested.
  #agentsStart(sessionId) {
    if (!this.inboxDir) return;
    this.#agentsHalt();
    const gen = ++this.agentState.gen;
    const begin = () => {
      if (gen !== this.agentState.gen) return;
      this.agentState.cursor = new Date().toISOString();
      this.agentState.timer = setInterval(() => { void this.#agentsIngest(sessionId); }, AGENT_POLL_MS);
      this.agentState.timer.unref?.();
    };
    if (this.agentState.busy) this.agentState.busy.then(begin, begin); else begin();
  }

  #agentsHalt() {
    if (this.agentState.timer) clearInterval(this.agentState.timer);
    this.agentState.timer = null;
  }

  async #agentsIngest(sessionId) {
    if (!this.inboxDir || !this.agentState.cursor) return;
    if (this.agentState.busy) return this.agentState.busy;
    this.agentState.busy = (async () => {
      const until = new Date().toISOString();
      try {
        const gen = this.agentState.gen;
        const records = await readInbox(this.inboxDir, this.agentState.cursor, until);
        if (gen === this.agentState.gen) this.agentState.cursor = until;
        if (!this.repo.session(sessionId)) return;
        for (const record of records) if (!this.#excludedText(`${record.project} ${record.file ?? ''}`)) this.repo.addAgentEvent(sessionId, { ...record, project: redact(record.project) });
        if (records.length) { this.agentState.lastAt = until; this.agentState.count += records.length; this.#changed(); }
        this.agentState.error = null;
      } catch (error) { this.agentState.error = error.message; }
    })();
    try { await this.agentState.busy; } finally { this.agentState.busy = null; }
  }

  // Final read up to now, then stop. On session end the inbox is pruned so nothing lingers on disk.
  async #agentsStop(sessionId, prune = false) {
    if (!this.agentState.timer && !this.agentState.busy) { if (prune && this.inboxDir) await pruneInbox(this.inboxDir, new Date().toISOString()).catch(() => {}); return; }
    this.#agentsHalt();
    const gen = this.agentState.gen;
    await this.#agentsIngest(sessionId);
    if (gen === this.agentState.gen) this.agentState.cursor = null; // a resume in between keeps its own cursor
    if (prune && this.inboxDir) await pruneInbox(this.inboxDir, new Date().toISOString()).catch(() => {});
  }

  // Git connector: read-only, explicit repository list, snapshots only at session start and end.
  async addGitRepo({ path }) {
    const top = await this.git.resolveRepo(text(path, 260, 'Repository folder'));
    const settings = this.repo.settings();
    if (settings.gitRepos.some(r => r.toLowerCase() === top.toLowerCase())) return top;
    if (settings.gitRepos.length >= MAX_REPOS) throw new Error(`Up to ${MAX_REPOS} repositories can be connected.`);
    this.repo.updateSettings({ gitRepos: [...settings.gitRepos, top] });
    this.#changed();
    return top;
  }

  removeGitRepo({ path }) {
    const settings = this.repo.settings();
    this.repo.updateSettings({ gitRepos: settings.gitRepos.filter(r => r !== path) });
    this.#changed();
    return true;
  }

  setGitEnabled({ enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be yes or no.');
    if (enabled === this.repo.settings().gitEnabled) return true;
    this.repo.updateSettings({ gitEnabled: enabled });
    this.repo.recordScope(GIT_SCOPE, enabled);
    this.#changed();
    return true;
  }

  async #gitStart(sessionId, settings) {
    if (this.shadowReady) await this.shadowReady;
    const sources = [...settings.gitRepos.map(path => ({ path, take: () => this.git.snapshot(path) })),
      ...(this.shadowRoot ? settings.projectFolders.map(path => ({ path, take: () => this.git.shadowSnapshot(path, this.shadowRoot) })) : [])];
    for (const source of sources) {
      try { this.repo.addGitRecord(sessionId, 'start', await source.take()); this.gitStatus = { lastAt: new Date().toISOString(), error: null }; }
      catch (error) { this.gitStatus = { lastAt: this.gitStatus.lastAt, error: `${source.path}: ${error.message}` }; }
    }
    this.#changed();
  }

  // Title/address keyword exclusions also drop connector entries that mention them.
  #excludedText(value) {
    const lower = String(value ?? '').toLowerCase();
    return this.repo.settings().excludedKeywords.some(k => k.trim() && lower.includes(k.trim().toLowerCase()));
  }

  #filterGit(changes) {
    return { ...changes, commits: changes.commits.filter(c => !this.#excludedText(c.subject)), files: changes.files.filter(f => !this.#excludedText(f.path)) };
  }

  // How the user worked, not only which apps: file and folder operations from any app, and terminal commands.
  setObserve({ watchFiles, captureCommands, browserContext }) {
    const settings = this.repo.settings();
    const patch = {};
    if (typeof watchFiles === 'boolean' && watchFiles !== settings.watchFiles) { patch.watchFiles = watchFiles; this.repo.recordScope(FILES_SCOPE, watchFiles); }
    if (typeof captureCommands === 'boolean' && captureCommands !== settings.captureCommands) { patch.captureCommands = captureCommands; this.repo.recordScope(COMMANDS_SCOPE, captureCommands); }
    if (typeof browserContext === 'boolean' && browserContext !== settings.browserContext) { patch.browserContext = browserContext; this.repo.recordScope(PAGES_SCOPE, browserContext); if (!browserContext && this.inboxDir) { void prunePages(this.inboxDir, new Date(Date.now() + 864e5).toISOString()).catch(() => {}); void setRecordingFlag(this.inboxDir, false); } }
    if (!Object.keys(patch).length) return true;
    this.repo.updateSettings(patch);
    const active = this.repo.activeSession();
    if (active?.status === 'active') { this.#observeHalt(); void this.#observeStart(active.id); }
    this.#changed();
    return true;
  }

  #ignorePath(path) {
    const lower = path.toLowerCase();
    const settings = this.repo.settings();
    if (this.dataDir && lower.startsWith(this.dataDir.toLowerCase())) return true;
    if ((settings.excludedFolders ?? []).some(f => lower === f.toLowerCase() || lower.startsWith(`${f.toLowerCase()}\\`))) return true;
    return settings.excludedKeywords.some(k => k.trim() && lower.includes(k.trim().toLowerCase()));
  }

  async #observeStart(sessionId) {
    const gen = ++this.observeGen;
    const settings = this.repo.settings();
    if (settings.watchFiles) {
      this.files?.close();
      this.files = new FileActivityWatcher({ shouldIgnore: path => this.#ignorePath(path) });
      this.files.on('op', op => this.#onFileOp(sessionId, op));
      for (const r of [...this.defaultWatchRoots, ...settings.gitRepos, ...settings.projectFolders]) if (watchableRoot(r)) this.files.add(r);
      for (const start of this.repo.gitRecords(sessionId, 'start')) if (watchableRoot(start.repo)) this.files.add(start.repo);
    }
    if (settings.captureCommands) {
      if (this.commandBusy) await this.commandBusy;
      await this.terminal.mark().catch(() => {});
    }
    if (settings.browserContext) { if (this.pageBusy) await this.pageBusy; this.pageCursor = new Date().toISOString(); if (this.inboxDir) await setRecordingFlag(this.inboxDir, true); }
    if (gen !== this.observeGen) return; // a newer pause/resume superseded this start
    if (settings.captureCommands || settings.browserContext) {
      clearInterval(this.commandTimer);
      this.commandTimer = setInterval(() => { if (settings.captureCommands) void this.#readCommands(sessionId); if (settings.browserContext) void this.#readPagesNow(sessionId); }, COMMAND_POLL_MS);
      this.commandTimer.unref?.();
    }
  }

  #observeHalt() {
    this.files?.close(); this.files = null;
    clearInterval(this.commandTimer); this.commandTimer = null;
  }

  // Final command read up to now (commands typed before pausing count), then stop observing.
  // A generation counter keeps a late final read (from a pause) from clearing the cursor of a newer resume.
  async #observeStop(sessionId) {
    const gen = this.observeGen;
    const reading = this.commandTimer;
    this.#observeHalt();
    if (reading) { const s = this.repo.settings(); if (s.captureCommands) await this.#readCommands(sessionId, true); if (s.browserContext) await this.#readPagesNow(sessionId, true); }
    if (gen === this.observeGen) { this.pageCursor = null; if (this.inboxDir) await setRecordingFlag(this.inboxDir, false); }
  }

  // Page context from the browser extension, only for the time the session is recording.
  async #readPagesNow(sessionId, force = false) {
    if (this.pageBusy) return this.pageBusy;
    if (!this.inboxDir || !this.pageCursor || (!force && this.repo.session(sessionId)?.status !== 'active')) return;
    this.pageBusy = (async () => {
      try {
        const until = new Date().toISOString();
        const pages = await readPages(this.inboxDir, this.pageCursor, until);
        this.pageCursor = until;
        const settings = this.repo.settings();
        let added = 0;
        for (const page of pages) {
          let host = ''; try { host = normalizeSite(new URL(page.url).host); } catch { continue; }
          if ((settings.excludedSites ?? []).some(e => { const x = normalizeSite(e); return x && (host === x || host.endsWith(`.${x}`)); })) continue;
          if (this.#ignorePath(`${page.url} ${page.title}`)) continue;
          this.repo.addPage(sessionId, page); added++;
        }
        if (added) this.#changed();
      } catch { /* inbox unreadable */ }
    })();
    try { await this.pageBusy; } finally { this.pageBusy = null; }
  }

  async #readCommands(sessionId, force = false) {
    if (this.commandBusy) return this.commandBusy;
    if (!force && this.repo.session(sessionId)?.status !== 'active') return;
    this.commandBusy = (async () => {
      try {
        const commands = await this.terminal.read();
        if (!this.repo.session(sessionId) || this.repo.activityCount(sessionId, 'command') >= MAX_ACTIVITY) return;
        let added = 0;
        for (const c of commands) if (!this.#ignorePath(c.command)) { this.repo.addActivity(sessionId, 'command', c); added++; }
        if (added) this.#changed();
      } catch { /* history unreadable: nothing recorded */ }
    })();
    try { await this.commandBusy; } finally { this.commandBusy = null; }
  }

  #onFileOp(sessionId, op) {
    const session = this.repo.session(sessionId);
    if (session?.status !== 'active' || this.repo.activityCount(sessionId, 'file') >= MAX_ACTIVITY) return;
    this.repo.addActivity(sessionId, 'file', { op: op.op, path: redact(op.path), from: op.from ? redact(op.from) : null, isDir: op.isDir, size: op.size, at: op.at });
    // A file changed somewhere not yet tracked: baseline its project so later saves show exact lines.
    if (this.repo.settings().autoTrack && !op.isDir && (op.op === 'modified' || op.op === 'created')) {
      this.tracking.pending = this.tracking.pending.then(() => this.#trackForFile(sessionId, op.path)).catch(() => {});
    }
    this.#changed();
  }

  async #trackForFile(sessionId, file) {
    let dir = dirnamePath(file), root = null;
    for (let d = dir, i = 0; i < 8 && watchableRoot(d); i++, d = dirnamePath(d)) {
      if (existsSync(joinPath(d, '.git'))) { root = d; break; }
      if (!root && ['package.json', 'pyproject.toml', 'composer.json', 'Cargo.toml', 'go.mod', 'pom.xml', '.project'].some(m => existsSync(joinPath(d, m)))) root = d;
      if (dirnamePath(d) === d) break;
    }
    root ??= dir;
    if (watchableRoot(root)) { await this.#track(sessionId, root, file); this.files?.add(root); }
  }

  #watchExplorerFolder() {
    if (!this.files || this.repo.activeSession()?.status !== 'active') return;
    const current = this.capture.current();
    if (current?.appId === 'explorer' && current.path && watchableRoot(current.path)) this.files.add(current.path, { recursive: false });
  }

  // Editor project tracking: projects opened in VS Code-family editors are baselined automatically (Git repo or
  // private folder snapshot) the moment they appear, so their changes can be shown live and in the recap.
  setAutoTrack({ enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be yes or no.');
    const settings = this.repo.settings();
    if (enabled === settings.autoTrack) return true;
    this.repo.updateSettings({ autoTrack: enabled, ...(enabled && !settings.includeDiffs ? { includeDiffs: true } : {}) });
    this.repo.recordScope(TRACK_SCOPE, enabled);
    if (enabled && !settings.includeDiffs) this.repo.recordScope(DIFF_SCOPE, true);
    const active = this.repo.activeSession();
    if (enabled && active?.status === 'active') this.#trackingStart(active.id);
    this.#changed();
    return true;
  }

  #trackingStart(sessionId) {
    const settings = this.repo.settings();
    if (settings.autoTrack) this.tracking.pending = this.tracking.pending.then(async () => {
      const { open } = await this.#folders(true);
      for (const folder of open) await this.#track(sessionId, folder);
    }).catch(() => {});
    this.#liveStart(sessionId);
  }

  async #folders(refresh = false) {
    if (refresh || !this.tracking.folders || Date.now() - this.tracking.foldersAt > 20000) {
      this.tracking.folders = await this.editors().catch(() => ({ byName: new Map(), open: [] }));
      this.tracking.foldersAt = Date.now();
    }
    return this.tracking.folders;
  }

  #trackCurrent() {
    const settings = this.repo.settings();
    const active = this.repo.activeSession();
    const current = this.capture.current();
    if (!settings.autoTrack || active?.status !== 'active' || !current || current.excluded || this.tracking.sessionId !== active.id) return;
    const parsed = editorFile(current.appId, current.window);
    if (!parsed?.project) return;
    this.tracking.pending = this.tracking.pending.then(async () => {
      let folder = (await this.#folders()).byName.get(parsed.project.toLowerCase());
      if (!folder) folder = (await this.#folders(true)).byName.get(parsed.project.toLowerCase());
      if (folder) await this.#track(active.id, folder);
    }).catch(() => {});
  }

  async #track(sessionId, folder, touched = null) {
    const settings = this.repo.settings();
    const key = folder.toLowerCase();
    if (this.tracking.sessionId !== sessionId || this.tracking.paths.has(key) || !this.repo.session(sessionId)) return;
    this.tracking.paths.add(key);
    if ((settings.excludedFolders ?? []).some(f => key === f.toLowerCase() || key.startsWith(`${f.toLowerCase()}\\`))) return;
    try {
      let start;
      try {
        const top = await this.git.resolveRepo(folder);
        if (top.toLowerCase() !== key && this.tracking.paths.has(top.toLowerCase())) return;
        this.tracking.paths.add(top.toLowerCase());
        start = await this.git.snapshot(top);
        if (touched && start.fingerprints) { const rel = touched.slice(top.length + 1).replace(/\\/g, '/'); delete start.fingerprints[rel]; }
      } catch (error) {
        if (/not installed/i.test(error.message) || !this.shadowRoot) throw error;
        start = await this.git.shadowSnapshot(folder, this.shadowRoot);
      }
      this.repo.addGitRecord(sessionId, 'start', { ...start, auto: true });
      if (this.files && watchableRoot(start.repo)) this.files.add(start.repo);
      this.gitStatus = { lastAt: new Date().toISOString(), error: null };
    } catch (error) { this.gitStatus = { lastAt: this.gitStatus.lastAt, error: `${folder}: ${error.message}` }; }
    this.#changed();
  }

  // Live view: every LIVE_PROBE_MS while recording, compare tracked sources with their baselines (non-destructive).
  #liveStart(sessionId) {
    const settings = this.repo.settings();
    if (!settings.autoTrack && !settings.gitEnabled) return;
    this.#liveStop();
    this.live.sessionId = sessionId;
    this.live.timer = setInterval(() => { void this.#liveProbe(sessionId); }, this.liveProbeMs);
    this.live.timer.unref?.();
  }

  #liveStop() {
    if (this.live.timer) clearInterval(this.live.timer);
    this.live.timer = null;
  }

  async #liveProbe(sessionId) {
    if (this.live.busy || this.live.sessionId !== sessionId || this.repo.session(sessionId)?.status !== 'active') return;
    this.live.busy = true;
    try {
      const settings = this.repo.settings();
      const repos = [];
      for (const start of this.repo.gitRecords(sessionId, 'start')) {
        if (start.auto ? !settings.autoTrack : !settings.gitEnabled) continue;
        try {
          const c = this.#filterGit(start.shadow ? await this.git.shadowChanges(start, { diffs: settings.includeDiffs, keep: true }) : await this.git.changesSince(start, { diffs: settings.includeDiffs }));
          if (c.files.length || c.commits.length) repos.push({ name: c.name, shadow: !!c.shadow, commits: c.commits, files: c.files.map(f => ({ path: f.path, status: f.status, added: f.added, deleted: f.deleted, what: f.what ?? null })) });
        } catch { /* a failing source is reported at session end */ }
      }
      if (this.live.sessionId === sessionId) { this.live.repos = repos; this.live.at = new Date().toISOString(); this.#changed(); }
    } finally { this.live.busy = false; }
  }

  async #dropSnapshots(starts) {
    for (const start of starts) if (start.shadow && start.dir) await rm(start.dir, { recursive: true, force: true }).catch(() => {});
  }

  // Project folders (no Git needed): snapshotted privately at session start/end, compared, then discarded.
  async addProjectFolder({ path }) {
    const folder = text(path, 260, 'Project folder');
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error('That folder does not exist.');
    if (parsePath(folder).root.replace(/\\$/, '').toLowerCase() === folder.replace(/[\\/]+$/, '').toLowerCase()) throw new Error('Choose a project folder, not a whole drive.');
    const settings = this.repo.settings();
    if (settings.projectFolders.some(f => f.toLowerCase() === folder.toLowerCase())) return folder;
    if (settings.projectFolders.length >= MAX_FOLDERS) throw new Error(`Up to ${MAX_FOLDERS} project folders can be added.`);
    if (!settings.projectFolders.length) this.repo.recordScope(FOLDER_SCOPE, true);
    this.repo.updateSettings({ projectFolders: [...settings.projectFolders, folder] });
    this.#changed();
    return folder;
  }

  removeProjectFolder({ path }) {
    const remaining = this.repo.settings().projectFolders.filter(f => f !== path);
    this.repo.updateSettings({ projectFolders: remaining });
    if (!remaining.length) this.repo.recordScope(FOLDER_SCOPE, false);
    this.#changed();
    return true;
  }

  setIncludeDiffs({ enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('Enabled must be yes or no.');
    if (enabled === this.repo.settings().includeDiffs) return true;
    this.repo.updateSettings({ includeDiffs: enabled });
    this.repo.recordScope(DIFF_SCOPE, enabled);
    this.#changed();
    return true;
  }

  async #gitEnd(sessionId) {
    this.#liveStop();
    await this.#observeStop(sessionId);
    if (this.inboxDir) await prunePages(this.inboxDir, new Date().toISOString()).catch(() => {});
    if (this.gitPending) { await this.gitPending; this.gitPending = null; }
    await this.tracking.pending;
    const settings = this.repo.settings();
    const starts = this.repo.session(sessionId) ? this.repo.gitRecords(sessionId, 'start') : [];
    const wanted = start => start.auto ? settings.autoTrack : settings.gitEnabled;
    if (!starts.some(wanted)) { await this.#dropSnapshots(starts); return; }
    const diffs = settings.includeDiffs;
    for (const start of starts.filter(wanted)) {
      try {
        const changes = start.shadow ? await this.git.shadowChanges(start, { diffs }) : await this.git.changesSince(start, { diffs });
        this.repo.addGitRecord(sessionId, 'changes', this.#filterGit(changes));
        this.gitStatus = { lastAt: new Date().toISOString(), error: null };
      } catch (error) { this.gitStatus = { lastAt: this.gitStatus.lastAt, error: `${start.repo}: ${error.message}` }; }
    }
    await this.#dropSnapshots(starts);
  }

  startSession({ title }) {
    const settings = this.repo.settings();
    if (!settings.onboardedAt) throw new Error('Finish setup before starting a session.');
    if (this.repo.activeSession()) throw new Error('End the current session before starting another.');
    const id = this.repo.createSession(text(title, LIMITS.title, 'Session name'));
    if (settings.captureConsented) this.capture.start();
    if (settings.gitEnabled && (settings.gitRepos.length || settings.projectFolders.length)) this.gitPending = this.#gitStart(id, settings);
    this.tracking = { sessionId: id, paths: new Set(settings.gitEnabled ? [...settings.gitRepos, ...settings.projectFolders].map(p => p.toLowerCase()) : []), pending: Promise.resolve(), folders: null, foldersAt: 0 };
    if (settings.agentsEnabled) this.#agentsStart(id);
    this.#trackingStart(id);
    void this.#observeStart(id);
    this.#changed();
    return id;
  }

  pauseSession() {
    const active = this.#requireActive();
    this.capture.stop();
    this.#liveStop();
    void this.#observeStop(active.id);
    void this.#agentsStop(active.id);
    this.repo.setSessionStatus(active.id, 'paused');
    this.#changed();
    return true;
  }

  resumeSession() {
    const active = this.#requireActive();
    this.repo.setSessionStatus(active.id, 'active');
    if (this.repo.settings().captureConsented) this.capture.start();
    if (this.repo.settings().agentsEnabled) this.#agentsStart(active.id);
    this.#liveStart(active.id);
    void this.#observeStart(active.id);
    this.#changed();
    return true;
  }

  async endSession({ summarize = true } = {}) {
    const active = this.#requireActive();
    this.capture.stop();
    this.repo.setSessionStatus(active.id, 'ended');
    this.#changed();
    // Final collection (agents, code changes, commands, pages) runs inside the recap job so progress shows at once.
    const collect = async () => { await this.#agentsStop(active.id, true); await this.#gitEnd(active.id); };
    if (summarize) return this.#summarize(active.id, collect);
    await collect();
    return { sessionId: active.id };
  }

  #requireActive() {
    const active = this.repo.activeSession();
    if (!active) throw new Error('There is no active session.');
    return active;
  }

  addNote({ text: body, sessionId }) {
    const id = sessionId ?? this.repo.activeSession()?.id;
    if (!id || !this.repo.session(id)) throw new Error('Start or open a session before adding a note.');
    const noteId = this.repo.addNote(id, text(body, LIMITS.note, 'Note'));
    this.#changed();
    return noteId;
  }

  deleteNote({ id }) {
    if (!this.repo.deleteNote(String(id))) throw new Error('That note no longer exists.');
    this.#changed();
    return true;
  }

  hideEvent({ id, hidden }) {
    if (!this.repo.hideEvent(String(id), !!hidden)) throw new Error('That activity entry no longer exists.');
    this.#changed();
    return true;
  }

  renameSession({ id, title }) {
    this.repo.renameSession(String(id), text(title, LIMITS.title, 'Session name'));
    this.#changed();
    return true;
  }

  // One inference job at a time; cancellation is checked before anything is committed.
  async #run(kind, sessionId, work) {
    if (this.job) throw new Error('Continuum is already working on a recap. Wait or cancel it first.');
    const controller = new AbortController();
    this.job = { kind, sessionId, controller, stage: 'Starting' };
    const stage = name => { if (this.job) this.job.stage = name; this.#progress(name); this.#changed(); };
    try { return await work(controller.signal, stage); }
    finally { this.job = null; this.#changed(); }
  }

  cancel() {
    this.job?.controller.abort();
    return true;
  }

  #check(signal) { if (signal.aborted) throw new Error('Canceled. Nothing new was saved.'); }

  async summarize({ sessionId }) { return this.#summarize(String(sessionId)); }

  async #summarize(sessionId, collect = null) {
    if (!this.repo.session(sessionId)) throw new Error('That session no longer exists.');
    return this.#run('summarize', sessionId, async (signal, stage) => {
      if (collect) { stage('Collecting code changes and activity'); await collect(); }
      const session = this.repo.session(sessionId);
      if (!session) throw new Error('This session was deleted while the recap was running.');
      stage('Preparing session timeline');
      const bundle = buildBundle(session, this.repo.events(session.id), this.repo.notes(session.id), this.repo.gitRecords(session.id, 'changes'), this.repo.agentEvents(session.id), { files: this.repo.activity(session.id, 'file'), commands: this.repo.activity(session.id, 'command'), pages: this.repo.pages(session.id) });
      const models = this.#models();
      let output, generator = 'model', failure = null, metrics = null;
      const started = Date.now();
      if (!bundle.timeline.length && !bundle.notes.length && !bundle.changes.length && !bundle.agent.length && !bundle.files.length && !bundle.fileOps.length && !bundle.commands.length && !bundle.webSearches.length && !bundle.pages.length) { generator = 'fallback'; failure = 'nothing was recorded'; }
      else {
        let feedback = '';
        for (let attempt = 0; attempt < 2 && !output; attempt++) {
          this.#check(signal);
          stage(attempt ? 'Checking a revised recap' : 'Thinking on this device');
          try {
            const raw = await this.provider.generate({ model: models.generation, system: SYSTEM_PROMPT, user: buildUserPrompt(bundle) + feedback, schema: RECAP_SCHEMA, signal });
            metrics = this.provider.lastMetrics;
            output = validateRecap(raw, bundle);
          } catch (error) {
            this.#check(signal);
            failure = error.message;
            feedback = `\nYour previous answer was rejected: ${error.message} Cite only these IDs: ${Object.keys(bundle.refs).join(', ')}. Fix it and follow the rules exactly.`;
            if (/not reachable|fetch failed|ECONNREFUSED|request failed \((404|500)/i.test(error.message)) break;
          }
        }
        if (!output) generator = 'fallback';
      }
      if (!output) output = fallbackRecap(bundle, failure);
      output.resources = topResources(bundle);
      output.last = lastForeground(bundle);
      output.refs = bundle.refs;
      output.changes = gitEvidence(bundle);
      output.files = bundle.files;
      output.report = sessionReport(bundle, this.repo.events(session.id));
      this.#check(signal);
      if (!this.repo.session(session.id)) throw new Error('This session was deleted while the recap was running.');
      const summaryId = this.repo.addSummary(session.id, { output, generator, modelId: generator === 'model' ? models.generation : null, elapsedMs: Date.now() - started });
      let indexError = null;
      try { stage('Indexing for search on this device'); await this.#index(session.id, signal); }
      catch (error) { indexError = signal.aborted ? 'Indexing canceled.' : error.message; }
      return { sessionId: session.id, summaryId, generator, failure: generator === 'fallback' ? failure : null, indexError, metrics, elapsedMs: Date.now() - started };
    });
  }

  async #index(sessionId, signal) {
    const summary = this.repo.latestSummary(sessionId);
    const session = this.repo.session(sessionId);
    const rows = [];
    if (summary) for (const part of chunk(`${session.title}. ${summaryText(summary.output)}`)) rows.push({ kind: 'summary', refId: summary.id, text: part });
    for (const note of this.repo.notes(sessionId)) for (const part of chunk(note.body)) rows.push({ kind: 'note', refId: note.id, text: part });
    const activity = [...(summary?.output.resources ?? []).map(r => `${r.app}${r.window ? ` — ${r.window}` : ''}${r.location ? ` (${r.location})` : ''}`), ...(summary?.output.changes ?? []).map(c => c.path ? `changed ${c.path} in ${c.repo}` : `commit ${c.subject}`)].join('; ');
    if (activity) for (const part of chunk(`${session.title}: ${activity}`)) rows.push({ kind: 'activity', refId: null, text: part });
    if (!rows.length) return;
    const { embedding } = this.#models();
    const vectors = await this.provider.embed({ model: embedding, texts: rows.map(r => r.text), signal });
    this.#check(signal);
    if (!this.repo.session(sessionId)) return;
    this.repo.replaceEmbeddings(sessionId, rows.map((r, i) => ({ ...r, vector: vectors[i] })), embedding);
  }

  async editSummary({ sessionId, taskTitle, recap, nextSteps }) {
    const summary = this.repo.latestSummary(String(sessionId));
    if (!summary) throw new Error('This session has no recap to edit yet.');
    const output = { ...summary.output, task_title: text(taskTitle, 90, 'Task'), recap: text(recap, 600, 'Recap') };
    // Unchanged steps keep their evidence; rewritten steps become user-provided (no evidence).
    if (Array.isArray(nextSteps)) output.next_steps = nextSteps.slice(0, 3).map(step => {
      const value = text(step, 240, 'Next step');
      return summary.output.next_steps.find(n => n.text === value) ?? { text: value, evidence: [], edited: true };
    });
    this.repo.editSummary(summary.id, output);
    this.#changed();
    try { await this.#index(summary.sessionId, new AbortController().signal); return { indexError: null }; }
    catch (error) { return { indexError: error.message }; }
  }

  async search({ query }) {
    const q = text(query, LIMITS.query, 'Search');
    const sessions = new Map(this.repo.sessions(LIMITS.sessions).map(s => [s.id, s]));
    const hits = new Map();
    const add = (sessionId, score, snippet, kind, mode) => {
      if (!sessions.has(sessionId)) return;
      const current = hits.get(sessionId);
      if (!current || score > current.score) hits.set(sessionId, { sessionId, score, snippet, kind, mode });
    };
    let mode = 'semantic', error = null;
    const rows = this.repo.embeddings();
    try {
      const [vector] = await this.provider.embed({ model: this.#models().embedding, texts: [q] });
      for (const row of rows) add(row.sessionId, cosine(vector, row.vector), row.text, row.kind, 'semantic');
    } catch (e) { mode = 'keyword'; error = e.message; }
    // Keyword matching covers sessions without embeddings and works when the model is unavailable.
    const terms = q.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const indexed = new Set(rows.map(r => r.sessionId));
    for (const session of sessions.values()) {
      if (mode === 'semantic' && indexed.has(session.id)) continue;
      const summary = this.repo.latestSummary(session.id);
      const haystack = [session.title, summary ? summaryText(summary.output) : '', ...this.repo.notes(session.id).map(n => n.body), ...this.repo.events(session.id, { includeHidden: false }).map(e => `${e.appLabel} ${e.window ?? ''} ${e.path ?? ''} ${e.url ?? ''}`), ...this.repo.activity(session.id, 'command').map(c => c.command), ...this.repo.activity(session.id, 'file').map(f => f.path), ...this.repo.pages(session.id).map(p => `${p.title} ${(p.headings ?? []).join(' ')} ${p.selection ?? ''}`)].join(' \n ');
      const lower = haystack.toLowerCase();
      const matched = terms.filter(t => lower.includes(t));
      if (!matched.length) continue;
      const at = lower.indexOf(matched[0]);
      add(session.id, 0.2 + 0.6 * (matched.length / terms.length), haystack.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim(), 'keyword', 'keyword');
    }
    const results = [...hits.values()].filter(h => h.mode === 'keyword' || h.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, 8)
      .map(h => ({ ...h, session: sessions.get(h.sessionId), summaryTitle: this.repo.latestSummary(h.sessionId)?.output.task_title ?? null }));
    return { query: q, mode, error, results };
  }

  deleteSession({ id }) {
    const session = this.repo.session(String(id));
    if (!session) throw new Error('That session no longer exists.');
    if (this.job?.sessionId === session.id) this.cancel();
    if (session.status !== 'ended') { this.capture.stop(); this.#agentsHalt(); this.#liveStop(); this.#observeHalt(); void this.#dropSnapshots(this.repo.gitRecords(session.id, 'start')); }
    this.repo.deleteSession(session.id);
    this.#changed();
    return true;
  }

  clearAll() {
    this.cancel();
    this.capture.stop();
    this.#liveStop();
    this.#observeHalt();
    this.#agentsHalt();
    if (this.inboxDir) { void clearInbox(this.inboxDir).catch(() => {}); void prunePages(this.inboxDir, new Date(Date.now() + 864e5).toISOString()).catch(() => {}); void setRecordingFlag(this.inboxDir, false); }
    if (this.shadowRoot) void rm(this.shadowRoot, { recursive: true, force: true }).catch(() => {});
    this.repo.clearAll();
    this.#changed();
    return true;
  }

  exportData() {
    return {
      exportedAt: new Date().toISOString(), app: 'Continuum', settings: this.repo.settings(), consentRecords: this.repo.consentRecords(),
      sessions: this.repo.sessions(LIMITS.sessions).map(s => ({ ...this.sessionDetail(s.id), indexed: undefined })),
    };
  }
}
