import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { filterSample, appLabel, normalizeApp } from './privacy.mjs';

export const MIN_DWELL_MS = 3000;      // shorter foreground visits are treated as flicker and dropped
export const IDLE_MS = 180000;         // no input for 3 minutes closes the segment as "away"
export const MAX_SEGMENT_MS = 300000;  // long segments are checkpointed every 5 minutes

// Polls the Windows foreground window once per second using user32 (no admin rights, no accessibility API,
// no screenshots, no window contents). Emits one JSON line when the foreground window changes, plus a
// heartbeat every 5 seconds carrying idle time. Nothing is written to disk by this process.
const WATCHER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class ContinuumForeground {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint IdleMs() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.dwTime; }
}
"@
} catch { [Console]::Out.WriteLine((@{ error = 'Foreground window access is unavailable.' } | ConvertTo-Json -Compress)); exit 2 }
$capturePaths = __CAPTURE_PATHS__; $captureUrls = __CAPTURE_URLS__
$shell = $null
if ($capturePaths) { try { $shell = New-Object -ComObject Shell.Application } catch { $shell = $null } }
if ($captureUrls) { try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes } catch { $captureUrls = $false } }
$browsers = @('chrome', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi', 'arc')
# Folder shown in the File Explorer window (Windows 11 tabs share one HWND, so prefer the tab matching the title).
function Get-ExplorerPath($handle, $title) {
  $best = $null
  foreach ($w in $shell.Windows()) {
    try { if ([int64]$w.HWND -eq $handle.ToInt64()) { $p = $w.Document.Folder.Self.Path; if ($w.LocationName -eq $title) { return $p }; if (-not $best) { $best = $p } } } catch {}
  }
  return $best
}
# Address bar text of the browser window, read through Windows UI Automation (first Edit control).
function Get-BrowserUrl($handle) {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($edit) { return $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
  } catch {}
  return $null
}
$names = @{}; $last = ''; $beat = 0; $path = $null; $url = $null
while ($true) {
  $h = [ContinuumForeground]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][ContinuumForeground]::GetWindowText($h, $sb, 512)
  $procId = [uint32]0; [void][ContinuumForeground]::GetWindowThreadProcessId($h, [ref]$procId)
  if (-not $names.ContainsKey($procId)) { try { $names[$procId] = (Get-Process -Id $procId).ProcessName } catch { $names[$procId] = '' } }
  $title = $sb.ToString()
  $key = "$procId|$title"
  $beat++
  if ($key -ne $last -or $beat -ge 5) {
    if ($key -ne $last) {
      $name = "$($names[$procId])".ToLower()
      $path = if ($shell -and $name -eq 'explorer') { Get-ExplorerPath $h $title } else { $null }
      $url = if ($captureUrls -and $browsers -contains $name) { Get-BrowserUrl $h } else { $null }
    }
    $last = $key; $beat = 0
    [Console]::Out.WriteLine((@{ appId = $names[$procId]; window = $title; pid = $procId; hwnd = $h.ToInt64(); path = $path; url = $url; idleMs = [ContinuumForeground]::IdleMs() } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1000
}
`;

// Real OS source. Emits 'sample' and 'error'.
export class WindowsForegroundSource extends EventEmitter {
  // paths: File Explorer folder; urls: browser address bar. Each is a separate user permission.
  constructor({ paths = false, urls = false } = {}) { super(); this.paths = paths; this.urls = urls; }
  start() {
    const script = WATCHER.replace('__CAPTURE_PATHS__', this.paths ? '$true' : '$false').replace('__CAPTURE_URLS__', this.urls ? '$true' : '$false');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value.error) this.emit('error', new Error(value.error));
          else this.emit('sample', { appId: value.appId, window: value.window, pid: value.pid, hwnd: value.hwnd, path: value.path ?? null, url: value.url ?? null, idleMs: value.idleMs, at: Date.now() });
        } catch { /* ignore malformed line */ }
      }
    });
    this.child.on('error', () => this.emit('error', new Error('Foreground window access is unavailable.')));
    this.child.on('exit', code => { if (!this.stopping) this.emit('error', new Error(`Foreground watcher stopped (${code ?? 'signal'}).`)); });
  }
  stop() {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }
}

// Scripted source for automated tests and rehearsals: [{ appId, window, afterMs, idleMs? }].
export class FeedSource extends EventEmitter {
  constructor(samples) { super(); this.samples = samples; this.timers = []; }
  static fromFile(file) { return new FeedSource(JSON.parse(readFileSync(file, 'utf8'))); }
  start() {
    let delay = 0;
    for (const sample of this.samples) {
      delay += sample.afterMs ?? 1000;
      this.timers.push(setTimeout(() => this.emit('sample', { appId: sample.appId, window: sample.window, path: sample.path ?? null, url: sample.url ?? null, pid: sample.pid ?? 1, idleMs: sample.idleMs ?? 0, at: Date.now() }), delay));
    }
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
}

// Turns raw foreground samples into filtered, coalesced activity segments.
// While stopped (paused/ended/no consent) no source process exists, so nothing can be observed.
export class CaptureController extends EventEmitter {
  constructor({ createSource, getSettings, selfApps = [], selfPids = [], selfWindows = () => [], idleMs = IDLE_MS, clock = Date.now }) {
    super();
    this.createSource = createSource; this.getSettings = getSettings; this.clock = clock;
    this.selfApps = new Set(selfApps.map(normalizeApp)); this.selfPids = new Set(selfPids); this.selfWindows = selfWindows; this.idleMs = idleMs;
    this.state = 'stopped'; this.error = null; this.segment = null; this.awaySince = null;
  }
  start() {
    if (this.state === 'recording' || this.state === 'away') return;
    this.error = null;
    try {
      this.source = this.createSource();
      this.source.on('sample', sample => this.#onSample(sample));
      this.source.on('error', error => this.#fail(error));
      this.source.start();
      this.#setState('recording');
    } catch (error) { this.#fail(error); }
  }
  stop() {
    this.#close(this.clock());
    this.#endAway(this.clock());
    this.source?.removeAllListeners(); this.source?.stop(); this.source = null;
    if (this.state !== 'unavailable') this.#setState('stopped');
  }
  // Applies changed capture permissions by restarting the watcher (flushes the open segment first).
  restart() {
    if (this.state !== 'recording' && this.state !== 'away') return;
    this.stop();
    this.start();
  }
  current() {
    if (!this.segment) return null;
    const result = filterSample(this.segment, this.getSettings());
    return result.excluded ? { excluded: true, since: new Date(this.segment.at).toISOString() } : { excluded: false, appId: normalizeApp(this.segment.appId), appLabel: appLabel(this.segment.appId), window: result.window, path: result.path ?? null, url: result.url ?? null, since: new Date(this.segment.at).toISOString() };
  }
  #fail(error) {
    this.#close(this.clock());
    this.source?.removeAllListeners(); this.source?.stop(); this.source = null;
    this.error = error.message;
    this.#setState('unavailable');
  }
  #setState(state) { this.state = state; this.emit('state', { state, error: this.error }); }
  #onSample(sample) {
    if (this.state !== 'recording' && this.state !== 'away') return;
    const at = sample.at ?? this.clock();
    if ((sample.idleMs ?? 0) >= this.idleMs) {
      if (this.state !== 'away') { const since = at - sample.idleMs; this.#close(Math.max(since, this.segment?.at ?? since)); this.awaySince = since; this.#setState('away'); }
      return;
    }
    if (this.state === 'away') { this.#endAway(at); this.#setState('recording'); }
    // Continuum's own window is never recorded.
    const self = this.selfPids.has(sample.pid) || this.selfApps.has(normalizeApp(sample.appId)) || (sample.hwnd !== undefined && this.selfWindows().includes(Number(sample.hwnd)));
    const same = this.segment && this.segment.appId === sample.appId && this.segment.window === sample.window && (this.segment.path ?? null) === (sample.path ?? null) && (this.segment.url ?? null) === (sample.url ?? null);
    if (same) {
      if (at - this.segment.at >= MAX_SEGMENT_MS) { this.#close(at); this.segment = { appId: sample.appId, window: sample.window, path: sample.path ?? null, url: sample.url ?? null, at }; }
      return;
    }
    this.#close(at);
    this.segment = self ? null : { appId: sample.appId, window: sample.window, path: sample.path ?? null, url: sample.url ?? null, at };
    this.emit('current', this.current());
  }
  #close(at) {
    const segment = this.segment; this.segment = null;
    if (!segment) return;
    const duration = at - segment.at;
    if (duration < MIN_DWELL_MS) return;
    const result = filterSample(segment, this.getSettings());
    if (result.excluded) { this.emit('excluded', { reason: result.reason }); return; }
    this.emit('segment', {
      source: 'foreground', appId: normalizeApp(segment.appId), appLabel: appLabel(segment.appId), window: result.window || null, path: result.path ?? null, url: result.url ?? null, redacted: result.redacted,
      startedAt: new Date(segment.at).toISOString(), endedAt: new Date(at).toISOString(), durationMs: duration,
    });
  }
  #endAway(at) {
    if (this.awaySince === null) return;
    const since = this.awaySince; this.awaySince = null;
    this.emit('segment', { source: 'lifecycle', appId: 'away', appLabel: 'Away from keyboard', window: null, redacted: false, startedAt: new Date(since).toISOString(), endedAt: new Date(at).toISOString(), durationMs: at - since });
  }
}
