// Continuum connector for OpenCode (plugin API verified against @opencode-ai/plugin 1.14.x).
// Appends minimized lines to Continuum's local inbox file: session start/idle, file edits, tool name + success.
// Never records prompts, assistant text, shell commands, tool output or file contents. No network.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative } from 'node:path';

const inbox = process.env.CONTINUUM_INBOX || join(process.env.APPDATA || join(process.env.HOME || '.', '.config'), 'Continuum', 'inbox');
const FILE_TOOLS = new Set(['edit', 'write', 'patch', 'multiedit', 'read']);

export const ContinuumPlugin = async ({ directory }) => {
  const project = basename(String(directory ?? '')).slice(0, 80);
  const write = (sessionID, fields) => {
    try {
      const record = { v: 1, agent: 'opencode', at: new Date().toISOString(), session: createHash('sha256').update(String(sessionID ?? '')).digest('hex').slice(0, 8), project, ...fields };
      mkdirSync(inbox, { recursive: true });
      appendFileSync(join(inbox, 'opencode.jsonl'), `${JSON.stringify(record)}\n`);
    } catch { /* never block the agent */ }
  };
  const rel = file => (isAbsolute(file) && directory ? relative(directory, file) : file).replace(/\\/g, '/').slice(0, 200);
  return {
    event: async ({ event }) => {
      if (event?.type === 'session.created') write(event.properties?.info?.id, { event: 'session_start' });
      else if (event?.type === 'session.idle') write(event.properties?.sessionID, { event: 'turn_end' });
      else if (event?.type === 'file.edited' && typeof event.properties?.file === 'string') write('', { event: 'file_edit', file: rel(event.properties.file) });
    },
    'tool.execute.after': async (input, output) => {
      const tool = String(input?.tool ?? '').slice(0, 40);
      const file = input?.args?.filePath ?? input?.args?.file_path;
      const failed = output?.metadata?.error || /^error/i.test(String(output?.title ?? ''));
      write(input?.sessionID, { event: 'tool', tool, ...(FILE_TOOLS.has(tool.toLowerCase()) && typeof file === 'string' ? { file: rel(file) } : {}), ok: !failed });
    },
  };
};
