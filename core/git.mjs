import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { redactCode } from './privacy.mjs';

// Git connector. Runs only in repositories / folders the user explicitly added, only at session start/end.
// Hardening: no shell; repository config that can execute programs (fsmonitor, hooks, external diff, textconv,
// pagers, credential helpers, filters) is overridden or bypassed; optional locks and prompts are disabled.
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'credential.helper=', '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never'];
const SHADOW = ['-c', 'user.name=Continuum', '-c', 'user.email=continuum@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'gc.auto=0', '-c', 'core.quotepath=false'];
const ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', LC_ALL: 'C' };
export const MAX_FILES = 20;
export const MAX_COMMITS = 10;
export const MAX_DIFF_FILES = 6;
export const MAX_DIFF_LINES = 40;
export const MAX_SNAPSHOT_FILES = 3000;

// Never read for change excerpts: lock files, minified/generated bundles, binaries, env files, keys.
const SKIP_DIFF = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock)$/i, /\.min\.(js|css)$/i, /\.(map|png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|7z|rar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|db|sqlite|pfx|p12|pem|key|crt)$/i, /(^|\/)\.env(\.|$)/i, /(^|\/)(id_rsa|id_ed25519)/i, /(^|\/)\.git-credentials/i];
export const skipDiff = path => SKIP_DIFF.some(re => re.test(path));

// Default excludes for folder snapshots (in addition to the folder's own .gitignore files).
const SNAPSHOT_EXCLUDES = ['node_modules/', '.git/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.svelte-kit/', 'target/', 'bin/', 'obj/', 'coverage/', '.venv/', 'venv/', '__pycache__/', '.cache/', '.turbo/', '.idea/', '.vs/', '*.log', '*.zip', '*.exe', '*.dll', '.env', '.env.*', '*.pem', '*.key'].join('\n');

function run(args, { cwd, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, ...args], { cwd, env: { ...process.env, ...ENV }, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(error.code === 'ENOENT' ? 'Git is not installed or not on PATH.' : (String(stderr).trim().split('\n')[0] || error.message).slice(0, 200)));
      resolve(stdout);
    });
  });
}
const git = (repo, args, options) => run(['-C', repo, ...args], options);

// Validates that a folder is (inside) a Git work tree and returns its top-level path.
export async function resolveRepo(folder) {
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  if (!top) throw new Error('That folder is not a Git repository.');
  return top.replace(/\//g, '\\');
}

async function head(repo) {
  try { return (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null; } catch { return null; }
}

function parseStatus(raw) {
  const files = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // rename/copy: next field is the original path
    files.push({ path, status: code.trim() === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('R') ? 'renamed' : 'modified' });
  }
  return files;
}

function parseNumstat(raw) {
  const files = new Map();
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const [added, deleted, path] = field.split('\t');
    let file = path, status = 'modified';
    if (path === '') { i++; file = fields[++i]; status = 'renamed'; } // rename: "a\td\t" then old path, new path
    if (file) files.set(file, { path: file, added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted), status });
  }
  return files;
}

// Bounded, redacted excerpt of a unified diff: changed lines plus one line of context, no headers.
export function excerpt(diffText) {
  const lines = [];
  for (const line of diffText.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to)|Binary files|\\ No newline)/.test(line)) continue;
    if (!/^[ +\-@]/.test(line)) continue;
    lines.push(line.startsWith('@@') ? '…' : redactCode(line.length > 200 ? `${line.slice(0, 199)}…` : line));
    if (lines.length >= MAX_DIFF_LINES) { lines.push('… (truncated)'); break; }
  }
  while (lines[0] === '…') lines.shift();
  return lines.join('\n');
}

