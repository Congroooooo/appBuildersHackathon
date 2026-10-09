// Privacy filter applied to every captured foreground sample before it reaches disk or a model prompt.

export const DEFAULT_EXCLUDED_APPS = [
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'dashlane', 'lastpass', 'enpass', 'credentialuibroker',
  'whatsapp', 'telegram', 'signal', 'messenger', 'discord', 'slack', 'ms-teams', 'teams', 'viber', 'line',
];

export const DEFAULT_EXCLUDED_KEYWORDS = [
  'bank', 'banking', 'password', 'credit card', 'paypal', 'gcash', 'maya',
  'health', 'medical', 'patient', 'pharmacy', 'payslip', 'payroll', 'credential', 'id_rsa', '.pem',
];

// Private browsing windows are always excluded; this is not user-editable.
const PRIVATE_BROWSING = /\b(InPrivate|Incognito|Private Browsing|Private Window)\b/i;

const REDACTIONS = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/\b(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1'],
  [/\b((?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?\/[^\s?#]*)[?#]\S*/gi, '$1'],
  [/\b(?:sk|pk|ghp|gho|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g, '[secret]'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}(?![\w.])/g, '[token]'],
  [/\b\d(?:[ -]?\d){11,}\b/g, '[number]'],
];

export const MAX_TITLE = 160;

export function normalizeApp(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.exe$/i, '');
}

// Secret redaction for free text from connectors (file paths, commit subjects).
export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// Code-change excerpts: general redaction plus values assigned to secret-looking names
// (password = "…", apiKey: '…', CLIENT_SECRET=…). Conservative: may also blank harmless values.
const SECRET_ASSIGNMENT = /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|auth[_-]?key|credential|private[_-]?key|access[_-]?key|client[_-]?secret|conn(?:ection)?[_-]?string)["']?\s*[:=]\s*)(["'`]?)[^"'`\s,;)]+\2/gi;
export function redactCode(line) {
  return redact(line).replace(SECRET_ASSIGNMENT, '$1$2[redacted]$2');
}

// Folder paths are compared case-insensitively with normalized separators; a folder excludes everything inside it.
export function normalizeFolder(value) {
  return String(value ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// Accepts "github.com", "https://mail.google.com/x" or "*.bank.com"; returns a bare lowercase host.
export function normalizeSite(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
}

// Address-bar text often lacks a scheme ("github.com/org/repo"). Anything that is not URL-shaped (for example
// text being typed into the omnibox) is dropped.
export function normalizeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw) || raw.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(about|chrome|edge|brave|file):/i.test(raw)) return raw;
  if (/^[a-z]:[\\/]/i.test(raw)) return `file:///${raw.replace(/\\/g, '/')}`; // browsers show local files as C:/...
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(raw)) return `http://${raw}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/i.test(raw)) return `https://${raw}`;
  return null;
}

// Secrets are redacted from full addresses; the path and other query parameters are kept (full-address capture).
const URL_REDACTIONS = [
  [/[\w.+-]+(@|%40)[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/\b(?:sk|pk|ghp|gho|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g, '[secret]'],
  [/([?&#](?:access_token|id_token|refresh_token|token|code|key|api_key|apikey|secret|password|pwd|sig|signature|auth|session|sid)=)[^&#]*/gi, '$1[redacted]'],
  [/[A-Za-z0-9+_-]{32,}={0,2}/g, '[token]'],
  [/\b\d(?:[ -]?\d){11,}\b/g, '[number]'],
];
export const MAX_URL = 400;

// Returns { excluded: true, reason } or { excluded: false, window, path, url, redacted }.
export function filterSample(sample, settings) {
  const app = normalizeApp(sample.appId);
  if (!app) return { excluded: true, reason: 'unknown' };
  if (settings.excludedApps.some(entry => normalizeApp(entry) === app)) return { excluded: true, reason: 'app' };
  const raw = String(sample.window ?? '').replace(/\s+/g, ' ').trim();
  if (PRIVATE_BROWSING.test(raw)) return { excluded: true, reason: 'private' };
  const keywords = settings.excludedKeywords.map(k => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.some(k => raw.toLowerCase().includes(k))) return { excluded: true, reason: 'keyword' };
  const path = settings.capturePaths && sample.path ? String(sample.path).trim() : null;
  if (path) {
    const folder = normalizeFolder(path);
    if ((settings.excludedFolders ?? []).some(entry => { const e = normalizeFolder(entry); return e && (folder === e || folder.startsWith(`${e}\\`)); })) return { excluded: true, reason: 'folder' };
  }
  const rawUrl = settings.captureUrls ? normalizeUrl(sample.url) : null;
  if (rawUrl) {
    const host = normalizeSite(rawUrl);
    if ((settings.excludedSites ?? []).some(entry => { const e = normalizeSite(entry); return e && (host === e || host.endsWith(`.${e}`)); })) return { excluded: true, reason: 'site' };
    if (keywords.some(k => rawUrl.toLowerCase().includes(k))) return { excluded: true, reason: 'keyword' };
  }
  let window = raw;
  for (const [pattern, replacement] of REDACTIONS) window = window.replace(pattern, replacement);
  if (window.length > MAX_TITLE) window = `${window.slice(0, MAX_TITLE - 1)}…`;
  let url = rawUrl;
  if (url) {
    for (const [pattern, replacement] of URL_REDACTIONS) url = url.replace(pattern, replacement);
    if (url.length > MAX_URL) url = `${url.slice(0, MAX_URL - 1)}…`;
  }
  return { excluded: false, window, path, url, redacted: window !== raw || url !== rawUrl };
}

// Friendly labels for common process names; unknown names are shown as-is.
const LABELS = {
  code: 'VS Code', 'code - insiders': 'VS Code Insiders', cursor: 'Cursor', devenv: 'Visual Studio', idea64: 'IntelliJ IDEA', pycharm64: 'PyCharm', webstorm64: 'WebStorm',
  chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', brave: 'Brave', arc: 'Arc', opera: 'Opera',
  windowsterminal: 'Windows Terminal', powershell: 'PowerShell', pwsh: 'PowerShell', cmd: 'Command Prompt', wezterm: 'WezTerm', warp: 'Warp', 'wezterm-gui': 'WezTerm',
  explorer: 'File Explorer', notepad: 'Notepad', 'notepad++': 'Notepad++', obsidian: 'Obsidian', notion: 'Notion', figma: 'Figma',
  winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', outlook: 'Outlook', olk: 'Outlook', postman: 'Postman', docker: 'Docker Desktop',
};

export function appLabel(appId) {
  const key = normalizeApp(appId);
  return LABELS[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Unknown');
}
