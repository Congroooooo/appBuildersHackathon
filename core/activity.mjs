import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

// File activity from ANY app (Explorer, editors, terminals, installers): Windows change notifications on watched
// folders (ReadDirectoryChangesW through fs.watch). Only paths, kinds and sizes are recorded, never contents.
// Raw notifications are ambiguous ("rename" means create, delete or rename), so each one is debounced, checked
// against the disk, and a delete followed quickly by a create in the same folder is reported as a rename.

const IGNORE = [
  /[\\/](node_modules|\.git|\.svn|\.hg|dist|build|out|\.next|\.nuxt|\.svelte-kit|target|bin|obj|coverage|\.venv|venv|__pycache__|\.cache|\.turbo|\.idea|\.vs|\.vscode-test)([\\/]|$)/i,
  /[\\/](~\$[^\\/]*|\.~lock\.[^\\/]*|[^\\/]*\.(tmp|temp|swp|swo|swx|crdownload|part|partial|lock)|4913|\.DS_Store|desktop\.ini|Thumbs\.db)$/i,
  /[\\/]AppData[\\/](Local|LocalLow)[\\/]/i,
];
const SETTLE_MS = 400;
const RENAME_WINDOW_MS = 1200;

export class FileActivityWatcher extends EventEmitter {
  constructor({ shouldIgnore = () => false } = {}) {
    super();
    this.shouldIgnore = shouldIgnore;
    this.watchers = new Map();      // root -> FSWatcher
    this.pending = new Map();       // path -> timer
    this.known = new Map();         // path -> { isDir, size }
    this.recentDeletes = [];        // { path, isDir, at, timer }
    this.recentCreates = [];        // { path, isDir, size, created, timer }
  }

  watching(path) {
    const key = path.toLowerCase();
    return [...this.watchers.keys()].some(root => key === root || key.startsWith(`${root}${sep}`.toLowerCase()) && this.watchers.get(root).recursive);
  }

  // recursive: whole tree (project folders); otherwise only direct children (a folder open in Explorer).
  add(root, { recursive = true } = {}) {
    const key = root.toLowerCase();
    if (this.watchers.has(key) || this.watching(root)) return false;
    try {
      const w = watch(root, { recursive, persistent: false }, (type, name) => { if (name) this.#queue(join(root, name.toString())); });
      w.on('error', () => { this.watchers.delete(key); try { w.close(); } catch { /* already closed */ } });
      w.recursive = recursive;
      this.watchers.set(key, w);
      return true;
    } catch { return false; }
  }

  roots() { return [...this.watchers.keys()]; }

  close() {
    for (const w of this.watchers.values()) { try { w.close(); } catch { /* already closed */ } }
    this.watchers.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    for (const d of [...this.recentDeletes, ...this.recentCreates]) clearTimeout(d.timer);
    this.recentDeletes = []; this.recentCreates = [];
    this.known.clear();
  }

  #queue(path) {
    if (IGNORE.some(re => re.test(path)) || this.shouldIgnore(path)) return;
    clearTimeout(this.pending.get(path));
    this.pending.set(path, setTimeout(() => { this.pending.delete(path); void this.#settle(path); }, SETTLE_MS));
  }

  async #settle(path) {
    const info = await stat(path).catch(() => null);
    const before = this.known.get(path);
    if (!info) {
      if (!before && !this.#parentKnown(path)) {
        // Unknown before and gone now: a transient file; still report a delete only if it looked real.
        if (!/\.[\w-]{1,8}$/.test(path)) return;
      }
      this.known.delete(path);
      const entry = { path, isDir: before?.isDir ?? !/\.[\w-]{1,8}$/.test(basename(path)), at: Date.now() };
      // The new name may have been reported first (Windows does not guarantee order): pair with it.
      // A file created moments ago and now gone (e.g. created then renamed): report the creation first.
      const same = this.recentCreates.find(c => c.path.toLowerCase() === path.toLowerCase());
      if (same) {
        clearTimeout(same.timer);
        this.recentCreates = this.recentCreates.filter(c => c !== same);
        this.#emit(same.created ? 'created' : 'modified', same.path, same.isDir, same.size);
      }
      const appeared = this.recentCreates.find(c => c.isDir === entry.isDir && dirname(c.path).toLowerCase() === dirname(path).toLowerCase());
      if (appeared) {
        clearTimeout(appeared.timer);
        this.recentCreates = this.recentCreates.filter(c => c !== appeared);
        this.#emit('renamed', appeared.path, appeared.isDir, appeared.size, path);
        return;
      }
      entry.timer = setTimeout(() => {
        this.recentDeletes = this.recentDeletes.filter(d => d !== entry);
        this.#emit('deleted', entry.path, entry.isDir, null);
      }, RENAME_WINDOW_MS);
      this.recentDeletes.push(entry);
      return;
    }
    const isDir = info.isDirectory();
    this.known.set(path, { isDir, size: info.size });
    if (before) { if (!isDir) this.#emit('modified', path, false, info.size); return; } // folder "changes" are child noise
    // New path: a rename if something with the same kind just disappeared from the same folder.
    const match = this.recentDeletes.find(d => d.isDir === isDir && dirname(d.path).toLowerCase() === dirname(path).toLowerCase());
    if (match) {
      clearTimeout(match.timer);
      this.recentDeletes = this.recentDeletes.filter(d => d !== match);
      this.#emit('renamed', path, isDir, isDir ? null : info.size, match.path);
      return;
    }
    // Otherwise wait briefly for the old name's notification; if none arrives it is a creation (recent birth
    // time or a folder) or an in-place save of a file we had not seen yet.
    const entry = { path, isDir, size: isDir ? null : info.size, created: Date.now() - info.birthtimeMs < 5000 || isDir };
    entry.timer = setTimeout(() => {
      this.recentCreates = this.recentCreates.filter(c => c !== entry);
      this.#emit(entry.created ? 'created' : 'modified', path, isDir, entry.size);
    }, RENAME_WINDOW_MS);
    this.recentCreates.push(entry);
  }

  #parentKnown(path) { return this.known.has(dirname(path)); }

  #emit(op, path, isDir, size, from = null) {
    this.emit('op', { op, path, isDir, size, from, at: new Date().toISOString() });
  }
}

// Folders worth watching recursively: never a drive root, the user profile itself, or system folders.
export function watchableRoot(path, profile = process.env.USERPROFILE ?? '') {
  const p = path.replace(/[\\/]+$/, '');
  if (/^[a-z]:$/i.test(p)) return false;
  if (profile && p.toLowerCase() === profile.replace(/[\\/]+$/, '').toLowerCase()) return false;
  return !/^[a-z]:\\(windows|program files( \(x86\))?|programdata)(\\|$)/i.test(p);
}