// Deterministic one-line description of an excerpt, e.g. "REDIRECT_URI: 3000 → 5173" or "added: <h2>Team</h2>".
// Pairs each removed line with the added line that replaced it and keeps only the part that differs.
const short = (value, max = 60) => { const v = value.trim(); return v.length > max ? `${v.slice(0, max - 1)}…` : v; };
export function changeSummary(diff) {
  if (!diff) return null;
  const phrases = [];
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length && phrases.length < 3; i++) {
    if (!/^[-+]/.test(lines[i])) continue;
    const removed = [], added = [];
    while (i < lines.length && lines[i].startsWith('-')) removed.push(lines[i++].slice(1));
    while (i < lines.length && lines[i].startsWith('+')) added.push(lines[i++].slice(1));
    i--;
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs && phrases.length < 3; k++) {
      const a = removed[k].split(/(\W)/).filter(Boolean), b = added[k].split(/(\W)/).filter(Boolean);
      let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
      let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
      const from = a.slice(start, a.length - end).join(''), to = b.slice(start, b.length - end).join('');
      if (!from.trim() && !to.trim()) continue;
      const name = a.slice(0, start).join('').match(/([A-Za-z_$][\w$.-]*)\s*[:=]\s*["'`]?[^"'`]*$/)?.[1];
      phrases.push(`${name && name.length < 40 ? `${name}: ` : ''}${short(from, 40) || '∅'} → ${short(to, 50) || '∅'}`);
    }
    for (const line of added.slice(pairs)) if (line.trim() && phrases.length < 3) phrases.push(`added: ${short(line)}`);
    for (const line of removed.slice(pairs)) if (line.trim() && phrases.length < 3) phrases.push(`removed: ${short(line)}`);
  }
  return phrases.length ? phrases.join('; ') : null;
}

function newFileExcerpt(fullPath) {
  try {
    if (statSync(fullPath).size > 200_000) return null;
    const text = readFileSync(fullPath, 'utf8');
    if (text.includes('\0')) return null;
    return excerpt(text.split('\n').slice(0, MAX_DIFF_LINES).map(l => `+${l}`).join('\n'));
  } catch { return null; }
}

// Point-in-time snapshot: branch, HEAD and dirty files (paths only, no content).
export async function snapshot(repo) {
  const [branch, sha, status] = await Promise.all([
    git(repo, ['branch', '--show-current']).then(s => s.trim() || null).catch(() => null),
    head(repo),
    git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ]);
  const dirty = parseStatus(status).slice(0, 200);
  return { repo, name: basename(repo), branch, head: sha, dirty, fingerprints: await fingerprints(repo, dirty.map(f => f.path)), takenAt: new Date().toISOString() };
}

// Content hashes (never contents) of already-modified files, so edits made before a session are not credited to
// it. --no-filters keeps repository clean/smudge filters (which could run programs) out of the way.
async function fingerprints(repo, paths) {
  const existing = paths.filter(p => existsSync(join(repo, p))).slice(0, 200);
  if (!existing.length) return {};
  try {
    const hashes = (await git(repo, ['hash-object', '--no-filters', '--', ...existing])).trim().split('\n');
    return Object.fromEntries(existing.map((p, i) => [p, hashes[i] ?? null]));
  } catch { return {}; }
}

const rank = files => [...files.values()].sort((a, b) => ((b.added ?? 0) + (b.deleted ?? 0)) - ((a.added ?? 0) + (a.deleted ?? 0)));

