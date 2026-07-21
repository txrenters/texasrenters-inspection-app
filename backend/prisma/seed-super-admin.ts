import { PrismaClient, UserRole } from '@prisma/client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const defaultOrganizationId = '10000000-0000-4000-8000-000000000001';

export const superAdminSeedEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SEED_SUPER_ADMIN_EMAIL: z.string().email().default('appdev@texasrenters.com'),
    SEED_SUPER_ADMIN_LEGACY_EMAILS: z.string().default('appdev@texasrenters.wom'),
    SEED_SUPER_ADMIN_PASSWORD: z.string().min(1),
    SEED_SUPER_ADMIN_RESET_PASSWORD: z.enum(['true', 'false']).default('false'),
    SEED_SUPER_ADMIN_DISPLAY_NAME: z.string().min(1).default('TexasRenters Super Admin'),
    SEED_SUPER_ADMIN_ORGANIZATION_ID: z.string().uuid().default(defaultOrganizationId),
    SEED_SUPER_ADMIN_ORGANIZATION_NAME: z
      .string()
      .min(1)
      .default('TexasRenters Development'),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production')
      context.addIssue({
        code: 'custom',
        message: 'The development super-admin seed cannot run in production.',
        path: ['NODE_ENV'],
      });
  });

interface SeedAuthUser {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
}

interface SeedAuthAdmin {
  listUsers(options: {
    page: number;
    perPage: number;
  }): Promise<{ data: { users: SeedAuthUser[] }; error: { message: string } | null }>;
  createUser(attributes: {
    email: string;
    password: string;
    email_confirm: boolean;
    user_metadata: { display_name: string };
    app_metadata: { must_change_password: boolean };
  }): Promise<{ data: { user: SeedAuthUser | null }; error: { message: string } | null }>;
  updateUserById(
    id: string,
    attributes: {
      email: string;
      password?: string;
      email_confirm: boolean;
      user_metadata: { display_name: string };
      app_metadata?: Record<string, unknown>;
    },
  ): Promise<{ data: { user: SeedAuthUser | null }; error: { message: string } | null }>;
}

function applicationDatabaseSeedError(error: { code?: string } | null, fallback: string) {
  if (error?.code === 'PGRST205')
    return new Error(
      'The Supabase foundation schema is missing. Apply the foundation and canonical migrations before rerunning this seed.',
    );
  return new Error(fallback);
}

export async function ensureSupabaseAuthUser(
  admin: SeedAuthAdmin,
  input: {
    email: string;
    legacyEmails?: string[];
    password: string;
    displayName: string;
    resetPassword?: boolean;
  },
) {
  const perPage = 1000;
  let existing: SeedAuthUser | undefined;
  let legacyExisting: SeedAuthUser | undefined;
  const legacyEmails = new Set(input.legacyEmails?.map((email) => email.toLowerCase()) ?? []);

  for (let page = 1; page <= 100; page += 1) {
    const result = await admin.listUsers({ page, perPage });
    if (result.error) throw new Error('Unable to list Supabase Auth users for the seed.');
    existing = result.data.users.find(
      (user) => user.email?.toLowerCase() === input.email.toLowerCase(),
    );
    legacyExisting ??= result.data.users.find((user) =>
      legacyEmails.has(user.email?.toLowerCase() ?? ''),
    );
    if (existing || result.data.users.length < perPage) break;
  }
  existing ??= legacyExisting;

  const profileAttributes = {
    email: input.email,
    email_confirm: true,
    user_metadata: { display_name: input.displayName },
  };
  const result = existing
    ? await admin.updateUserById(existing.id, {
        ...profileAttributes,
        ...(input.resetPassword
          ? {
              password: input.password,
              app_metadata: {
                ...existing.app_metadata,
                must_change_password: true,
              },
            }
          : {}),
      })
    : await admin.createUser({
        ...profileAttributes,
        password: input.password,
        app_metadata: { must_change_password: true },
      });
  if (result.error || !result.data.user)
    throw new Error(
      existing
        ? 'Unable to update the Supabase Auth user for the seed.'
        : 'Unable to create the Supabase Auth user for the seed.',
    );
  return result.data.user;
}

