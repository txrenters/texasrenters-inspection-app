import {
  extractMetroHost,
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
