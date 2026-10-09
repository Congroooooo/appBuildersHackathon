import { execFile } from 'node:child_process';
import { readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { redactCode } from './privacy.mjs';

// Browser page context: the Continuum extension (extension/) sends page title, headings, description, a short
// main-text excerpt and highlighted text through Chrome/Edge native messaging to connectors/page-host.mjs, which
// appends lines to inbox/browser.jsonl. Lines are untrusted input: validated, bounded and redacted here.
export const HOST_NAME = 'com.continuum.page_context';
export const BROWSER_FILE = 'browser.jsonl';
const REGISTRY = ['HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts', 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts', 'HKCU\\Software\\Chromium\\NativeMessagingHosts'];

const str = (value, max) => typeof value === 'string' ? redactCode(value.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, max) : undefined;

export function parsePage(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || r.v !== 1 || !['page', 'selection'].includes(r.kind) || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) return null;
  const at = Date.parse(r.at);
  if (!Number.isFinite(at)) return null;
  return {
    kind: r.kind, at: new Date(at).toISOString(), url: r.url.slice(0, 2048), title: str(r.title, 200) ?? '',
    ...(r.description ? { description: str(r.description, 300) } : {}),
    ...(Array.isArray(r.headings) ? { headings: r.headings.map(h => str(h, 120)).filter(Boolean).slice(0, 8) } : {}),
    ...(r.excerpt ? { excerpt: str(r.excerpt, 1500) } : {}),
    ...(r.selection ? { selection: str(r.selection, 500) } : {}),
  };
}

export async function readPages(inboxDir, since, until) {
  let text = '';
  try { text = await readFile(join(inboxDir, BROWSER_FILE), 'utf8'); } catch { return []; }
  return text.split('\n').slice(-2000).map(l => l.trim() && parsePage(l)).filter(r => r && Date.parse(r.at) > Date.parse(since) && Date.parse(r.at) <= Date.parse(until));
}

// The page helper writes only while this flag exists (a session is recording with page context on), so pages
// browsed between sessions never reach disk.
export const RECORDING_FLAG = 'browser-recording.flag';
export async function setRecordingFlag(inboxDir, on) {
  const path = join(inboxDir, RECORDING_FLAG);
  try { if (on) { await mkdir(inboxDir, { recursive: true }); await writeFile(path, new Date().toISOString()); } else await rm(path, { force: true }); } catch { /* best effort */ }
}

export async function prunePages(inboxDir, until) {
  const path = join(inboxDir, BROWSER_FILE);
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return; }
  const keep = text.split('\n').filter(l => { const r = l.trim() && parsePage(l); return r && Date.parse(r.at) > Date.parse(until); });
  if (!keep.length) { await rm(path, { force: true }); return; }
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${keep.join('\n')}\n`);
  await rename(temp, path);
}

const reg = args => new Promise(resolve => execFile('reg', args, { windowsHide: true }, error => resolve(!error)));

// Registers the native-messaging helper for Chrome, Edge and Brave (per user, HKCU). `runner` is the command that
// runs a Node script: "node" in development, or the Continuum executable with ELECTRON_RUN_AS_NODE when packaged.
export async function installHelper({ dataDir, connectorsDir, extensionId, runner, electronAsNode = false }) {
  const dir = join(dataDir, 'browser-helper');
  await mkdir(dir, { recursive: true });
  const cmd = join(dir, 'page-host.cmd');
  await writeFile(cmd, ['@echo off', `set "CONTINUUM_INBOX=${join(dataDir, 'inbox')}"`, ...(electronAsNode ? ['set ELECTRON_RUN_AS_NODE=1'] : []), `"${runner}" "${join(connectorsDir, 'page-host.mjs')}" %*`, ''].join('\r\n'));
  const manifest = join(dir, `${HOST_NAME}.json`);
  await writeFile(manifest, JSON.stringify({ name: HOST_NAME, description: 'Continuum page context (local only)', path: cmd, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2));
  const results = await Promise.all(REGISTRY.map(key => reg(['add', `${key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'])));
  if (!results.some(Boolean)) throw new Error('Could not register the browser helper.');
  return { manifest, registered: REGISTRY.filter((_, i) => results[i]).map(k => k.split('\\')[2]) };
}

export async function uninstallHelper(dataDir) {
  await Promise.all(REGISTRY.map(key => reg(['delete', `${key}\\${HOST_NAME}`, '/f'])));
  await rm(join(dataDir, 'browser-helper'), { recursive: true, force: true });
}

export async function helperInstalled() {
  return (await Promise.all(REGISTRY.map(key => reg(['query', `${key}\\${HOST_NAME}`, '/ve'])))).some(Boolean);
}
