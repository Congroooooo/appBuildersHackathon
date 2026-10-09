import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { appLabel, normalizeApp } from './privacy.mjs';

// Lists apps on this device for the exclusion picker: apps with open windows now, plus installed Start-menu apps
// whose entry points to an .exe (so the process name is known). Read-only; nothing is stored.
const SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$running = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { @{ name = $_.ProcessName; label = $_.Description; path = $_.Path } }
$installed = Get-StartApps | Where-Object { $_.AppID -match '\.exe$' } | ForEach-Object { @{ name = $_.Name; app = $_.AppID } }
@{ running = @($running); installed = @($installed) } | ConvertTo-Json -Depth 4 -Compress
`;

// Windows shell plumbing that owns windows but is not something a user would exclude.
const SYSTEM = new Set(['applicationframehost', 'textinputhost', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'systemsettings', 'lockapp', 'taskmgr', 'nvidia overlay']);

export function listDeviceApps(seen = []) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('Could not list apps on this device.'));
      let data;
      try { data = JSON.parse(stdout); } catch { return reject(new Error('Could not list apps on this device.')); }
      const apps = new Map();
      const add = (appId, label, source, path) => {
        const id = normalizeApp(appId);
        if (!id || id === 'continuum' || id === 'electron' || SYSTEM.has(id)) return;
        const entry = apps.get(id) ?? { appId: id, label: label || appLabel(id), sources: [], path: null };
        if (!entry.sources.includes(source)) entry.sources.push(source);
        if (path && !entry.path) entry.path = path;
        if (label && source === 'running') entry.label = label;
        apps.set(id, entry);
      };
      for (const p of data.running ?? []) add(p.name, p.label, 'running', p.path);
      for (const i of data.installed ?? []) add(basename(String(i.app).replace(/\\/g, '/')), i.name, 'installed', null);
      for (const s of seen) add(s.appId, s.label, 'seen', null);
      const rank = e => (e.sources.includes('running') ? 2 : 0) + (e.sources.includes('seen') ? 1 : 0);
      resolve([...apps.values()].sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label)));
    });
  });
}
