import { app, BrowserWindow, ipcMain, safeStorage, session, Tray, Menu, nativeImage, nativeTheme, dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FieldCipher, loadKey } from '../core/crypto.mjs';
import { Repository } from '../core/db.mjs';
import { CaptureController, WindowsForegroundSource, FeedSource } from '../core/capture.mjs';
import { OllamaProvider, startRuntime, ping } from '../core/ollama.mjs';
import { ContinuumService } from '../core/service.mjs';
import { listDeviceApps } from '../core/device.mjs';
import { installHelper, uninstallHelper, helperInstalled } from '../core/browser.mjs';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT } from '../core/summarize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(here, '../dist/index.html')).href;

app.setName('Continuum');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
if (process.env.CONTINUUM_TEST_DIR) app.setPath('userData', process.env.CONTINUUM_TEST_DIR);
// A second launch only focuses the existing window; it must never open the database or start capture.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let window, tray, service, repo, capture, runtime, loadError = null, runtimeError = null, runtimeStarting = null, quitting = false;

const SERVICE_METHODS = new Set(['setObserve', 'setAutoTrack', 'addProjectFolder', 'removeProjectFolder', 'setIncludeDiffs', 'setAgentsEnabled', 'addGitRepo', 'removeGitRepo', 'setGitEnabled', 'completeOnboarding', 'setConsent', 'setCaptureScopes', 'updateExclusions', 'setModel', 'startSession', 'pauseSession', 'resumeSession', 'endSession',
  'addNote', 'deleteNote', 'hideEvent', 'renameSession', 'summarize', 'cancel', 'editSummary', 'search', 'deleteSession', 'sessionDetail']);

// A reused runtime (started by another process) can disappear; an owned one can crash. Either way, start a new one.
async function ensureRuntime() {
  if (runtime && (runtime.owned ? runtime.child.exitCode === null : await ping())) return;
  runtime = null;
  runtimeStarting ??= startRuntime().then(r => { runtime = r; runtimeError = null; }).catch(e => { runtimeError = e.message; }).finally(() => { runtimeStarting = null; });
  await runtimeStarting;
}

async function prepareModels() {
  await ensureRuntime();
  if (runtimeError || !service) return;
  try {
    const health = await service.health();
    if (health.ready) await new OllamaProvider().warm(repo.settings().generationModel, SYSTEM_PROMPT);
  } catch { /* readiness is reported through health */ }
}

function snapshot() {
  if (!service) return { loadError: loadError ?? 'Starting…' };
  return { ...service.snapshot(), runtimeError, loadError: null, runtimeOwned: runtime?.owned ?? null, dataPath: app.getPath('userData'), connectorsDir: join(here, '..', 'connectors').replace('app.asar', 'app.asar.unpacked') };
}

let pending = null;
function pushSnapshot() {
  if (pending || quitting) return;
  pending = setTimeout(() => {
    pending = null;
    if (quitting) return;
    if (window && !window.isDestroyed()) window.webContents.send('continuum:snapshot', snapshot());
    updateIndicators();
  }, 120);
}

// Small solid-circle tray icon drawn from raw BGRA pixels so no image asset is needed.
function dot([r, g, b], hollow = false) {
  const size = 16, buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), i = (y * size + x) * 4;
    const inside = hollow ? d <= 7 && d >= 4.5 : d <= 7;
    if (inside) { buffer[i] = b; buffer[i + 1] = g; buffer[i + 2] = r; buffer[i + 3] = 255; }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function captureLabel() {
  if (!service) return 'Starting';
  const active = repo.activeSession();
  if (!active) return 'Not recording';
  if (active.status === 'paused') return 'Paused';
  if (capture.state === 'recording') return 'Recording';
  if (capture.state === 'away') return 'Recording (away)';
  if (capture.state === 'unavailable') return 'Notes only';
  return repo.settings().captureConsented ? 'Starting capture' : 'Notes only';
}

