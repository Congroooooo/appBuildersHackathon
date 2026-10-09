import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves editor project names (the folder shown in a VS Code-family title, e.g. "company-website") to real
// folder paths, using the editors' own recent-folder lists. Only folder URIs are read from these files.
const STORAGE = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'].map(app => join(process.env.APPDATA ?? '', app, 'User', 'globalStorage', 'storage.json'));

function folderUris(json) {
  const open = [], recent = [];
  const add = (list, uri) => { if (typeof uri === 'string' && uri.startsWith('file:///')) list.push(uri); };
  const ws = json.windowsState ?? {};
  add(open, ws.lastActiveWindow?.folder);
  for (const w of ws.openedWindows ?? []) add(open, w.folder);
  for (const f of json.backupWorkspaces?.folders ?? []) add(recent, f.folderUri);
  for (const key of Object.keys(json.profileAssociations?.workspaces ?? {})) add(recent, key);
  return { open, recent };
}

// Returns { byName: Map<lowercase folder name, path>, open: string[] } with existing directories only.
export async function editorFolders(files = STORAGE) {
  const byName = new Map(), open = new Set();
  for (const file of files) {
    let json;
    try { json = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    const { open: openUris, recent } = folderUris(json);
    for (const [uri, isOpen] of [...openUris.map(u => [u, true]), ...recent.map(u => [u, false])]) {
      let path;
      try { path = fileURLToPath(uri); } catch { continue; }
      const info = await stat(path).catch(() => null);
      if (!info?.isDirectory()) continue;
      const name = basename(path).toLowerCase();
      if (!byName.has(name)) byName.set(name, path);
      if (isOpen) open.add(path);
    }
  }
  return { byName, open: [...open] };
}
