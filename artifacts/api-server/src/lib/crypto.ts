import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// AES-256-GCM at-rest encryption for OAuth client secrets and access/refresh
// tokens. The key is derived from SESSION_SECRET via HKDF-SHA256 with a fixed
// app-scoped info label, so rotating SESSION_SECRET will rotate this key too
// (and invalidate previously stored ciphertexts — we surface that as an auth
// error and the user simply reconnects the credential).
//
// Envelope format (base64): iv(12B) || ciphertext || tag(16B).

const KEY_INFO = "vjchat:credentials:v1";
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env["SESSION_SECRET"];
  if (!secret) {
    throw new Error("SESSION_SECRET env var is required for crypto");
  }
  // HKDF: salt empty, ikm = SESSION_SECRET, info = app label, len = 32B.
  const derived = hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 32);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

export function encryptString(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptString(envelope: string): string {
  const key = getKey();
  const buf = Buffer.from(envelope, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