export async function upsertSystemAdminProfile(
  supabase: SupabaseClient,
  input: {
    authUserId: string;
    email: string;
    displayName: string;
    organizationId: string;
    organizationName: string;
  },
) {
  const organization = await supabase
    .from('Organization')
    .upsert(
      { id: input.organizationId, name: input.organizationName },
      { onConflict: 'id' },
    );
  if (organization.error)
    throw applicationDatabaseSeedError(
      organization.error,
      'Unable to seed the development organization.',
    );

  const authProfile = await supabase
    .from('UserProfile')
    .select('id, authUserId, email')
    .eq('authUserId', input.authUserId)
    .maybeSingle();
  if (authProfile.error)
    throw applicationDatabaseSeedError(
      authProfile.error,
      'Unable to find the seeded application profile.',
    );

  const emailProfile = authProfile.data
    ? { data: null, error: null }
    : await supabase
        .from('UserProfile')
        .select('id, authUserId, email')
        .eq('email', input.email)
        .maybeSingle();
  if (emailProfile.error)
    throw applicationDatabaseSeedError(
      emailProfile.error,
      'Unable to find the seeded application profile.',
    );

  const existing = authProfile.data ?? emailProfile.data;
  const profileResult = existing
    ? await supabase
        .from('UserProfile')
        .update({
          authUserId: input.authUserId,
          email: input.email,
          displayName: input.displayName,
          isActive: true,
          updatedAt: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id')
        .single()
    : await supabase
        .from('UserProfile')
        .insert({
          authUserId: input.authUserId,
          email: input.email,
          displayName: input.displayName,
          isActive: true,
        })
        .select('id')
        .single();
  if (profileResult.error || !profileResult.data)
    throw applicationDatabaseSeedError(
      profileResult.error,
      'Unable to seed the application profile.',
    );

  const membership = await supabase.from('OrganizationMember').upsert(
    {
      organizationId: input.organizationId,
      userProfileId: profileResult.data.id,
      role: UserRole.SYSTEM_ADMIN,
    },
    { onConflict: 'organizationId,userProfileId,role', ignoreDuplicates: true },
  );
  if (membership.error)
    throw applicationDatabaseSeedError(
      membership.error,
      'Unable to grant the SYSTEM_ADMIN membership.',
    );
  return profileResult.data;
}

export async function upsertSystemAdminProfileWithPrisma(
  prisma: PrismaClient,
  input: {
    authUserId: string;
    email: string;
    displayName: string;
    organizationId: string;
    organizationName: string;
  },
) {
  return prisma.$transaction(async (transaction) => {
    await transaction.organization.upsert({
      where: { id: input.organizationId },
      update: { name: input.organizationName },
      create: { id: input.organizationId, name: input.organizationName },
    });
    const existing = await transaction.userProfile.findFirst({
      where: {
        OR: [{ authUserId: input.authUserId }, { email: input.email }],
      },
    });
    const profile = existing
      ? await transaction.userProfile.update({
          where: { id: existing.id },
          data: {
            authUserId: input.authUserId,
            email: input.email,
            displayName: input.displayName,
            isActive: true,
          },
        })
      : await transaction.userProfile.create({
          data: {
            authUserId: input.authUserId,
            email: input.email,
            displayName: input.displayName,
            isActive: true,
          },
        });
    await transaction.organizationMember.upsert({
      where: {
        organizationId_userProfileId_role: {
          organizationId: input.organizationId,
          userProfileId: profile.id,
          role: UserRole.SYSTEM_ADMIN,
        },
      },
      update: {},
      create: {
        organizationId: input.organizationId,
        userProfileId: profile.id,
        role: UserRole.SYSTEM_ADMIN,
      },
    });
    return profile;
  });
}

export async function seedSuperAdmin(environment: NodeJS.ProcessEnv = process.env) {
  const config = superAdminSeedEnvironmentSchema.parse(environment);
  const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authUser = await ensureSupabaseAuthUser(supabase.auth.admin, {
    email: config.SEED_SUPER_ADMIN_EMAIL,
    legacyEmails: config.SEED_SUPER_ADMIN_LEGACY_EMAILS.split(',')
      .map((email) => email.trim())
      .filter(Boolean),
    password: config.SEED_SUPER_ADMIN_PASSWORD,
    displayName: config.SEED_SUPER_ADMIN_DISPLAY_NAME,
    resetPassword: config.SEED_SUPER_ADMIN_RESET_PASSWORD === 'true',
  });
  const prisma = new PrismaClient();
  try {
    return await upsertSystemAdminProfileWithPrisma(prisma, {
      authUserId: authUser.id,
      email: config.SEED_SUPER_ADMIN_EMAIL,
      displayName: config.SEED_SUPER_ADMIN_DISPLAY_NAME,
      organizationId: config.SEED_SUPER_ADMIN_ORGANIZATION_ID,
      organizationName: config.SEED_SUPER_ADMIN_ORGANIZATION_NAME,
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  void seedSuperAdmin()
    .then(() => console.log('Development super-admin seed completed.'))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Development super-admin seed failed.');
      process.exit(1);
    });
