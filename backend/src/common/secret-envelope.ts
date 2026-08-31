import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Reversible storage for third-party credentials we must replay, not verify.
 *
 * API keys we issue are hashed, because the only question ever asked of them is
 * "does this match". A provider's OAuth refresh token is the opposite: we have
 * to send the original value back to them months later, so it must be
 * recoverable — which makes the encryption key, not the column, the thing that
 * protects it.
 *
 * Each provider passes its own key. Sharing one would mean rotating a leaked
 * Jobber secret also invalidates every stored AI credential, which is the kind
 * of coupling that stops people rotating anything.
 */
const ENVELOPE_VERSION = 'v1';

export class SecretEnvelopeKeyError extends Error {
  constructor(readonly variableName: string) {
    super(`${variableName} must be a 32-byte key, hex- or base64-encoded.`);
    this.name = 'SecretEnvelopeKeyError';
  }
}

/** Accepts hex or base64; anything that is not exactly 32 bytes is refused
 * rather than padded, because a short key silently weakens every value. */
export function readEnvelopeKey(value: string | undefined, variableName: string): Buffer | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const key = /^[a-f\d]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new SecretEnvelopeKeyError(variableName);
  return key;
}

export function sealSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Returns null rather than throwing on anything unreadable.
 *
 * A failed decrypt means the key was rotated or the row predates it, and the
 * only correct response is to treat the connection as needing re-authorization.
 * Throwing here would turn that into a 500 on a background sync instead.
 */
export function openSecret(value: string, key: Buffer): string | null {
  try {
    const [version, iv, tag, ciphertext] = value.split('.');
    if (version !== ENVELOPE_VERSION || !iv || !tag || !ciphertext) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
