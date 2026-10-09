import { useEffect, useState } from 'react';
import { Cpu, RefreshCw, Flame, Wifi, WifiOff, Check, X } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { Health } from '../types';
import { bytes, when } from '../format';

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

export function SettingsPage({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const health = snapshot.health;
  const online = useOnline();
  const [model, setModel] = useState(snapshot.settings.generationModel);
  useEffect(() => setModel(snapshot.settings.generationModel), [snapshot.settings.generationModel]);
  const generationModels = (health?.models ?? []).filter(m => !/minilm|embed|bge|nomic/i.test(m.name));
  const lastModel = snapshot.sessions.find(s => s.summaryGenerator === 'model');
  return (
    <div className="page">
      <h1 id="main-heading" tabIndex={-1}>Everything runs on this laptop</h1>

      <section className="panel" aria-labelledby="runtime-heading">
        <div className="section-head">
          <h2 className="section-title" id="runtime-heading"><Cpu size={15} aria-hidden="true" /> Model runtime</h2>
          <div className="actions">
            <button className="ghost small-button" disabled={busy} onClick={() => run(() => call<Health>('health'), 'Local AI checked.')}><RefreshCw size={13} aria-hidden="true" /> Check</button>
            <button className="ghost small-button" disabled={busy || !health?.ready} onClick={() => run(() => call('warm'), 'Model loaded and ready.')}><Flame size={13} aria-hidden="true" /> Warm up model</button>
          </div>
        </div>
        <dl className="kv">
          <dt>Status</dt><dd className={health?.ready && !snapshot.runtimeError ? 'ok-text' : 'warn-text'}>{snapshot.runtimeError ? <><X size={14} aria-hidden="true" /> {snapshot.runtimeError}</> : !health ? 'Not checked yet' : health.ready ? <><Check size={14} aria-hidden="true" /> Ready</> : <><X size={14} aria-hidden="true" /> {health.error ?? `Missing ${health.missing.join(', ')}`}</>}</dd>
          <dt>Runtime</dt><dd>Ollama {health?.version ?? '—'} on <code>127.0.0.1:11435</code> · cloud disabled (<code>OLLAMA_NO_CLOUD=1</code>){snapshot.runtimeOwned === false ? ' · reusing an existing local instance' : ''}</dd>
          <dt>Embeddings</dt><dd>{snapshot.settings.embeddingModel} (search)</dd>
          <dt>Prompt</dt><dd>{snapshot.promptVersion} · schema-constrained JSON, evidence IDs validated</dd>
          <dt>Storage</dt><dd><code>{snapshot.dataPath ?? '—'}</code> · continuum.db (encrypted fields) + continuum.key (DPAPI)</dd>
          <dt>Last checked</dt><dd>{health?.checkedAt ? when(health.checkedAt) : '—'}</dd>
        </dl>
        <label htmlFor="model-select">Recap model</label>
        <div className="inline-form">
          <select id="model-select" value={model} onChange={e => setModel(e.target.value)} disabled={busy}>
            {!generationModels.some(m => m.name === model) && <option value={model}>{model}</option>}
            {generationModels.map(m => <option key={m.name} value={m.name}>{m.name} · {m.parameterSize} · {m.quantization} · {bytes(m.size)}</option>)}
          </select>
          <button className="secondary" disabled={busy || model === snapshot.settings.generationModel} onClick={() => run(async () => { await call('setModel', { generationModel: model }); await call('health'); }, 'Recap model changed.')}>Use model</button>
        </div>
        {lastModel && <p className="muted small">Most recent AI recap: “{lastModel.summaryTitle}”.</p>}
      </section>

      <section className="panel" aria-labelledby="network-heading">
        <h2 className="section-title" id="network-heading">{online ? <Wifi size={15} aria-hidden="true" /> : <WifiOff size={15} aria-hidden="true" />} Offline operation</h2>
        <p><span className={`tag ${online ? '' : 'tag-on'}`}>{online ? 'This device reports a network connection' : 'This device reports no network connection'}</span></p>
        <ul className="plain">
          <li>Recaps, embeddings and search call only the local runtime on the loopback address.</li>
          <li>The app window may load only its own packaged files. Every http, https and websocket request from it is blocked.</li>
          <li>No analytics, crash upload or telemetry is included.</li>
        </ul>
        <p className="muted small">To prove it: turn Wi-Fi off, end a session and watch the recap get written. The online/offline label comes from Windows; Continuum makes no request to check it.</p>
      </section>
    </div>
  );
}
