import {
  extractMetroHost,
  resolveDeviceApiBaseUrl,
  resolveDeviceApiBaseUrls,
  resolveRealtimeBaseUrls,
  validateApiBaseUrl,
} from '../src/config/environment';

describe('mobile v2 REST environment', () => {
  it('extracts the active Metro LAN host', () => {
    expect(extractMetroHost('exp://192.168.1.24:8082')).toBe('192.168.1.24');
  });

  it('maps localhost to the physical device LAN API without hard-coding an IP', () => {
    expect(
      resolveDeviceApiBaseUrl(
        'http://localhost:3000/api/v1',
        '192.168.1.24:8082',
        'ios',
      ),
    ).toBe('http://192.168.1.24:3000/api/v1');
  });

  it('never treats the Expo bundle tunnel as the REST backend', () => {
    const candidates = resolveDeviceApiBaseUrls(
      'http://localhost:3000/api/v1',
      'example-anonymous-8082.exp.direct',
      'ios',
      'http://192.168.1.24:3000/api/v1',
    );
    expect(candidates).toEqual(['http://192.168.1.24:3000/api/v1']);
    expect(resolveRealtimeBaseUrls(candidates)).toEqual(['http://192.168.1.24:3000']);
  });

  it('keeps a separately configured HTTPS API while Metro uses a tunnel', () => {
    const apiUrl = 'https://api.example.ngrok-free.dev';
    expect(
      resolveDeviceApiBaseUrls(
        apiUrl,
        'example-anonymous-8082.exp.direct',
        'ios',
        null,
      ),
    ).toEqual([apiUrl]);
  });
});

describe('API base URL validation', () => {
  const reasonFor = (value: string | null, env: Parameters<typeof validateApiBaseUrl>[1]) => {
    const result = validateApiBaseUrl(value, env);
    return result.ok ? null : result.reason;
  };

  it('lets development use whatever the developer is running', () => {
    // localhost, a LAN IP and an adb-reverse tunnel are all correct here, and
    // an unset value just means the Metro host will be resolved instead.
    for (const value of [null, 'http://localhost:3000/api/v1', 'http://192.168.1.24:3000/api/v1'])
      expect(validateApiBaseUrl(value, 'development')).toEqual({ ok: true });
  });

  it('catches a production build made without its environment variables', () => {
    // The failure this exists for. EXPO_PUBLIC_* is inlined at build time, so a
    // release built without them has no API address at all — it installs,
    // launches, and reports only network errors. Production was previously
    // exempt from validation entirely, so the one build nobody can hot-fix was
    // the only one nothing checked.
    const reason = reasonFor(null, 'production');
    expect(reason).toMatch(/EXPO_PUBLIC_API_BASE_URL/);
    // Names where to fix it, not merely that it is wrong.
    expect(reason).toMatch(/EAS build profile/);
  });

  it('rejects an address the phone cannot reach over cellular, in production', () => {
    expect(reasonFor('http://api.texasrenters.com', 'production')).toMatch(/HTTPS/);
    expect(reasonFor('https://localhost:3000', 'production')).toMatch(/the phone itself/);
    expect(reasonFor('https://backend:3000', 'production')).toMatch(/Docker service name/);
    expect(reasonFor('https://192.168.1.24:3000', 'production')).toMatch(/private LAN/);
    expect(reasonFor('not a url', 'production')).toMatch(/not a valid URL/);
  });

  it('accepts a public HTTPS host in production and remote beta', () => {
    for (const env of ['production', 'remote-beta'] as const)
      expect(validateApiBaseUrl('https://api.texasrenters.com/api/v1', env)).toEqual({ ok: true });
  });

  it('keeps the remote-beta wording pointed at the start helper', () => {
    // The two environments fail for the same reason but are fixed in different
    // places: remote beta by re-running the helper that injects the tunnel URL,
    // production by setting the EAS variables.
    expect(reasonFor(null, 'remote-beta')).toMatch(/start helper/);
    expect(reasonFor(null, 'production')).not.toMatch(/start helper/);
  });
});
