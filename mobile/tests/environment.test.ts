import {
  extractMetroHost,
  resolveDeviceApiBaseUrl,
  resolveDeviceApiBaseUrls,
  resolveRealtimeBaseUrls,
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
