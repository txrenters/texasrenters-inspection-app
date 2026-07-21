import { allowedCorsOrigins } from '../src/main';

describe('shared backend CORS configuration', () => {
  it('supports both web and mobile development origins', () => {
    expect(allowedCorsOrigins({ NODE_ENV: 'development' })).toEqual(
      expect.arrayContaining([
        'http://localhost:3001',
        'http://localhost:5454',
        'http://localhost:8081',
        'http://localhost:19006',
      ]),
    );
  });

  it('keeps the admin origin when local configuration only names mobile origins', () => {
    expect(
      allowedCorsOrigins({
        NODE_ENV: 'development',
        CORS_ORIGINS: 'http://localhost:8081,http://localhost:19006',
      }),
    ).toContain('http://localhost:5454');
  });

  it('merges application-specific origins without duplicates', () => {
    expect(
      allowedCorsOrigins({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://admin.texasrenters.com',
        WEB_APP_ORIGIN: 'https://admin.texasrenters.com',
        MOBILE_APP_ORIGIN: 'https://mobile.texasrenters.com',
      }),
    ).toEqual(['https://admin.texasrenters.com', 'https://mobile.texasrenters.com']);
  });

  it('rejects a credentialed wildcard in production', () => {
    expect(() => allowedCorsOrigins({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      'CORS wildcard origins are not allowed',
    );
  });
});
