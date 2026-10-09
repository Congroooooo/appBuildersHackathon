import { useEffect, useState } from 'react';
import { Infinity as InfinityIcon, Check, X, ArrowRight, ArrowLeft, Cpu, ShieldCheck, EyeOff, RefreshCw } from 'lucide-react';
import { call } from '../api';
import type { AppContext } from '../App';
import type { Health } from '../types';
import { ExclusionEditor, CaptureScopes } from '../exclusions';
import type { Exclusions } from '../types';
import { bytes } from '../format';
import { ThemeSwitch } from '../components';

const CAPTURES = ['Name of the app in the foreground (e.g. VS Code, Chrome)', 'Its window title, after redaction (e.g. “auth.ts — shop-app”)', 'When you switched and how long you stayed', 'Notes you type yourself'];
const NEVER = ['Screenshots, screen recording or OCR', 'Keystrokes, clipboard or microphone', 'File contents, or browser history beyond the address of the window in front (and only if you allow it)', 'Anything while paused, ended or excluded', 'Anything sent to a cloud service'];

export function Setup({ ctx }: { ctx: AppContext }) {
  const { snapshot, run, busy } = ctx;
  const [step, setStepRaw] = useState(0);
  const [direction, setDirection] = useState<'fwd' | 'back'>('fwd');
  const setStep = (next: number) => { setDirection(next < step ? 'back' : 'fwd'); setStepRaw(next); };
  const s0 = snapshot.settings;
  const [exclusions, setExclusions] = useState<Exclusions>({ excludedApps: s0.excludedApps, excludedFolders: s0.excludedFolders, excludedSites: s0.excludedSites, excludedKeywords: s0.excludedKeywords });
  const [scopes, setScopes] = useState({ paths: false, urls: false });
  const [health, setHealth] = useState<Health | null>(snapshot.health);
  const [checking, setChecking] = useState(false);
  const [model, setModel] = useState(snapshot.settings.generationModel);
  const [consent, setConsent] = useState(false);
  const [trackCode, setTrackCode] = useState(false);
  const [observe, setObserveChoice] = useState({ watchFiles: false, captureCommands: false });

  const check = async () => {
    setChecking(true);
    try { setHealth(await call<Health>('health')); } catch (e) { setHealth({ ready: false, runtime: false, missing: [], models: [], error: (e as Error).message }); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (step === 2 && !health) void check(); }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const generationModels = (health?.models ?? []).filter(m => !/minilm|embed|bge|nomic/i.test(m.name));

  const finish = async () => {
    await run(async () => {
      if (model !== snapshot.settings.generationModel) await call('setModel', { generationModel: model });
      await call('updateExclusions', exclusions);
      if (consent) { await call('setConsent', { granted: true }); if (scopes.paths || scopes.urls) await call('setCaptureScopes', scopes); }
      if (trackCode) await call('setAutoTrack', { enabled: true });
      if (observe.watchFiles || observe.captureCommands) await call('setObserve', observe);
      await call('completeOnboarding', {});
    }, consent ? 'Setup complete. Capture starts only when you start a session.' : 'Setup complete in notes-only mode.');
  };

  const steps = ['Welcome', 'Exclusions', 'Local AI', 'Permission'];
  return (
    <div className="setup">
      <div className="setup-panel">
        <div className="setup-top">
          <div className="brand setup-brand"><span className="mark"><InfinityIcon aria-hidden="true" /></span><span>Continuum</span></div>
          <ThemeSwitch pref={ctx.theme.pref} choose={ctx.theme.choose} />
        </div>
        <ol className="stepper" aria-label="Setup progress">{steps.map((s, i) => <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i < step ? <Check size={12} aria-hidden="true" /> : `${i + 1}.`} {s}</span></li>)}</ol>
        <div key={step} className={`setup-step ${direction === 'back' ? 'back-dir' : ''}`}>

        {step === 0 && <section>
          <h1 id="main-heading" tabIndex={-1}>Step away. Pick up where you left off.</h1>
          <p className="lead">Continuum remembers what you were working on, so coming back doesn't mean rebuilding your context from scratch. Recaps are written by a local model on this laptop and work with the internet off.</p>
          <div className="two-col">
            <div className="card"><h3><ShieldCheck size={16} aria-hidden="true" /> What it can record, only during a session you start</h3><ul className="checks">{CAPTURES.map(c => <li key={c}><Check size={14} aria-hidden="true" />{c}</li>)}</ul></div>
            <div className="card"><h3><EyeOff size={16} aria-hidden="true" /> What it never records</h3><ul className="crosses">{NEVER.map(c => <li key={c}><X size={14} aria-hidden="true" />{c}</li>)}</ul></div>
          </div>
          <p className="muted small">Everything is stored encrypted on this device, with the key protected by your Windows account. You can inspect, edit, export or delete any of it.</p>
        </section>}

        {step === 1 && <section>
          <h1 id="main-heading" tabIndex={-1}>Choose what stays private</h1>
          <p className="lead">Pick apps from this device, folders and websites that Continuum must never record. Matching activity is dropped before anything is saved and never reaches the AI. Private and incognito browser windows are always excluded.</p>
          <ExclusionEditor value={exclusions} onChange={setExclusions} />
        </section>}

        {step === 2 && <section>
          <h1 id="main-heading" tabIndex={-1}>Check the local model</h1>
          <p className="lead">Continuum runs its own Ollama process on <code>127.0.0.1:11435</code> with cloud features disabled. It never calls a hosted AI API.</p>
          <div className="card health-card" aria-live="polite">
            {checking ? <p><RefreshCw size={15} className="spin" aria-hidden="true" /> Starting the local runtime and checking models…</p>
              : !health ? null
              : health.runtime ? <>
                <p className={health.ready ? 'ok-text' : 'warn-text'}>{health.ready ? <><Check size={15} aria-hidden="true" /> Local AI ready (Ollama {health.version})</> : <><X size={15} aria-hidden="true" /> Missing model(s): {health.missing.join(', ')}</>}</p>
                {!health.ready && <p className="muted small">Install while online: <code>ollama pull {health.missing.join(' && ollama pull ')}</code></p>}
                <label htmlFor="setup-model">Recap model</label>
                <select id="setup-model" value={model} onChange={e => setModel(e.target.value)}>
                  {!generationModels.some(m => m.name === model) && <option value={model}>{model} (not installed)</option>}
                  {generationModels.map(m => <option key={m.name} value={m.name}>{m.name} · {m.parameterSize} · {bytes(m.size)}</option>)}
                </select>
                <p className="muted small">Smaller models write recaps faster on CPU-only laptops. Embeddings for search use {snapshot.settings.embeddingModel}.</p>
              </> : <p className="warn-text"><X size={15} aria-hidden="true" /> {health.error ?? snapshot.runtimeError ?? 'Local runtime unavailable.'}</p>}
            <button className="secondary" onClick={check} disabled={checking}><Cpu size={15} aria-hidden="true" /> Check again</button>
          </div>
          <p className="muted small">You can continue without the model. Recaps then fall back to a plain, clearly labeled list of apps and notes.</p>
        </section>}

        {step === 3 && <section>
          <h1 id="main-heading" tabIndex={-1}>Allow activity capture?</h1>
          <p className="lead">Capture stays off until you start a session. You can pause it at any time, and the status is always shown at the top of the window and in the system tray.</p>
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
            <span>Allow Continuum to record the <strong>foreground app name and redacted window title</strong> while a session I start is recording. I can revoke this in the Privacy center.</span>
          </label>
          {consent && <div className="reveal"><p className="muted small" style={{ marginTop: 16 }}>Optional, each off unless you turn it on:</p><CaptureScopes paths={scopes.paths} urls={scopes.urls} onChange={setScopes} /></div>}
          <label className="scope" style={{ marginTop: 12 }}><input type="checkbox" checked={trackCode} onChange={e => setTrackCode(e.target.checked)} /><span><strong>Track code changes in projects I open in my editor</strong><span className="muted small"> Shows exactly what you changed (e.g. a value from 3000 → 5173) for VS Code and Cursor projects — Git repositories, or private snapshots for plain folders. Local only; changed lines are redacted and encrypted.</span></span></label>
          <label className="scope"><input type="checkbox" checked={observe.watchFiles} onChange={e => setObserveChoice({ ...observe, watchFiles: e.target.checked })} /><span><strong>Record files and folders I create, rename, delete or save</strong><span className="muted small"> From any app, including File Explorer. Paths only.</span></span></label>
          <label className="scope"><input type="checkbox" checked={observe.captureCommands} onChange={e => setObserveChoice({ ...observe, captureCommands: e.target.checked })} /><span><strong>Record the terminal commands I run</strong><span className="muted small"> PowerShell and Git Bash; secrets redacted. Command Prompt keeps no readable history.</span></span></label>
          <p className="muted small">Without permission, Continuum works in notes-only mode: you type what you're doing and the local AI summarizes your notes.</p>
        </section>}

        </div>

        <div className="setup-actions">
          {step > 0 ? <button className="ghost" onClick={() => setStep(step - 1)}><ArrowLeft size={15} aria-hidden="true" /> Back</button> : <span />}
          {step < 3 ? <button className="primary" onClick={() => setStep(step + 1)}>Continue <ArrowRight size={15} aria-hidden="true" /></button>
            : <button className="primary" disabled={busy} onClick={finish}>{consent ? 'Finish setup' : 'Continue in notes-only mode'} <ArrowRight size={15} aria-hidden="true" /></button>}
        </div>
      </div>
    </div>
  );
}
