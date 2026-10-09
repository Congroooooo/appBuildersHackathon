import { Zap } from 'lucide-react';
import { call } from './api';
import type { AppContext } from './App';

// Turns on every capture category for developer work in one step (each still recorded as its own consent).
export async function enableAllCapture() {
  await call('setConsent', { granted: true });
  await call('setCaptureScopes', { paths: true, urls: true });
  await call('setObserve', { watchFiles: true, captureCommands: true, browserContext: true });
  await call('setAutoTrack', { enabled: true });
  await call('setIncludeDiffs', { enabled: true });
}

export function missingCapture(ctx: AppContext) {
  const s = ctx.snapshot.settings;
  const missing: string[] = [];
  if (!s.autoTrack) missing.push('code changes');
  if (!s.watchFiles) missing.push('files and folders');
  if (!s.captureCommands) missing.push('terminal commands');
  return missing;
}

// Shown where the user would notice missing detail: "you edited files, but exact changes were not captured".
export function CaptureHint({ ctx, reason }: { ctx: AppContext; reason: string }) {
  const missing = missingCapture(ctx);
  if (!missing.length) return null;
  return (
    <div className="capture-hint" role="note">
      <Zap size={15} aria-hidden="true" />
      <span><strong>{reason}</strong> <span className="muted small">Off: {missing.join(', ')}. Turning them on applies from the next session you start.</span></span>
      <button className="secondary small-button" disabled={ctx.busy} onClick={() => ctx.run(enableAllCapture, 'All developer capture is on. It applies from your next session.')}>Turn on</button>
    </div>
  );
}
