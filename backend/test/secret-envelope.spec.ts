import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { openSecret, readEnvelopeKey, sealSecret } from '../src/common/secret-envelope';

const KEY = randomBytes(32);

/**
 * The implementation that used to live in `ai-provider-settings.service.ts`,
 * reproduced verbatim.
 *
 * This is the point of the file. There are AI provider credentials already
 * encrypted in the database by this exact code, and moving the service onto the
 * shared helper is only safe if the two formats are byte-compatible. A unit test
 * of the shared helper against itself would pass just as happily with a format
 * that silently orphaned every stored key.
 */
function legacyEncrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function legacyDecrypt(value: string, key: Buffer) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

describe('secret envelope compatibility with the credentials already stored', () => {
  it('reads a value written by the previous implementation', () => {
    const stored = legacyEncrypt('sk-ant-existing-credential', KEY);
    expect(openSecret(stored, KEY)).toBe('sk-ant-existing-credential');
  });

  it('writes a value the previous implementation can still read', () => {
    // Matters for a rollback: a deploy reverted after new credentials were
    // saved must not leave them unreadable.
    const sealed = sealSecret('sk-ant-new-credential', KEY);
    expect(legacyDecrypt(sealed, KEY)).toBe('sk-ant-new-credential');
  });

  it('produces the same envelope shape', () => {
    const parts = sealSecret('value', KEY).split('.');
    const legacyParts = legacyEncrypt('value', KEY).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(parts[0]).toBe(legacyParts[0]);
  });
});

describe('secret envelope', () => {
  it('refuses a value sealed under another key rather than returning garbage', () => {
    expect(openSecret(sealSecret('secret', KEY), randomBytes(32))).toBeNull();
  });

  it('detects tampering, which is the whole reason for GCM', () => {
    const [version, iv, tag, ciphertext] = sealSecret('secret', KEY).split('.');
    const flipped = Buffer.from(ciphertext!, 'base64url');
    flipped[0] ^= 0xff;
    expect(openSecret([version, iv, tag, flipped.toString('base64url')].join('.'), KEY)).toBeNull();
  });

  it('rejects a key that is not 32 bytes instead of padding it', () => {
    expect(() => readEnvelopeKey('too-short', 'TEST_KEY')).toThrow('TEST_KEY');
  });

  it('accepts hex and base64, which is how the two keys are written', () => {
    expect(readEnvelopeKey(KEY.toString('hex'), 'TEST_KEY')).toEqual(KEY);
    expect(readEnvelopeKey(KEY.toString('base64'), 'TEST_KEY')).toEqual(KEY);
  });

  it('treats an unset key as absent, not as an error', () => {
    expect(readEnvelopeKey(undefined, 'TEST_KEY')).toBeNull();
    expect(readEnvelopeKey('   ', 'TEST_KEY')).toBeNull();
  });
});
