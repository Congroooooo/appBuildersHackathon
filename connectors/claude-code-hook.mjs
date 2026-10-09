#!/usr/bin/env node
// Continuum connector for Claude Code hooks (SessionStart, PostToolUse, Stop).
// Reads the hook payload from stdin and appends ONE minimized line to Continuum's local inbox file.
// Never records prompts, assistant text, shell commands, tool output or file contents. No network.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative } from 'node:path';

const inbox = process.env.CONTINUUM_INBOX || join(process.env.APPDATA || join(process.env.HOME || '.', '.config'), 'Continuum', 'inbox');
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read']);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) process.exit(0); });
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw);
    const cwd = typeof p.cwd === 'string' ? p.cwd : '';
    const record = { v: 1, agent: 'claude_code', at: new Date().toISOString(), session: createHash('sha256').update(String(p.session_id ?? '')).digest('hex').slice(0, 8), project: basename(cwd).slice(0, 80) };
    if (p.hook_event_name === 'SessionStart') record.event = 'session_start';
    else if (p.hook_event_name === 'Stop') record.event = 'turn_end';
    else if (p.hook_event_name === 'PostToolUse') {
      record.event = 'tool';
      record.tool = String(p.tool_name ?? '').slice(0, 40);
      const file = p.tool_input?.file_path ?? p.tool_input?.notebook_path;
      if (FILE_TOOLS.has(record.tool) && typeof file === 'string') record.file = (isAbsolute(file) ? (cwd ? relative(cwd, file) : basename(file)) : file).replace(/\\/g, '/').slice(0, 200);
      const response = p.tool_response;
      record.ok = !(response && typeof response === 'object' && (response.is_error === true || response.success === false || response.interrupted === true));
    } else process.exit(0);
    mkdirSync(inbox, { recursive: true });
    appendFileSync(join(inbox, 'claude-code.jsonl'), `${JSON.stringify(record)}\n`);
  } catch { /* never block the agent */ }
  process.exit(0);
});
