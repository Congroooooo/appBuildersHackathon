export type Evidence = string[];
export interface Item { text: string; evidence: Evidence; edited?: boolean }
export interface Ref { kind: 'event' | 'note' | 'git' | 'agent' | 'file' | 'command' | 'search' | 'page'; host?: string; title?: string; headings?: string[]; excerpt?: string; selections?: string[]; description?: string; engine?: string; query?: string; url?: string; op?: string; from?: string | null; isDir?: boolean; command?: string; shell?: string; shadow?: boolean; diff?: string; what?: string; agent?: string; project?: string; event?: string; tool?: string | null; ok?: boolean | null; at?: string; count?: number; repo?: string; branch?: string | null; commit?: string; subject?: string; path?: string; status?: string; added?: number | null; deleted?: number | null; eventIds?: string[]; noteId?: string; app?: string; window?: string | null; location?: string | null; startedAt?: string; durationMs?: number; text?: string; createdAt?: string }
export interface Resource { app: string; window: string | null; location?: string | null; durationMs: number; evidence: Evidence }
export interface Recap {
  task_title: string; recap: string; observed: Item[]; decisions: Item[]; open_questions: string[]; next_steps: Item[];
  confidence: 'low' | 'medium' | 'high'; limitations: string[]; resources?: Resource[]; last?: { id: string; app: string; window: string | null } | null; refs?: Record<string, Ref>; changes?: (Ref & { id: string })[]; files?: { file: string; project: string | null; app: string; durationMs: number; edited: boolean; evidence: string[] }[]; report?: SessionReportData;
}
export interface Summary { id: string; sessionId: string; output: Recap; generator: 'model' | 'fallback'; modelId: string | null; elapsedMs: number | null; edited: boolean; createdAt: string }
export interface Session {
  id: string; title: string; status: 'active' | 'paused' | 'ended'; startedAt: string; endedAt: string | null; lastApp: string | null; lastWindow: string | null;
  excludedCount: number; eventCount: number; trackedMs: number; noteCount: number; updatedAt: string; summaryTitle?: string | null; summaryGenerator?: 'model' | 'fallback' | null;
}
export interface ActivityEvent { id: string; sessionId: string; startedAt: string; endedAt: string; durationMs: number; appId: string; appLabel: string; window: string | null; path?: string | null; url?: string | null; source: 'foreground' | 'lifecycle'; redacted: boolean; hidden: boolean }
export interface Note { id: string; sessionId: string; body: string; createdAt: string }
export interface AgentEvent { id: string; agent: 'claude_code' | 'opencode'; at: string; session: string; project: string; event: 'session_start' | 'tool' | 'file_edit' | 'turn_end'; tool?: string; file?: string; ok?: boolean }
export interface FileOp { id: string; op: 'created' | 'deleted' | 'renamed' | 'modified'; path: string; from: string | null; isDir: boolean; size: number | null; at: string }
export interface Command { id: string; shell: string; command: string; at: string }
export interface SessionReportData { pages?: { id: string; title: string; host: string; url: string; headings: string[]; excerpt: string | null; selections: string[]; at: string }[]; searches?: { id: string; engine: string; query: string; at: string }[]; apps: { app: string; durationMs: number }[]; sites: { host: string; durationMs: number; pages: string[] }[]; files: Record<'created' | 'deleted' | 'renamed' | 'modified', { id: string; path: string; from: string | null; isDir: boolean; count: number }[]>; commands: { id: string; shell: string; command: string; at: string }[] }
export interface LiveChanges { at: string | null; repos: { name: string; shadow: boolean; commits: { sha: string; subject: string }[]; files: { path: string; status: string; added: number | null; deleted: number | null; what: string | null }[] }[] }
export interface Detail { session: Session; events: ActivityEvent[]; agentEvents: AgentEvent[]; liveChanges?: LiveChanges | null; fileActivity?: FileOp[]; commands?: Command[]; notes: Note[]; summary: Summary | null; indexed: boolean }
export interface Settings { consentVersion: string | null; captureConsented: boolean; excludedApps: string[]; excludedKeywords: string[]; excludedFolders: string[]; excludedSites: string[]; capturePaths: boolean; captureUrls: boolean; autoTrack: boolean; watchFiles: boolean; captureCommands: boolean; browserContext: boolean; gitEnabled: boolean; gitRepos: string[]; generationModel: string; embeddingModel: string; onboardedAt: string | null }
export interface ModelInfo { name: string; size: number; digest: string; parameterSize?: string; quantization?: string }
export interface Health { ready: boolean; runtime: boolean; version?: string; missing: string[]; models: ModelInfo[]; error?: string; checkedAt?: string }
export interface CaptureCurrent { excluded: boolean; appLabel?: string; window?: string | null; path?: string | null; url?: string | null; since: string }
export interface DeviceApp { appId: string; label: string; sources: ('running' | 'installed' | 'seen')[]; path: string | null }
export interface Exclusions { excludedApps: string[]; excludedFolders: string[]; excludedSites: string[]; excludedKeywords: string[] }
export type CaptureState = 'stopped' | 'recording' | 'away' | 'unavailable';
export interface Snapshot {
  loadError: string | null; runtimeError?: string | null; runtimeOwned?: boolean | null; dataPath?: string;
  settings: Settings; consentRecords: { id: string; scope: string; consentedAt: string; revokedAt: string | null }[];
  capture: { state: CaptureState; error: string | null; current: CaptureCurrent | null };
  active: Detail | null; latest: Detail | null; sessions: Session[];
  job: { kind: string; sessionId: string; stage: string } | null; health: Health | null; promptVersion: string;
  observe?: { watchFiles: boolean; captureCommands: boolean; roots: string[] };
  connectors: { git: { enabled: boolean; autoTrack: boolean; repos: string[]; folders: string[]; includeDiffs: boolean; lastAt: string | null; error: string | null }; agents: { enabled: boolean; lastAt: string | null; error: string | null; count: number; inbox: string | null } };
  connectorsDir?: string;
}
export interface SearchResult { sessionId: string; score: number; snippet: string; kind: string; mode: 'semantic' | 'keyword'; session: Session; summaryTitle: string | null }
export interface SearchResponse { query: string; mode: 'semantic' | 'keyword'; error: string | null; results: SearchResult[] }
export interface SummarizeResult { sessionId: string; generator: 'model' | 'fallback'; failure: string | null; indexError: string | null; elapsedMs: number }
