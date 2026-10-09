import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Continuum talks only to its own Ollama process on a fixed loopback port. There is no setting for a
// remote endpoint, and cloud-backed models are refused.
export const RUNTIME_HOST = '127.0.0.1:11435';
export const RUNTIME_URL = `http://${RUNTIME_HOST}`;

function ollamaBinary() {
  const local = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe');
  return local && existsSync(local) ? local : 'ollama';
}

export async function ping(signal) {
  try { const r = await fetch(`${RUNTIME_URL}/api/version`, { signal, redirect: 'error' }); return r.ok; } catch { return false; }
}

// Ollama runs each loaded model in a child llama-server process. Killing only `ollama serve` on Windows orphans
// those runners (each holding the model in RAM), so the whole tree is terminated, synchronously so it finishes on quit.
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
}

// Starts `ollama serve` bound to loopback with cloud features disabled. Reuses an already-running
// instance on the same port (for example a second test run) but reports that it is not owned.
export async function startRuntime({ timeoutMs = 30000 } = {}) {
  if (await ping()) return { owned: false, stop() {} };
  const child = spawn(ollamaBinary(), ['serve'], {
    env: { ...process.env, OLLAMA_HOST: RUNTIME_HOST, OLLAMA_NO_CLOUD: '1', OLLAMA_ORIGINS: '' },
    windowsHide: true, stdio: 'ignore',
  });
  let failure = null;
  child.on('error', error => { failure = error.code === 'ENOENT' ? new Error('Ollama is not installed or not on PATH.') : error; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error('The local model runtime exited during startup.');
    if (await ping()) return { owned: true, child, stop: () => killTree(child) };
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  child.kill();
  throw new Error('The local model runtime did not start in time.');
}

const isCloud = model => /(:|-)cloud\b/i.test(model.name ?? '') || !!model.remote_host || !!model.remote_model;

export class OllamaProvider {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; this.lastMetrics = null; }

  async #post(path, body, signal) {
    const response = await this.fetch(`${RUNTIME_URL}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error',
    });
    if (!response.ok) {
      let detail = ''; try { detail = (await response.json()).error ?? ''; } catch { /* no body */ }
      throw new Error(`Local model request failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return response.json();
  }

  // Readiness = runtime reachable, both configured models installed locally, none cloud-backed.
  async health(models) {
    let version;
    try {
      const r = await this.fetch(`${RUNTIME_URL}/api/version`, { redirect: 'error' });
      version = (await r.json()).version;
    } catch { return { ready: false, runtime: false, missing: [models.generation, models.embedding], models: [], error: 'Local model runtime is not reachable.' }; }
    const r = await this.fetch(`${RUNTIME_URL}/api/tags`, { redirect: 'error' });
    const installed = ((await r.json()).models ?? []).filter(m => !isCloud(m));
    const has = name => installed.some(m => m.name === name || m.name === `${name}:latest` || m.model === name);
    const missing = [models.generation, models.embedding].filter(name => !has(name));
    return {
      ready: missing.length === 0, runtime: true, version, missing,
      models: installed.map(m => ({ name: m.name, size: m.size, digest: m.digest, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level })),
    };
  }

  // Loads the model and, when a system prompt is given, evaluates it once so Ollama can reuse that prefix.
  async warm(model, system) {
    if (!system) { await this.#post('/api/generate', { model, prompt: '', keep_alive: '30m' }); return; }
    await this.#post('/api/chat', { model, stream: false, think: false, keep_alive: '30m', options: { num_ctx: 4096, num_predict: 1 }, messages: [{ role: 'system', content: system }, { role: 'user', content: 'Ready?' }] });
  }

  // Structured chat generation constrained by a JSON schema. Thinking is disabled for latency.
  async generate({ model, system, user, schema, signal, maxTokens = 450 }) {
    const started = Date.now();
    const result = await this.#post('/api/chat', {
      model, stream: false, think: false, keep_alive: '30m', format: schema,
      options: { temperature: 0.2, num_ctx: 4096, num_predict: maxTokens },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }, signal);
    this.lastMetrics = {
      elapsedMs: Date.now() - started, loadMs: Math.round((result.load_duration ?? 0) / 1e6), promptTokens: result.prompt_eval_count,
      promptMs: Math.round((result.prompt_eval_duration ?? 0) / 1e6), generatedTokens: result.eval_count, generationMs: Math.round((result.eval_duration ?? 0) / 1e6),
    };
    const text = result.message?.content ?? '';
    try { return JSON.parse(text); } catch { throw new Error('The local model returned malformed JSON.'); }
  }

  // all-minilm runs with a small context; inputs are kept short by the caller and num_ctx is explicit.
  async embed({ model, texts, signal }) {
    if (!texts.length) return [];
    const result = await this.#post('/api/embed', { model, input: texts, keep_alive: '30m', options: { num_ctx: 512 } }, signal);
    const vectors = result.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(v => !Array.isArray(v) || !v.length || v.some(n => !Number.isFinite(n)))) throw new Error('The local embedding model returned invalid vectors.');
    return vectors;
  }
}
