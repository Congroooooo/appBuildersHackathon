// Continuum native-messaging helper for the browser extension. Chrome/Edge start it per message and write one
// length-prefixed JSON message to stdin; it appends a minimized line to Continuum's local inbox and replies.
// No network. Continuum validates every line again before using it.
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const inbox = process.env.CONTINUUM_INBOX || join(process.env.APPDATA || '.', 'Continuum', 'inbox');
const chunks = [];
let done = false;
// Handle exactly one message as soon as it is complete (stdin may stay open), then exit.
function maybeHandle(final = false) {
  if (done) return;
  const b = Buffer.concat(chunks);
  if (b.length >= 4 && b.length >= 4 + b.readUInt32LE(0)) { done = true; handle(b); setTimeout(() => process.exit(0), 20); }
  else if (final) { done = true; process.exit(0); }
}
process.stdin.on('data', chunk => { chunks.push(chunk); maybeHandle(); });
process.stdin.on('end', () => maybeHandle(true));

function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function handle(buffer) {
  try {
    if (buffer.length < 4) return;
    const length = buffer.readUInt32LE(0);
    if (length > 64 * 1024 || buffer.length < 4 + length) return;
    const m = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : undefined;
    const record = {
      v: 1, kind: m.kind === 'selection' ? 'selection' : 'page', at: text(m.at, 40) ?? new Date().toISOString(), url: text(m.url, 2048), title: text(m.title, 200),
      description: text(m.description, 300), headings: Array.isArray(m.headings) ? m.headings.slice(0, 8).map(h => text(h, 120)).filter(Boolean) : undefined,
      excerpt: text(m.excerpt, 1500), selection: text(m.selection, 500),
    };
    if (!record.url || !/^https?:\/\//i.test(record.url)) return;
    // Continuum creates this flag only while a session records with page context on; otherwise drop the page.
    if (!existsSync(join(inbox, 'browser-recording.flag'))) { reply({ ok: true, recording: false }); return; }
    mkdirSync(inbox, { recursive: true });
    appendFileSync(join(inbox, 'browser.jsonl'), `${JSON.stringify(record)}\n`);
    reply({ ok: true });
  } catch { reply({ ok: false }); }
}

