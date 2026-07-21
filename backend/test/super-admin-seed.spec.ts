import {
  ensureSupabaseAuthUser,
  superAdminSeedEnvironmentSchema,
} from '../prisma/seed-super-admin';

describe('development super-admin seed', () => {
  const environment = {
    NODE_ENV: 'development',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    SEED_SUPER_ADMIN_PASSWORD: 'development-only-password',
  };

  it('uses the requested development email and refuses production', () => {
    expect(superAdminSeedEnvironmentSchema.parse(environment).SEED_SUPER_ADMIN_EMAIL).toBe(
      'appdev@texasrenters.com',
    );
    expect(() =>
      superAdminSeedEnvironmentSchema.parse({ ...environment, NODE_ENV: 'production' }),
    ).toThrow('The development super-admin seed cannot run in production.');
  });

  it('creates a confirmed Auth user when the email does not exist', async () => {
    const admin = {
      listUsers: jest.fn().mockResolvedValue({ data: { users: [] }, error: null }),
      createUser: jest.fn().mockResolvedValue({
        data: { user: { id: 'auth-user', email: 'appdev@texasrenters.com' } },
        error: null,
      }),
      updateUserById: jest.fn(),
    };

    await expect(
      ensureSupabaseAuthUser(admin, {
        email: 'appdev@texasrenters.com',
        password: 'development-only-password',
        displayName: 'TexasRenters Super Admin',
      }),
    ).resolves.toMatchObject({ id: 'auth-user' });
    expect(admin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email_confirm: true,
        email: 'appdev@texasrenters.com',
        app_metadata: { must_change_password: true },
      }),
    );
    expect(admin.updateUserById).not.toHaveBeenCalled();
  });

  it('updates an existing Auth user idempotently', async () => {
    const admin = {
      listUsers: jest.fn().mockResolvedValue({
        data: { users: [{ id: 'auth-user', email: 'appdev@texasrenters.wom' }] },
        error: null,
      }),
      createUser: jest.fn(),
      updateUserById: jest.fn().mockResolvedValue({
        data: { user: { id: 'auth-user', email: 'appdev@texasrenters.com' } },
        error: null,
      }),
    };

    await ensureSupabaseAuthUser(admin, {
      email: 'appdev@texasrenters.com',
      legacyEmails: ['appdev@texasrenters.wom'],
      password: 'development-only-password',
      displayName: 'TexasRenters Super Admin',
    });
    expect(admin.updateUserById).toHaveBeenCalledWith(
      'auth-user',
      {
        email: 'appdev@texasrenters.com',
        email_confirm: true,
        user_metadata: { display_name: 'TexasRenters Super Admin' },
      },
    );
    expect(admin.createUser).not.toHaveBeenCalled();
  });

  it('only restores the temporary-password flag when password reset is requested', async () => {
    const admin = {
      listUsers: jest.fn().mockResolvedValue({
        data: {
          users: [
            {
              id: 'auth-user',
              email: 'appdev@texasrenters.com',
              app_metadata: { provider: 'email', must_change_password: false },
            },
          ],
        },
        error: null,
      }),
      createUser: jest.fn(),
      updateUserById: jest.fn().mockResolvedValue({
        data: { user: { id: 'auth-user', email: 'appdev@texasrenters.com' } },
        error: null,
      }),
    };

    await ensureSupabaseAuthUser(admin, {
      email: 'appdev@texasrenters.com',
      password: 'development-only-password',
      displayName: 'TexasRenters Super Admin',
      resetPassword: true,
    });
    expect(admin.updateUserById).toHaveBeenCalledWith(
      'auth-user',
      expect.objectContaining({
        password: 'development-only-password',
        app_metadata: { provider: 'email', must_change_password: true },
      }),
    );
  });
});
