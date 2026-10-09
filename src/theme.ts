import { useCallback, useEffect, useState } from 'react';
import { bridge } from './api';

export type ThemePref = 'system' | 'light' | 'dark';
type Resolved = 'light' | 'dark';

const KEY = 'continuum-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
const resolve = (pref: ThemePref): Resolved => pref === 'system' ? (media().matches ? 'dark' : 'light') : pref;
const apply = (theme: Resolved) => { document.documentElement.dataset.theme = theme; };

// Runs before React renders so the first paint already uses the saved theme.
export function initTheme() {
  const pref = readPref();
  apply(resolve(pref));
  // Electron follows the choice too (window frame, native controls, prefers-color-scheme).
  void bridge?.call('setTheme', { theme: pref }).catch(() => undefined);
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [theme, setTheme] = useState<Resolved>(() => resolve(pref));

  useEffect(() => {
    if (pref !== 'system') return;
    const m = media();
    const onChange = () => { const next = m.matches ? 'dark' : 'light'; apply(next); setTheme(next); };
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [pref]);

  // Switching theme reveals the new one in a circle growing from the control that was used.
  const choose = useCallback(async (next: ThemePref, origin?: { x: number; y: number }) => {
    try { localStorage.setItem(KEY, next); } catch { /* the choice still applies to this window */ }
    setPref(next);
    await bridge?.call('setTheme', { theme: next }).catch(() => undefined);
    const target = resolve(next);
    const swap = () => { apply(target); setTheme(target); };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The reveal needs a painted, focused window; otherwise switch instantly.
    const canAnimate = typeof document.startViewTransition === 'function' && document.visibilityState === 'visible' && document.hasFocus();
    if (target === document.documentElement.dataset.theme || reduced || !canAnimate) { swap(); return; }
    const x = origin?.x ?? window.innerWidth / 2, y = origin?.y ?? window.innerHeight / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = document.startViewTransition(swap);
    // Whatever happens to the animation, the new theme must end up applied.
    const guard = setTimeout(() => { transition.skipTransition(); swap(); }, 1200);
    void transition.finished.catch(() => undefined).finally(() => { clearTimeout(guard); swap(); });
    try { await transition.ready; } catch { return; }
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }, []);

  return { pref, theme, choose };
}