// What changed in a connected repository since the start snapshot: commits, per-file line counts and, only when
// `diffs` is allowed, bounded redacted excerpts of the changed lines.
export async function changesSince(start, { diffs = false } = {}) {
  const end = await snapshot(start.repo);
  const commits = [];
  if (start.head && end.head && start.head !== end.head) {
    const log = await git(start.repo, ['log', '--no-color', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%s', `${start.head}..${end.head}`]).catch(() => '');
    for (const line of log.split('\n').filter(Boolean)) { const [sha, ...rest] = line.split('\t'); commits.push({ sha, subject: rest.join('\t').slice(0, 160) }); }
  }
  const files = start.head ? parseNumstat(await git(start.repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', '-z', start.head]).catch(() => '')) : new Map();
  for (const f of end.dirty) {
    if (f.status === 'untracked') files.set(f.path, { path: f.path, added: null, deleted: null, status: 'untracked' });
    else if (files.has(f.path) && files.get(f.path).status !== 'renamed') files.get(f.path).status = f.status;
  }
  // Files that were already modified (or untracked) when the session started count only if they changed since.
  const before = start.fingerprints ?? {};
  const touched = [...files.keys()].filter(p => p in before);
  if (touched.length) {
    const now = await fingerprints(start.repo, touched);
    for (const p of touched) if (before[p] && now[p] === before[p]) files.delete(p);
  }
  const ranked = rank(files).slice(0, MAX_FILES);
  if (diffs) {
    for (const f of ranked.filter(f => !skipDiff(f.path)).slice(0, MAX_DIFF_FILES)) {
      if (f.status === 'untracked') f.diff = newFileExcerpt(join(start.repo, f.path));
      else if (start.head) f.diff = excerpt(await git(start.repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U1', start.head, '--', f.path]).catch(() => '')) || null;
      f.what = changeSummary(f.diff);
    }
  }
  return { repo: start.repo, name: end.name, branch: end.branch, startHead: start.head, endHead: end.head, commits, files: ranked, totalFiles: files.size, takenAt: end.takenAt };
}

// Folder snapshots for project folders that are not Git repositories. A private repository is created inside
// Continuum's data folder (--git-dir) with the user's folder as work tree; nothing is written to the user's folder.
// The private repository is deleted after the end-of-session comparison.
export function shadowDir(root, folder) {
  return join(root, `${createHash('sha1').update(folder.toLowerCase()).digest('hex').slice(0, 12)}.git`);
}

function shadowGit(dir, folder, args, options) {
  return run(['--git-dir', dir, '--work-tree', folder, ...SHADOW, ...args], options);
}

export async function shadowSnapshot(folder, root) {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error('That folder no longer exists.');
  const dir = shadowDir(root, folder);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await run(['init', '--bare', '-q', dir]);
  await mkdir(join(dir, 'info'), { recursive: true });
  await writeFile(join(dir, 'info', 'exclude'), SNAPSHOT_EXCLUDES);
  const listed = (await shadowGit(dir, folder, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30000 })).split('\0').filter(Boolean);
  if (listed.length > MAX_SNAPSHOT_FILES) { await rm(dir, { recursive: true, force: true }); throw new Error(`Folder has more than ${MAX_SNAPSHOT_FILES} files; choose a smaller project folder.`); }
  await shadowGit(dir, folder, ['add', '-A'], { timeout: 60000 });
  await shadowGit(dir, folder, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'session start'], { timeout: 30000 });
  const sha = (await shadowGit(dir, folder, ['rev-parse', 'HEAD'])).trim();
  return { shadow: true, repo: folder, name: basename(folder), branch: null, head: sha, dir, takenAt: new Date().toISOString() };
}

export async function shadowChanges(start, { diffs = false, keep = false } = {}) {
  try {
    const { dir, repo: folder } = start;
    await shadowGit(dir, folder, ['add', '-A'], { timeout: 60000 });
    await shadowGit(dir, folder, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'session end'], { timeout: 30000 });
    const end = (await shadowGit(dir, folder, ['rev-parse', 'HEAD'])).trim();
    const files = parseNumstat(await shadowGit(dir, folder, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', '-z', start.head, end]));
    const statuses = (await shadowGit(dir, folder, ['diff', '--no-color', '--name-status', '-z', start.head, end])).split('\0');
    for (let i = 0; i < statuses.length - 1; i++) {
      const code = statuses[i];
      if (!/^[AMDRC]\d*$/.test(code)) continue;
      const path = code.startsWith('R') || code.startsWith('C') ? statuses[i += 2] : statuses[++i];
      if (files.has(path)) files.get(path).status = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? 'renamed' : 'modified';
    }
    const ranked = rank(files).slice(0, MAX_FILES);
    if (diffs) for (const f of ranked.filter(f => !skipDiff(f.path)).slice(0, MAX_DIFF_FILES)) {
      f.diff = excerpt(await shadowGit(dir, folder, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U1', start.head, end, '--', f.path]).catch(() => '')) || null;
      f.what = changeSummary(f.diff);
    }
    return { shadow: true, repo: folder, name: start.name, branch: null, startHead: null, endHead: null, commits: [], files: ranked, totalFiles: files.size, takenAt: new Date().toISOString() };
  } finally {
    if (!keep) await rm(start.dir, { recursive: true, force: true }).catch(() => {});
  }
}
