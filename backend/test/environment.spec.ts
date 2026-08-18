import { validateEnvironment } from '../src/config/environment';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:password@postgres:5432/app',
  AUTH_JWT_SECRET: 'test-signing-secret',
  CORS_ALLOWED_ORIGINS: 'https://inspection.texasrenters.com',
};

describe('production environment validation', () => {
  it('requires the stable encryption key used for Settings-managed provider credentials', () => {
    expect(() => validateEnvironment(productionEnvironment)).toThrow(
      'AI_CREDENTIALS_ENCRYPTION_KEY is required in production',
    );
  });

  it('accepts an openssl-compatible 32-byte base64 encryption key', () => {
    expect(
      validateEnvironment({
        ...productionEnvironment,
        AI_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
      }).AI_CREDENTIALS_ENCRYPTION_KEY,
    ).toBe(Buffer.alloc(32, 11).toString('base64'));
  });

  it('rejects a configured key with the wrong length', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        AI_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(16, 11).toString('base64'),
      }),
    ).toThrow('AI_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes');
  });
});
