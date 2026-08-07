import { PrismaClient, UserRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { hash } from 'bcryptjs';
import { z } from 'zod';

const defaultOrganizationId = '10000000-0000-4000-8000-000000000001';

export const superAdminSeedEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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

/**
 * Bootstrap the development super-admin against our own credential store.
 *
 * Was Supabase Auth. This is the only way to get a usable account onto a fresh
 * database, so it had to move with everything else — otherwise a clean install
 * has a profile nobody can sign in as.
 *
 * Writes through Prisma on the OWNER connection: the credential and the profile
 * are created together, and the seed is deliberately cross-organization, which
 * the least-privilege application role is not permitted to be.
 */
export async function seedSuperAdmin(environment: NodeJS.ProcessEnv = process.env) {
  const config = superAdminSeedEnvironmentSchema.parse(environment);
  const prisma = new PrismaClient({
    datasources: { db: { url: environment.DIRECT_URL ?? environment.DATABASE_URL } },
  });
  try {
    const email = config.SEED_SUPER_ADMIN_EMAIL.trim().toLowerCase();
    const existing = await prisma.authCredential.findUnique({
      where: { email },
      select: { authUserId: true },
    });
    const authUserId = existing?.authUserId ?? randomUUID();
    const passwordHash = await hash(config.SEED_SUPER_ADMIN_PASSWORD, 10);

    const profile = await upsertSystemAdminProfileWithPrisma(prisma, {
      authUserId,
      email,
      displayName: config.SEED_SUPER_ADMIN_DISPLAY_NAME,
      organizationId: config.SEED_SUPER_ADMIN_ORGANIZATION_ID,
      organizationName: config.SEED_SUPER_ADMIN_ORGANIZATION_NAME,
    });

    // The credential comes second: it references UserProfile.authUserId, so the
    // profile has to exist first.
    //
    // An existing password is left alone unless the seed is asked to reset it.
    // Re-running this to repair a membership should not silently change the
    // password of an account someone is using.
    await prisma.authCredential.upsert({
      where: { authUserId },
      create: { authUserId, email, passwordHash, mustChangePassword: false },
      update:
        config.SEED_SUPER_ADMIN_RESET_PASSWORD === 'true'
          ? { email, passwordHash, mustChangePassword: false }
          : { email },
    });

    return profile;
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