function updateIndicators() {
  if (quitting) return;
  const label = captureLabel();
  if (window && !window.isDestroyed()) window.setTitle(`Continuum — ${label}`);
  if (!tray) return;
  const recording = label.startsWith('Recording');
  tray.setImage(recording ? dot([196, 64, 52]) : dot([120, 120, 120], true));
  tray.setToolTip(`Continuum — ${label}`);
  const active = service && repo.activeSession();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Continuum — ${label}`, enabled: false },
    { type: 'separator' },
    ...(active ? [active.status === 'active'
      ? { label: 'Pause capture', click: () => { service.pauseSession(); } }
      : { label: 'Resume capture', click: () => { service.resumeSession(); } }] : []),
    { label: 'Open Continuum', click: () => { window?.show(); window?.focus(); } },
  ]));
}

ipcMain.handle('continuum:call', async (event, method, payload) => {
  if (quitting) return { ok: false, error: 'Continuum is closing.' };
  if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pageUrl) return { ok: false, error: 'Untrusted application frame.' };
  try {
    if (typeof method !== 'string') throw new Error('Unknown operation.');
    if (JSON.stringify(payload ?? {}).length > 20000) throw new Error('Request is too large.');
    if (method === 'snapshot') return { ok: true, value: snapshot() };
    if (method === 'setTheme') {
      // Appearance only: window frame, native controls and prefers-color-scheme follow the user's choice.
      nativeTheme.themeSource = ['light', 'dark'].includes(payload?.theme) ? payload.theme : 'system';
      window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#08090a' : '#f4f5f6');
      return { ok: true, value: nativeTheme.themeSource };
    }
    if (!service) throw new Error(loadError ?? 'Continuum is still starting.');
    if (method === 'health') { await ensureRuntime(); if (runtimeError) throw new Error(runtimeError); return { ok: true, value: await service.health() }; }
    if (method === 'warm') { await ensureRuntime(); if (runtimeError) throw new Error(runtimeError); await new OllamaProvider().warm(repo.settings().generationModel, SYSTEM_PROMPT); return { ok: true, value: true }; }
    if (method === 'clearAll') { service.clearAll(); return { ok: true, value: true }; }
    if (method === 'browserHelper') {
      // One-click registration of the native-messaging helper used by the Continuum browser extension.
      const appDir = join(here, '..').replace('app.asar', 'app.asar.unpacked');
      if (payload?.action === 'install') {
        const extensionId = readFileSync(join(appDir, 'extension', 'extension-id.txt'), 'utf8').trim();
        const result = await installHelper({ dataDir: app.getPath('userData'), connectorsDir: join(appDir, 'connectors'), extensionId, runner: app.isPackaged ? process.execPath : 'node', electronAsNode: app.isPackaged });
        return { ok: true, value: { installed: true, ...result } };
      }
      if (payload?.action === 'uninstall') { await uninstallHelper(app.getPath('userData')); return { ok: true, value: { installed: false } }; }
      return { ok: true, value: { installed: await helperInstalled(), extensionDir: join(appDir, 'extension') } };
    }
    if (method === 'deviceApps') return { ok: true, value: await listDeviceApps(repo.seenApps()) };
    if (method === 'pickFolder') {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: payload?.purpose === 'repo' ? 'Choose a Git repository' : payload?.purpose === 'project' ? 'Choose a project folder' : 'Choose a folder to exclude', properties: ['openDirectory'] });
      return { ok: true, value: canceled ? null : filePaths[0] ?? null };
    }
    if (method === 'export') {
      const { canceled, filePath } = await dialog.showSaveDialog(window, { title: 'Export Continuum data', defaultPath: `continuum-export-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (canceled || !filePath) return { ok: true, value: null };
      await writeFile(filePath, JSON.stringify(service.exportData(), null, 2));
      return { ok: true, value: filePath };
    }
    if (!SERVICE_METHODS.has(method)) throw new Error('Unknown operation.');
    if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) throw new Error('Invalid request.');
    if (['summarize', 'endSession', 'search', 'editSummary'].includes(method)) await ensureRuntime();
    const value = method === 'sessionDetail' ? service.sessionDetail(payload?.id) : await service[method](payload ?? {});
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error.name === 'TypeError' && !/must|cannot/.test(error.message) ? 'Invalid input. Review the fields and try again.' : error.message };
  } finally { if (!quitting) pushSnapshot(); }
});

if (primary) app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The renderer may load only packaged files. Every other request (http, https, ws) is canceled.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://') }));

  try {
    const protection = {
      wrap: async value => { if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('OS encryption is unavailable, so Continuum will not store data.'); return safeStorage.encryptStringAsync(value); },
      // Electron 44 resolves { result, shouldReEncrypt } rather than a plain string.
      unwrap: async value => { const out = await safeStorage.decryptStringAsync(value); return typeof out === 'string' ? out : { value: out.result, rewrap: !!out.shouldReEncrypt }; },
    };
    const directory = app.getPath('userData');
    const cipher = new FieldCipher(await loadKey(directory, protection));
    repo = new Repository(join(directory, 'continuum.db'), cipher, ContinuumService.defaults());
    const feed = process.env.CONTINUUM_CAPTURE_FEED;
    capture = new CaptureController({
      createSource: () => { const s = repo.settings(); return feed ? FeedSource.fromFile(feed) : new WindowsForegroundSource({ paths: s.capturePaths, urls: s.captureUrls }); },
      getSettings: () => repo.settings(), selfPids: [process.pid], selfApps: ['continuum'],
      ...(process.env.CONTINUUM_IDLE_MS ? { idleMs: Number(process.env.CONTINUUM_IDLE_MS) } : {}), // tests on an unattended machine
      // Exact native handles of Continuum's own windows: never recorded, however the process tree looks.
      selfWindows: () => BrowserWindow.getAllWindows().map(w => { const h = w.getNativeWindowHandle(); return Number(h.length >= 8 ? h.readBigUInt64LE(0) : h.readUInt32LE(0)); }),
    });
    service = new ContinuumService({ repo, capture, provider: new OllamaProvider(), inboxDir: join(directory, 'inbox'), shadowRoot: join(directory, 'snapshots'), dataDir: directory, ...(process.env.CONTINUUM_LIVE_PROBE_MS ? { liveProbeMs: Number(process.env.CONTINUUM_LIVE_PROBE_MS) } : {}) });
    service.on('changed', pushSnapshot);
    service.on('progress', stage => { if (window && !window.isDestroyed()) window.webContents.send('continuum:progress', stage); });
  } catch (error) { loadError = `Continuum could not open its encrypted store: ${error.message}`; }

  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 380, minHeight: 600, backgroundColor: nativeTheme.shouldUseDarkColors ? '#08090a' : '#f4f5f6', title: 'Continuum', autoHideMenuBar: true, show: true,
    webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  try { tray = new Tray(dot([120, 120, 120], true)); tray.on('click', () => { window?.show(); window?.focus(); }); } catch { tray = null; }
  updateIndicators();
  await window.loadURL(pageUrl);
  void prepareModels().then(pushSnapshot);
}).catch(() => app.quit());

app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  // Flush the open activity segment first, then stop all UI refreshes before closing the database.
  try { service?.cancel(); capture?.stop(); } catch { /* best effort flush */ }
  quitting = true;
  clearTimeout(pending); pending = null;
  service?.removeAllListeners(); capture?.removeAllListeners();
  try { repo?.close(); } catch { /* already closed */ }
  runtime?.stop();
});

