import { buildEntry, redact } from '../src/lib/error-log';

const entry = (error: unknown, source = 'test') =>
  buildEntry({ error, source, at: '2026-07-31T00:00:00.000Z', id: 'fixed-id' });

describe('redact', () => {
  it('removes JWTs, which appear verbatim in Supabase auth errors', () => {
    const token =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const output = redact(`Request failed with ${token} attached`);
    expect(output).not.toContain(token);
    expect(output).toContain('[redacted-jwt]');
  });

  it('removes credential-shaped key/value pairs regardless of case', () => {
    expect(redact('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redact('password=hunter2')).not.toContain('hunter2');
    expect(redact('APIKEY: sk_live_9999')).not.toContain('sk_live_9999');
  });

  it('removes tokens carried in query strings', () => {
    const output = redact('GET /callback?access_token=abc123&next=/home');
    expect(output).not.toContain('abc123');
    // Non-secret context must survive, or the report stops being useful.
    expect(output).toContain('next=/home');
  });

  it('leaves ordinary error text intact', () => {
    const message = 'Cannot read properties of undefined (reading ‘body’)';
    expect(redact(message)).toBe(message);
  });
});

describe('buildEntry', () => {
  it('captures an Error message and a truncated stack', () => {
    const error = new Error('Room upload failed');
    error.stack = ['Error: Room upload failed', ...Array.from({ length: 20 }, (_, i) => `  at frame${i}`)].join('\n');
    const result = entry(error);
    expect(result.message).toBe('Room upload failed');
    // A 20-frame native stack is noise in a chat message.
    expect(result.stack?.split('\n').length).toBeLessThanOrEqual(6);
  });

  it('handles thrown strings and objects without losing the report', () => {
    expect(entry('plain failure').message).toBe('plain failure');
    expect(entry({ code: 500 }).message).toContain('500');
  });

  it('survives a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => entry(circular)).not.toThrow();
    expect(entry(circular).message.length).toBeGreaterThan(0);
  });

  it('never stores an empty message', () => {
    // "Unknown error" is still actionable; a blank row is not.
    expect(entry(new Error('')).message).toBe('Unknown error');
  });

  it('redacts before persisting, not at display time', () => {
    // The log is written to device storage and pasted into messages, so a
    // secret must never reach disk in the first place.
    const result = entry(new Error('failed with Authorization: Bearer sk_live_abc'));
    expect(result.message).not.toContain('sk_live_abc');
  });

  it('caps message length so one huge error cannot crowd out the rest', () => {
    expect(entry(new Error('x'.repeat(5_000))).message.length).toBeLessThanOrEqual(500);
  });

  it('records the source and fatality so a crash is distinguishable from a warning', () => {
    const result = buildEntry({
      error: new Error('boom'),
      source: 'render',
      fatal: true,
      at: '2026-07-31T00:00:00.000Z',
      id: 'x',
    });
    expect(result).toMatchObject({ source: 'render', fatal: true });
  });
});
