import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Folder, Globe, RefreshCw, Search, X, FolderPlus, Plus } from 'lucide-react';
import { call } from './api';
import type { DeviceApp, Exclusions } from './types';
import { ListEditor } from './components';

const SOURCE_LABEL = { running: 'open now', seen: 'used in sessions', installed: 'installed' } as const;

// Exclusion editor built from what is actually on this device: apps (open, used, installed), folders and websites.
export function ExclusionEditor({ value, onChange, disabled }: { value: Exclusions; onChange: (next: Exclusions) => void; disabled?: boolean }) {
  const [apps, setApps] = useState<DeviceApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [site, setSite] = useState('');
  const load = async () => {
    setError(null);
    try { setApps(await call<DeviceApp[]>('deviceApps')); } catch (e) { setError((e as Error).message); setApps([]); }
  };
  useEffect(() => { void load(); }, []);

  // Excluded apps that are not on this device (for example the default password-manager list) stay visible.
  const rows = useMemo(() => {
    const known = new Map((apps ?? []).map(a => [a.appId, a]));
    for (const id of value.excludedApps) if (!known.has(id)) known.set(id, { appId: id, label: id, sources: [], path: null });
    const q = filter.trim().toLowerCase();
    return [...known.values()].filter(a => !q || a.label.toLowerCase().includes(q) || a.appId.includes(q))
      .sort((a, b) => Number(value.excludedApps.includes(b.appId)) - Number(value.excludedApps.includes(a.appId)));
  }, [apps, value.excludedApps, filter]);

  const toggleApp = (id: string) => onChange({ ...value, excludedApps: value.excludedApps.includes(id) ? value.excludedApps.filter(x => x !== id) : [...value.excludedApps, id] });
  const addFolder = async () => {
    try { const folder = await call<string | null>('pickFolder'); if (folder && !value.excludedFolders.includes(folder)) onChange({ ...value, excludedFolders: [...value.excludedFolders, folder] }); }
    catch (e) { setError((e as Error).message); }
  };
  const addSite = () => {
    const host = site.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
    if (host && !value.excludedSites.includes(host)) onChange({ ...value, excludedSites: [...value.excludedSites, host] });
    setSite('');
  };

  return (
    <div className="exclusions">
      <section className="excl-block" aria-labelledby="excl-apps">
        <div className="excl-head"><h3 id="excl-apps"><AppWindow size={15} aria-hidden="true" /> Apps on this device</h3>
          <span className="muted small">{value.excludedApps.length} excluded</span>
          <button className="ghost small-button" onClick={load} disabled={disabled}><RefreshCw size={13} aria-hidden="true" /> Refresh</button></div>
        <div className="excl-search"><Search size={14} aria-hidden="true" className="muted" /><label htmlFor="excl-filter" className="sr-only">Filter apps</label>
          <input id="excl-filter" value={filter} placeholder="Filter apps…" onChange={e => setFilter(e.target.value)} disabled={disabled} /></div>
        <div className="app-list" role="group" aria-label="Apps to exclude">
          {apps === null ? <p className="muted small pad">Listing apps on this device…</p> : rows.length === 0 ? <p className="muted small pad">No apps match.</p> : rows.map(a => (
            <label key={a.appId} className={`app-row ${value.excludedApps.includes(a.appId) ? 'checked' : ''}`}>
              <input type="checkbox" checked={value.excludedApps.includes(a.appId)} disabled={disabled} onChange={() => toggleApp(a.appId)} />
              <span className="app-name">{a.label}</span>
              <span className="app-meta">{a.appId}{a.sources.length ? ` · ${a.sources.map(s => SOURCE_LABEL[s]).join(', ')}` : ' · not found on this device'}</span>
            </label>
          ))}
        </div>
        {error && <p className="warn-text small" role="alert">{error}</p>}
      </section>

      <section className="excl-block" aria-labelledby="excl-folders">
        <div className="excl-head"><h3 id="excl-folders"><Folder size={15} aria-hidden="true" /> Folders</h3>
          <button className="ghost small-button" onClick={addFolder} disabled={disabled}><FolderPlus size={13} aria-hidden="true" /> Add folder…</button></div>
        <p className="muted small">File Explorer windows in these folders (and their subfolders) are not recorded. Applies when folder capture is on; otherwise only the window title is seen, so add a keyword below to drop it by name.</p>
        <ul className="chip-list">{value.excludedFolders.map(f => <li key={f} className="tag"><Folder size={12} aria-hidden="true" />{f}<button className="tag-remove" disabled={disabled} aria-label={`Remove ${f}`} onClick={() => onChange({ ...value, excludedFolders: value.excludedFolders.filter(x => x !== f) })}><X size={12} /></button></li>)}
          {!value.excludedFolders.length && <li className="muted small">No folders excluded.</li>}</ul>
      </section>

      <section className="excl-block" aria-labelledby="excl-sites">
        <div className="excl-head"><h3 id="excl-sites"><Globe size={15} aria-hidden="true" /> Websites</h3></div>
        <p className="muted small">Browser tabs on these sites (including subdomains) are not recorded. Applies when address capture is on; otherwise only the page title is seen, so add a keyword below to drop it by title.</p>
        <ul className="chip-list">{value.excludedSites.map(s => <li key={s} className="tag"><Globe size={12} aria-hidden="true" />{s}<button className="tag-remove" disabled={disabled} aria-label={`Remove ${s}`} onClick={() => onChange({ ...value, excludedSites: value.excludedSites.filter(x => x !== s) })}><X size={12} /></button></li>)}
          {!value.excludedSites.length && <li className="muted small">No websites excluded.</li>}</ul>
        <div className="inline-form">
          <label htmlFor="excl-site" className="sr-only">Website to exclude</label>
          <input id="excl-site" value={site} maxLength={200} disabled={disabled} placeholder="e.g. mybank.com" onChange={e => setSite(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSite(); } }} />
          <button className="secondary" disabled={disabled || !site.trim()} onClick={addSite}><Plus size={14} aria-hidden="true" /> Add</button>
        </div>
      </section>

      <details className="excl-advanced">
        <summary>Advanced: title and address keywords ({value.excludedKeywords.length})</summary>
        <ListEditor label="Windows or addresses containing these words are not recorded" values={value.excludedKeywords} onChange={excludedKeywords => onChange({ ...value, excludedKeywords })} placeholder="e.g. salary" disabled={disabled} />
      </details>
    </div>
  );
}

// Optional capture categories layered on top of basic app + window-title capture.
export function CaptureScopes({ paths, urls, onChange, disabled }: { paths: boolean; urls: boolean; onChange: (next: { paths: boolean; urls: boolean }) => void; disabled?: boolean }) {
  return (
    <div className="scopes" role="group" aria-label="Optional capture categories">
      <label className="scope">
        <input type="checkbox" className="switch" checked={paths} disabled={disabled} onChange={e => onChange({ paths: e.target.checked, urls })} />
        <span><strong>Folders you open in File Explorer</strong><span className="muted small"> The full folder path of the Explorer window in front, e.g. C:\Users\you\Projects\shop-app.</span></span>
      </label>
      <label className="scope">
        <input type="checkbox" className="switch" checked={urls} disabled={disabled} onChange={e => onChange({ paths, urls: e.target.checked })} />
        <span><strong>Full web addresses in your browser</strong><span className="muted small"> The address bar of Chrome, Edge, Brave, Firefox, Opera, Vivaldi or Arc when it is in front, read through Windows UI Automation. Login codes, tokens and emails in addresses are redacted.</span></span>
      </label>
    </div>
  );
}
