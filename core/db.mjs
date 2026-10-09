import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  consent_version TEXT,
  capture_consented INTEGER NOT NULL DEFAULT 0,
  excluded_apps TEXT NOT NULL DEFAULT '[]',
  excluded_keywords TEXT NOT NULL DEFAULT '[]',
  generation_model TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  onboarded_at TEXT
);
CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  capture_scope TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title_enc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_app TEXT,
  last_window_enc TEXT,
  excluded_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  app_id TEXT NOT NULL,
  app_label TEXT NOT NULL,
  window_enc TEXT,
  source TEXT NOT NULL CHECK (source IN ('foreground', 'lifecycle')),
  redacted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, started_at);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  body_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_session ON notes (session_id, created_at);
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  output_enc TEXT NOT NULL,
  generator TEXT NOT NULL CHECK (generator IN ('model', 'fallback')),
  model_id TEXT,
  elapsed_ms INTEGER,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS summaries_session ON summaries (session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'note', 'activity')),
  ref_id TEXT,
  text_enc TEXT NOT NULL,
  vector_enc TEXT NOT NULL,
  model_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS embeddings_session ON embeddings (session_id);
`;

const now = () => new Date().toISOString();

// Encrypted local repository. Identifiers, timestamps, status and app process names stay in plaintext for
// ordering and exclusion; titles, window labels, notes, summaries, embedded text and vectors are encrypted.
export class Repository {
  constructor(file, cipher, defaults) {
    this.cipher = cipher;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.db.prepare(`INSERT OR IGNORE INTO settings (id, excluded_apps, excluded_keywords, generation_model, embedding_model) VALUES (1, ?, ?, ?, ?)`)
      .run(JSON.stringify(defaults.excludedApps), JSON.stringify(defaults.excludedKeywords), defaults.generationModel, defaults.embeddingModel);
  }
  // v2: folder/website exclusions, per-category capture permissions, location (folder or URL) per event.
  #migrate() {
    const add = (table, column, definition) => {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    add('settings', 'excluded_folders', "TEXT NOT NULL DEFAULT '[]'");
    add('settings', 'excluded_sites', "TEXT NOT NULL DEFAULT '[]'");
    add('settings', 'capture_paths', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'capture_urls', 'INTEGER NOT NULL DEFAULT 0');
    add('events', 'path_enc', 'TEXT');
    add('events', 'url_enc', 'TEXT');
    add('settings', 'git_enabled', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'git_repos_enc', 'TEXT');
    add('settings', 'agents_enabled', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'include_diffs', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'auto_track', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'watch_files', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'capture_commands', 'INTEGER NOT NULL DEFAULT 0');
    add('settings', 'browser_context', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      data_enc TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS pages_session ON pages (session_id, at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('file', 'command')),
      at TEXT NOT NULL,
      data_enc TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS activity_session ON activity (session_id, kind, at);`);
    add('settings', 'folders_enc', 'TEXT');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      data_enc TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS agent_events_session ON agent_events (session_id, at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS git_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('start', 'changes')),
      data_enc TEXT NOT NULL,
      created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS git_records_session ON git_records (session_id, kind);`);
  }
  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // Settings and consent
  settings() {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get();
    return {
      consentVersion: row.consent_version, captureConsented: !!row.capture_consented,
      excludedApps: JSON.parse(row.excluded_apps), excludedKeywords: JSON.parse(row.excluded_keywords),
      excludedFolders: JSON.parse(row.excluded_folders), excludedSites: JSON.parse(row.excluded_sites),
      capturePaths: !!row.capture_paths, captureUrls: !!row.capture_urls,
      agentsEnabled: !!row.agents_enabled, includeDiffs: !!row.include_diffs, autoTrack: !!row.auto_track, watchFiles: !!row.watch_files, captureCommands: !!row.capture_commands, browserContext: !!row.browser_context, projectFolders: row.folders_enc ? this.cipher.decryptJson(row.folders_enc) : [], gitEnabled: !!row.git_enabled, gitRepos: row.git_repos_enc ? this.cipher.decryptJson(row.git_repos_enc) : [],
      generationModel: row.generation_model, embeddingModel: row.embedding_model, onboardedAt: row.onboarded_at,
    };
  }
  updateSettings(patch) {
    if ('gitRepos' in patch) this.db.prepare('UPDATE settings SET git_repos_enc = ? WHERE id = 1').run(this.cipher.encryptJson(patch.gitRepos));
    if ('projectFolders' in patch) this.db.prepare('UPDATE settings SET folders_enc = ? WHERE id = 1').run(this.cipher.encryptJson(patch.projectFolders));
    const map = { browserContext: 'browser_context', watchFiles: 'watch_files', captureCommands: 'capture_commands', autoTrack: 'auto_track', includeDiffs: 'include_diffs', agentsEnabled: 'agents_enabled', gitEnabled: 'git_enabled', excludedApps: 'excluded_apps', excludedKeywords: 'excluded_keywords', excludedFolders: 'excluded_folders', excludedSites: 'excluded_sites', capturePaths: 'capture_paths', captureUrls: 'capture_urls', generationModel: 'generation_model', embeddingModel: 'embedding_model', onboardedAt: 'onboarded_at', consentVersion: 'consent_version' };
    for (const [key, column] of Object.entries(map)) {
      if (!(key in patch)) continue;
      const value = Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : typeof patch[key] === 'boolean' ? (patch[key] ? 1 : 0) : patch[key];
      this.db.prepare(`UPDATE settings SET ${column} = ? WHERE id = 1`).run(value);
    }
  }
  setConsent(granted, scope, version) {
    this.transaction(() => {
      const at = now();
      if (granted) {
        this.db.prepare('INSERT INTO consent_records (id, capture_scope, consented_at) VALUES (?, ?, ?)').run(randomUUID(), scope, at);
        this.db.prepare('UPDATE settings SET capture_consented = 1, consent_version = ? WHERE id = 1').run(version);
      } else {
        this.db.prepare("UPDATE consent_records SET revoked_at = ? WHERE revoked_at IS NULL AND capture_scope IN (?, 'file-explorer-folder-paths', 'browser-full-addresses')").run(at, scope);
        this.db.prepare('UPDATE settings SET capture_consented = 0, capture_paths = 0, capture_urls = 0 WHERE id = 1').run();
      }
    });
  }
  // Grants or revokes one optional capture category, keeping an audit record without payloads.
  recordScope(scope, granted) {
    const at = now();
    if (granted) this.db.prepare('INSERT INTO consent_records (id, capture_scope, consented_at) VALUES (?, ?, ?)').run(randomUUID(), scope, at);
    else this.db.prepare('UPDATE consent_records SET revoked_at = ? WHERE capture_scope = ? AND revoked_at IS NULL').run(at, scope);
  }
  consentRecords() {
    return this.db.prepare('SELECT * FROM consent_records ORDER BY consented_at DESC').all()
      .map(r => ({ id: r.id, scope: r.capture_scope, consentedAt: r.consented_at, revokedAt: r.revoked_at }));
  }

  // Sessions
  createSession(title) {
    const id = randomUUID(), at = now();
    this.db.prepare('INSERT INTO sessions (id, title_enc, status, started_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, this.cipher.encrypt(title), 'active', at, at);
    return id;
  }
  setSessionStatus(id, status) {
    const at = now();
    this.db.prepare(`UPDATE sessions SET status = ?, updated_at = ?${status === 'ended' ? ', ended_at = ?' : ''} WHERE id = ?`)
      .run(...(status === 'ended' ? [status, at, at, id] : [status, at, id]));
  }
  renameSession(id, title) {
    this.db.prepare('UPDATE sessions SET title_enc = ?, updated_at = ? WHERE id = ?').run(this.cipher.encrypt(title), now(), id);
  }
  countExcluded(id) {
    this.db.prepare('UPDATE sessions SET excluded_count = excluded_count + 1 WHERE id = ?').run(id);
  }
  session(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? this.#session(row) : null;
  }
  sessions(limit = 100) {
    return this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit).map(row => this.#session(row));
  }
  activeSession() {
    const row = this.db.prepare("SELECT * FROM sessions WHERE status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1").get();
    return row ? this.#session(row) : null;
  }
  #session(row) {
    const counts = this.db.prepare('SELECT COUNT(*) AS events, COALESCE(SUM(duration_ms), 0) AS ms FROM events WHERE session_id = ? AND hidden = 0').get(row.id);
    const notes = this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE session_id = ?').get(row.id).n;
    return {
      id: row.id, title: this.cipher.decrypt(row.title_enc), status: row.status, startedAt: row.started_at, endedAt: row.ended_at,
      lastApp: row.last_app, lastWindow: this.cipher.decrypt(row.last_window_enc), excludedCount: row.excluded_count,
      eventCount: counts.events, trackedMs: counts.ms, noteCount: notes, updatedAt: row.updated_at,
    };
  }
  deleteSession(id) {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }
  clearAll() {
    this.transaction(() => {
      for (const table of ['pages', 'activity', 'agent_events', 'git_records', 'embeddings', 'summaries', 'notes', 'events', 'sessions', 'consent_records']) this.db.exec(`DELETE FROM ${table}`);
      this.db.prepare('UPDATE settings SET capture_consented = 0, capture_paths = 0, capture_urls = 0, git_enabled = 0, git_repos_enc = NULL, agents_enabled = 0, include_diffs = 0, auto_track = 0, watch_files = 0, capture_commands = 0, browser_context = 0, folders_enc = NULL, onboarded_at = NULL WHERE id = 1').run();
    });
    this.db.exec('VACUUM');
  }

  seenApps() {
    return this.db.prepare("SELECT app_id, app_label, COUNT(*) AS n FROM events WHERE source = 'foreground' GROUP BY app_id ORDER BY n DESC").all().map(r => ({ appId: r.app_id, label: r.app_label }));
  }

  // Events
  addEvent(sessionId, event) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO events (id, session_id, started_at, ended_at, duration_ms, app_id, app_label, window_enc, path_enc, url_enc, source, redacted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sessionId, event.startedAt, event.endedAt, event.durationMs, event.appId, event.appLabel, this.cipher.encrypt(event.window ?? null), this.cipher.encrypt(event.path ?? null), this.cipher.encrypt(event.url ?? null), event.source, event.redacted ? 1 : 0);
      if (event.source === 'foreground') this.db.prepare('UPDATE sessions SET last_app = ?, last_window_enc = ?, updated_at = ? WHERE id = ?').run(event.appLabel, this.cipher.encrypt(event.window ?? null), now(), sessionId);
    });
    return id;
  }
  events(sessionId, { includeHidden = true } = {}) {
    return this.db.prepare(`SELECT * FROM events WHERE session_id = ?${includeHidden ? '' : ' AND hidden = 0'} ORDER BY started_at`).all(sessionId).map(r => ({
      id: r.id, sessionId: r.session_id, startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms, appId: r.app_id,
      appLabel: r.app_label, window: this.cipher.decrypt(r.window_enc), path: this.cipher.decrypt(r.path_enc), url: this.cipher.decrypt(r.url_enc), source: r.source, redacted: !!r.redacted, hidden: !!r.hidden,
    }));
  }
  hideEvent(id, hidden) {
    return this.db.prepare('UPDATE events SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id).changes > 0;
  }
  eventSession(id) { return this.db.prepare('SELECT session_id FROM events WHERE id = ?').get(id)?.session_id ?? null; }

  // Coding-agent events (already validated and minimized by core/agents.mjs)
  addAgentEvent(sessionId, record) {
    this.db.prepare('INSERT INTO agent_events (id, session_id, at, data_enc) VALUES (?, ?, ?, ?)').run(randomUUID(), sessionId, record.at, this.cipher.encryptJson(record));
  }
  agentEvents(sessionId) {
    return this.db.prepare('SELECT id, data_enc FROM agent_events WHERE session_id = ? ORDER BY at, rowid').all(sessionId).map(r => ({ id: r.id, ...this.cipher.decryptJson(r.data_enc) }));
  }

  // File operations and terminal commands (validated and redacted before storage)
  addActivity(sessionId, kind, record) {
    this.db.prepare('INSERT INTO activity (id, session_id, kind, at, data_enc) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), sessionId, kind, record.at, this.cipher.encryptJson(record));
  }
  activity(sessionId, kind) {
    return this.db.prepare('SELECT id, data_enc FROM activity WHERE session_id = ? AND kind = ? ORDER BY at, rowid').all(sessionId, kind).map(r => ({ id: r.id, ...this.cipher.decryptJson(r.data_enc) }));
  }
  addPage(sessionId, record) {
    this.db.prepare('INSERT INTO pages (id, session_id, at, data_enc) VALUES (?, ?, ?, ?)').run(randomUUID(), sessionId, record.at, this.cipher.encryptJson(record));
  }
  pages(sessionId) {
    return this.db.prepare('SELECT id, data_enc FROM pages WHERE session_id = ? ORDER BY at, rowid').all(sessionId).map(r => ({ id: r.id, ...this.cipher.decryptJson(r.data_enc) }));
  }
  activityCount(sessionId, kind) { return this.db.prepare('SELECT COUNT(*) AS n FROM activity WHERE session_id = ? AND kind = ?').get(sessionId, kind).n; }

  // Git connector records
  addGitRecord(sessionId, kind, data) {
    this.db.prepare('INSERT INTO git_records (id, session_id, kind, data_enc, created_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), sessionId, kind, this.cipher.encryptJson(data), now());
  }
  gitRecords(sessionId, kind) {
    return this.db.prepare('SELECT data_enc FROM git_records WHERE session_id = ? AND kind = ? ORDER BY created_at, rowid').all(sessionId, kind).map(r => this.cipher.decryptJson(r.data_enc));
  }

  // Notes
  addNote(sessionId, body) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO notes (id, session_id, body_enc, created_at) VALUES (?, ?, ?, ?)').run(id, sessionId, this.cipher.encrypt(body), now());
    return id;
  }
  notes(sessionId) {
    return this.db.prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY created_at').all(sessionId)
      .map(r => ({ id: r.id, sessionId: r.session_id, body: this.cipher.decrypt(r.body_enc), createdAt: r.created_at }));
  }
  deleteNote(id) { return this.db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0; }
  noteSession(id) { return this.db.prepare('SELECT session_id FROM notes WHERE id = ?').get(id)?.session_id ?? null; }

  // Summaries
  addSummary(sessionId, summary) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO summaries (id, session_id, output_enc, generator, model_id, elapsed_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, this.cipher.encryptJson(summary.output), summary.generator, summary.modelId ?? null, summary.elapsedMs ?? null, now());
    return id;
  }
  latestSummary(sessionId) {
    const r = this.db.prepare('SELECT * FROM summaries WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId);
    return r ? { id: r.id, sessionId: r.session_id, output: this.cipher.decryptJson(r.output_enc), generator: r.generator, modelId: r.model_id, elapsedMs: r.elapsed_ms, edited: !!r.edited, createdAt: r.created_at } : null;
  }
  editSummary(id, output) {
    return this.db.prepare('UPDATE summaries SET output_enc = ?, edited = 1 WHERE id = ?').run(this.cipher.encryptJson(output), id).changes > 0;
  }

  // Embeddings
  replaceEmbeddings(sessionId, rows, modelId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM embeddings WHERE session_id = ?').run(sessionId);
      const insert = this.db.prepare('INSERT INTO embeddings (id, session_id, kind, ref_id, text_enc, vector_enc, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) insert.run(randomUUID(), sessionId, row.kind, row.refId ?? null, this.cipher.encrypt(row.text), this.cipher.encryptJson(row.vector), modelId);
    });
  }
  embeddings() {
    return this.db.prepare('SELECT * FROM embeddings').all().map(r => ({
      sessionId: r.session_id, kind: r.kind, refId: r.ref_id, text: this.cipher.decrypt(r.text_enc), vector: this.cipher.decryptJson(r.vector_enc), modelId: r.model_id,
    }));
  }
  embeddingCount(sessionId) { return this.db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE session_id = ?').get(sessionId).n; }
}
