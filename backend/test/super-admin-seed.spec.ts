import { superAdminSeedEnvironmentSchema } from '../prisma/seed-super-admin';

/**
 * The three tests that lived here covered `ensureSupabaseAuthUser`, which
 * created and updated a Supabase Auth user. That function is gone: the seed
 * writes an `AuthCredential` through Prisma now, so there is no Auth admin API
 * left to stub.
 *
 * What remains worth pinning is the environment contract — in particular the
 * production refusal, which is the only thing standing between this seed and a
 * known password on a live database.
 */
describe('development super-admin seed', () => {
  const environment = {
    NODE_ENV: 'development',
    SEED_SUPER_ADMIN_EMAIL: 'appdev@texasrenters.com',
    SEED_SUPER_ADMIN_PASSWORD: 'Sup3r-Admin!',
    SEED_SUPER_ADMIN_ORGANIZATION_ID: '10000000-0000-4000-8000-000000000001',
  };

  it('uses the requested development email and refuses production', () => {
    expect(superAdminSeedEnvironmentSchema.parse(environment).SEED_SUPER_ADMIN_EMAIL).toBe(
      'appdev@texasrenters.com',
    );
    // The seed sets a password someone chose in an env file. On a production
    // database that is a backdoor, so the refusal is the safety property here.
    expect(() =>
      superAdminSeedEnvironmentSchema.parse({ ...environment, NODE_ENV: 'production' }),
    ).toThrow();
  });

  it('defaults the password reset to off', () => {
    // Re-running the seed to repair a membership must not silently change the
    // password of an account somebody is signing in with.
    expect(
      superAdminSeedEnvironmentSchema.parse(environment).SEED_SUPER_ADMIN_RESET_PASSWORD,
    ).not.toBe('true');
  });
});
