import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Field-level AES-256-GCM. Ciphertext format: "v1.<iv>.<tag>.<data>" (base64url parts).
export class FieldCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
    this.key = key;
  }
  encrypt(value) {
    if (value === null || value === undefined) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }
  decrypt(payload) {
    if (payload === null || payload === undefined) return null;
    const [version, iv, tag, data] = String(payload).split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Stored data is corrupt.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
  encryptJson(value) { return this.encrypt(JSON.stringify(value)); }
  decryptJson(payload) { return payload == null ? null : JSON.parse(this.decrypt(payload)); }
}

// Loads or creates the database key. `protection` wraps/unwraps with an OS facility (Electron safeStorage / DPAPI).
// There is no plaintext fallback: if the OS cannot protect the key, the vault does not open.
export async function loadKey(directory, protection) {
  const file = join(directory, 'continuum.key');
  let wrapped;
  try { wrapped = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (wrapped) {
    // unwrap returns the base64 key, or { value, rewrap } when the OS asks for re-encryption under a newer key.
    const unwrapped = await protection.unwrap(wrapped);
    const encoded = typeof unwrapped === 'string' ? unwrapped : unwrapped?.value;
    if (typeof encoded !== 'string') throw new Error('Encryption key could not be unwrapped.');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('Encryption key is corrupt.');
    if (unwrapped?.rewrap) await writeKey(file, key, protection);
    return key;
  }
  const key = randomBytes(32);
  await writeKey(file, key, protection);
  return key;
}

async function writeKey(file, key, protection) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, await protection.wrap(key.toString('base64')));
  await rename(temp, file);
}

export async function removeKey(directory) {
  await rm(join(directory, 'continuum.key'), { force: true });
}
