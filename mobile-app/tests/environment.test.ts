import {
  extractMetroHost,
  validateRemoteBetaApiUrl,
  resolveEasProjectId,
  resolveDeviceApiBaseUrl,
  resolveDeviceApiBaseUrls,
  resolveRealtimeBaseUrls,
} from '../src/config/environment';

describe('resolveEasProjectId', () => {
  it('returns the first non-empty string and trims it', () => {
    expect(resolveEasProjectId(undefined, '  project-id  ', 'fallback')).toBe('project-id');
  });

  it('rejects object-shaped and empty project IDs', () => {
    expect(resolveEasProjectId({}, null, '', '   ')).toBeUndefined();
  });
});

describe('mobile environment', () => {
  it('extracts Metro hosts from raw, HTTP, and Expo URLs', () => {
    expect(extractMetroHost('192.168.1.24:8081')).toBe('192.168.1.24');
    expect(extractMetroHost('http://192.168.1.24:8081')).toBe('192.168.1.24');
    expect(extractMetroHost('exp://192.168.1.24:8081')).toBe('192.168.1.24');
  });

  it('maps localhost API URLs to the Expo LAN host on a physical device', () => {
    expect(resolveDeviceApiBaseUrl('http://localhost:3000', '192.168.1.24:8081', 'android')).toBe(
      'http://192.168.1.24:3000',
    );
  });

  it('maps localhost API URLs when Expo reports an exp:// host URI', () => {
    expect(
      resolveDeviceApiBaseUrl('http://localhost:3000/api/v1', 'exp://192.168.1.24:8081', 'ios'),
    ).toBe('http://192.168.1.24:3000/api/v1');
  });

  it('keeps localhost for web and preserves explicitly configured remote hosts', () => {
    expect(resolveDeviceApiBaseUrl('http://localhost:3000', '192.168.1.24:8081', 'web')).toBe(
      'http://localhost:3000',
    );
    expect(resolveDeviceApiBaseUrl('https://api.example.com', '192.168.1.24:8081', 'ios')).toBe(
      'https://api.example.com',
    );
  });

  it('routes tunnel API calls through the HTTPS Metro proxy', () => {
    expect(
      resolveDeviceApiBaseUrl(
        'http://localhost:3000/api/v1',
        'example-anonymous-8081.exp.direct',
        'ios',
      ),
    ).toBe('https://example-anonymous-8081.exp.direct/api/v1');
  });

  it('keeps a private LAN fallback behind the Expo tunnel URL', () => {
    expect(
      resolveDeviceApiBaseUrls(
        'http://localhost:3000/api/v1',
        'example-anonymous-8081.exp.direct',
        'ios',
        'http://192.168.123.48:3000/api/v1',
      ),
    ).toEqual([
      'https://example-anonymous-8081.exp.direct/api/v1',
      'http://192.168.123.48:3000/api/v1',
    ]);
  });

  it('keeps localhost first for adb-reverse devices, with LAN candidates after', () => {
    expect(
      resolveDeviceApiBaseUrls(
        'http://localhost:3000/api/v1',
        '192.168.123.44:8081',
        'android',
        'http://192.168.123.44:3000/api/v1',
        true,
      ),
    ).toEqual([
      'http://localhost:3000/api/v1',
      'http://192.168.123.44:3000/api/v1',
    ]);
  });

  it('never prefers localhost on iOS — adb reverse does not exist there', () => {
    // The call site gates the flag by platform; an iOS device with the flag
    // off must resolve to the Metro LAN host, not the phone's own localhost.
    expect(
      resolveDeviceApiBaseUrls(
        'http://localhost:3000/api/v1',
        '192.168.123.44:8081',
        'ios',
        'http://192.168.123.44:3000/api/v1',
        false,
      ),
    ).toEqual(['http://192.168.123.44:3000/api/v1']);
  });

  it('rejects public fallbacks and does not alter production API URLs', () => {
    expect(
      resolveDeviceApiBaseUrls(
        'https://api.example.com',
        'example-anonymous-8081.exp.direct',
        'ios',
        'http://192.168.123.48:3000',
      ),
    ).toEqual(['https://api.example.com']);
    expect(
      resolveDeviceApiBaseUrls(
        'http://localhost:3000',
        'example-anonymous-8081.exp.direct',
        'ios',
        'https://public.example.com',
      ),
    ).toEqual(['https://example-anonymous-8081.exp.direct']);
  });

  it('uses direct API origins for realtime and skips Metro tunnel hosts', () => {
    expect(
      resolveRealtimeBaseUrls([
        'https://example-anonymous-8081.exp.direct/api/v1',
        'http://192.168.123.48:3000/api/v1',
      ]),
    ).toEqual(['http://192.168.123.48:3000']);
    expect(resolveRealtimeBaseUrls(['https://api.example.com/api/v1'])).toEqual([
      'https://api.example.com',
    ]);
  });
});

describe('validateRemoteBetaApiUrl', () => {
  const reject = (url: string | null) => {
    const result = validateRemoteBetaApiUrl(url, 'remote-beta');
    expect(result.ok).toBe(false);
    return result.ok ? '' : result.reason;
  };

  it('accepts a public HTTPS tunnel URL', () => {
    expect(validateRemoteBetaApiUrl('https://abc123.ngrok-free.app', 'remote-beta')).toEqual({
      ok: true,
    });
  });

  it('requires the variable to be present', () => {
    expect(reject(null)).toMatch(/required/i);
  });

  it('rejects plain HTTP', () => {
    expect(reject('http://abc123.ngrok-free.app')).toMatch(/HTTPS/i);
  });

  it.each(['https://localhost:3000', 'https://127.0.0.1:3000', 'https://0.0.0.0:3000'])(
    'rejects loopback address %s',
    (url) => {
      // On a technician's phone these resolve to the phone itself, not the
      // developer machine, so the request fails with a confusing network error.
      expect(reject(url)).toMatch(/phone itself/i);
    },
  );

  it.each(['https://10.0.0.5:3000', 'https://192.168.1.20:3000', 'https://172.16.4.4:3000'])(
    'rejects private LAN address %s',
    (url) => {
      expect(reject(url)).toMatch(/private LAN|unreachable/i);
    },
  );

  it('rejects a Docker service hostname', () => {
    expect(reject('https://backend:3000')).toMatch(/Docker service/i);
  });

  it('rejects an invalid URL', () => {
    expect(reject('not a url')).toMatch(/not a valid URL/i);
  });

  it('does not constrain non-remote-beta environments', () => {
    // LAN and adb-reverse workflows legitimately use these addresses.
    expect(validateRemoteBetaApiUrl('http://localhost:3000', 'development')).toEqual({ ok: true });
    expect(validateRemoteBetaApiUrl(null, 'development')).toEqual({ ok: true });
  });
});
