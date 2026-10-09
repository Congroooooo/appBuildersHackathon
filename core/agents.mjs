import { readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './privacy.mjs';

// Coding-agent connector: adapters (connectors/claude-code-hook.mjs, connectors/opencode-plugin.js) append
// minimized JSON lines to files in Continuum's own data folder. There is no network listener. Every line is
// treated as untrusted input: strictly validated, bounded, redacted and de-duplicated before use.
export const INBOX_FILES = { claude_code: 'claude-code.jsonl', opencode: 'opencode.jsonl' };
export const AGENT_LABELS = { claude_code: 'Claude Code', opencode: 'OpenCode' };
const EVENTS = new Set(['session_start', 'tool', 'file_edit', 'turn_end']);
const MAX_LINES = 2000;

const str = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max) : undefined;

export function parseRecord(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object' || r.v !== 1 || !(r.agent in INBOX_FILES) || !EVENTS.has(r.event)) return null;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  const tool = str(r.tool, 40), file = str(r.file, 200);
  if (tool && !/^[\w .:-]+$/.test(tool)) return null;
  return {
    agent: r.agent, at: new Date(at).toISOString(), session: /^[0-9a-f]{8}$/.test(r.session) ? r.session : '00000000',
    project: str(r.project, 80) ?? '', event: r.event, ...(tool ? { tool } : {}), ...(file ? { file: redact(file) } : {}), ...(typeof r.ok === 'boolean' ? { ok: r.ok } : {}),
  };
}

// Reads records with since < at <= until. Duplicates (same agent and file, same event or an edit report, within 2 s) collapse,
// e.g. OpenCode's file.edited and tool.execute.after reporting the same edit.
export async function readInbox(directory, since, until) {
  const out = [];
  for (const file of Object.values(INBOX_FILES)) {
    let text = '';
    try { text = await readFile(join(directory, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(-MAX_LINES)) {
      const record = line.trim() && parseRecord(line);
      if (!record) continue;
      const t = Date.parse(record.at);
      if (t > Date.parse(since) && t <= Date.parse(until)) out.push(record);
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  const deduped = [];
  for (const r of out) {
    const dup = deduped.findLast(d => d.agent === r.agent && (d.file ?? '') === (r.file ?? '') && Math.abs(Date.parse(r.at) - Date.parse(d.at)) <= 2000 && (d.event === r.event || (r.file && (d.event === 'file_edit' || r.event === 'file_edit'))));
    if (dup) { if (r.event === 'tool') Object.assign(dup, { event: 'tool', tool: r.tool, ok: r.ok }); continue; }
    deduped.push(r);
  }
  return deduped;
}

// Drops consumed and stale lines (anything at or before `until`), keeping only newer ones.
export async function pruneInbox(directory, until) {
  for (const file of Object.values(INBOX_FILES)) {
    const path = join(directory, file);
    let text;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    const keep = text.split('\n').filter(line => { const r = line.trim() && parseRecord(line); return r && Date.parse(r.at) > Date.parse(until); });
    if (!keep.length) { await rm(path, { force: true }); continue; }
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${keep.join('\n')}\n`);
    await rename(temp, path);
  }
}

export async function clearInbox(directory) {
  for (const file of Object.values(INBOX_FILES)) await rm(join(directory, file), { force: true });
}

export async function ensureInbox(directory) { await mkdir(directory, { recursive: true }); }

export function describe(record) {
  const who = AGENT_LABELS[record.agent];
  if (record.event === 'session_start') return `${who} session started`;
  if (record.event === 'turn_end') return `${who} finished a response`;
  if (record.event === 'file_edit') return `${who} edited ${record.file}`;
  return `${who} ran ${record.tool}${record.file ? ` on ${record.file}` : ''}${record.ok === false ? ' (failed)' : ''}`;
}
