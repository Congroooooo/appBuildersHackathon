import type { Snapshot } from './types';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
interface Bridge {
  call: <T>(method: string, payload?: unknown) => Promise<Result<T>>;
  onSnapshot: (callback: (snapshot: Snapshot) => void) => () => void;
  onProgress: (callback: (stage: string) => void) => () => void;
}
declare global { interface Window { continuum?: Bridge } }

export const bridge = window.continuum;

export async function call<T>(method: string, payload?: unknown): Promise<T> {
  if (!bridge) throw new Error('The secure desktop bridge is only available in the Continuum desktop app.');
  const result = await bridge.call<T>(method, payload);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
