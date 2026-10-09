import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactCode } from './privacy.mjs';

// Terminal commands from shells that keep a history file, read only while a session records:
//  - PowerShell (Windows PowerShell and pwsh, in any host: Windows Terminal, VS Code, conhost) via PSReadLine,
//    which appends every command the moment it runs;
//  - Git Bash / WSL bash when PROMPT_COMMAND appends history (shown as a setup snippet).
// cmd.exe keeps no history file; capturing it would require injecting into its process, which Continuum does not do.
// Only commands typed after the session starts are read (byte offsets recorded at start/resume).

// CONTINUUM_HISTORY_DIR points tests at a throwaway history folder instead of the user's real one.
const PSREADLINE = [process.env.CONTINUUM_HISTORY_DIR || join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine')];
const BASH = process.env.CONTINUUM_HISTORY_DIR ? [] : [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.bash_history')];
const MAX_COMMAND = 300;

// Arguments that commonly carry secrets are blanked in addition to the general code redaction.
const COMMAND_SECRETS = [
  [/((?:^|\s)-(?:p|P|pw|-password|-pass|-token|-secret|-api-key|-apikey|-key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/(\s-p)(?=[^\s\d])(\S+)/g, '$1[redacted]'], // mysql-style -pPASSWORD (ports such as -p3000 are kept)
  [/(authorization:\s*(?:bearer|basic|token)?\s*)[^"'\s]+/gi, '$1[redacted]'],
  [/(\b[a-z][\w+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1[redacted]@'],
  [/(\$env:[\w]*(?:token|secret|key|password|pwd)[\w]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/(\b(?:export|set)\s+[\w]*(?:token|secret|key|password|pwd)[\w]*=)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
];
export function redactCommand(command) {
  let out = redactCode(command);
  for (const [re, rep] of COMMAND_SECRETS) out = out.replace(re, rep);
  return out.length > MAX_COMMAND ? `${out.slice(0, MAX_COMMAND - 1)}…` : out;
}

async function sources() {
  const list = [];
  for (const dir of PSREADLINE) {
    for (const name of await readdir(dir).catch(() => [])) if (name.endsWith('_history.txt')) list.push({ file: join(dir, name), shell: name.startsWith('Visual Studio Code') ? 'PowerShell (VS Code)' : 'PowerShell' });
  }
  for (const file of BASH) list.push({ file, shell: 'Bash' });
  return list;
}

export class TerminalHistory {
  constructor({ list = sources } = {}) { this.list = list; this.offsets = new Map(); }

  // Remember current sizes: only commands typed after this point are read.
  async mark() {
    this.offsets.clear();
    for (const s of await this.list()) {
      const info = await stat(s.file).catch(() => null);
      this.offsets.set(s.file, { shell: s.shell, size: info?.size ?? 0 });
    }
  }

  // New commands since the last read, oldest first. PowerShell continuation lines end with a backtick.
  async read() {
    const out = [];
    for (const s of await this.list()) {
      const prev = this.offsets.get(s.file) ?? { shell: s.shell, size: 0 };
      const info = await stat(s.file).catch(() => null);
      if (!info) continue;
      if (info.size < prev.size) { this.offsets.set(s.file, { shell: s.shell, size: info.size }); continue; } // truncated/rotated
      if (info.size === prev.size) continue;
      const buffer = await readFile(s.file);
      const chunk = buffer.subarray(prev.size).toString('utf8');
      this.offsets.set(s.file, { shell: s.shell, size: info.size });
      const lines = chunk.split(/\r?\n/);
      let current = '';
      for (const line of lines) {
        if (!line && !current) continue;
        current = current ? `${current}\n${line}` : line;
        if (s.shell.startsWith('PowerShell') && line.endsWith('`')) continue;
        const command = current.trim(); current = '';
        if (command && !/^#\d+$/.test(command)) out.push({ shell: s.shell, command: redactCommand(command), at: new Date().toISOString() });
      }
    }
    return out;
  }
}

export const BASH_SETUP = 'echo \'PROMPT_COMMAND="history -a; $PROMPT_COMMAND"\' >> ~/.bashrc';
