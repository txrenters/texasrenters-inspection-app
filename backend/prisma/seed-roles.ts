import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { isPermissionKey, type PermissionKey } from '@texasrenters/shared';

const defaultOrganizationId = '10000000-0000-4000-8000-000000000001';

export const roleSeedEnvironmentSchema = z.object({
  SEED_ROLES_ORGANIZATION_ID: z.string().uuid().default(defaultOrganizationId),
});

/**
 * Starter roles, not a fixed hierarchy.
 *
 * The permission catalog says this deliberately: "there are no preconfigured
 * roles ... New users start with zero permissions until an admin assigns a role
 * that grants them." That design is intact — these are ordinary rows an
 * administrator can rename, re-scope or delete, and nothing in the application
 * looks for them by name.
 *
 * They exist because the alternative is worse. A fresh organization opens the
 * Roles page, finds it empty, and has to derive five sensible permission sets
 * from a catalog of twenty-four keys before it can give anyone access at all.
 *
 * SYSTEM_ADMIN is deliberately absent. It is the bootstrap principal and
 * `resolveEffectivePermissions` already returns the entire catalog for it, so a
 * role by that name would grant nothing extra while implying the break-glass
 * account is something an administrator can hand out.
 */
const ROLE_SEEDS: { name: string; description: string; permissions: PermissionKey[] }[] = [
  {
    name: 'Property Administrator',
    description:
      'Day-to-day operations: schedule and assign inspections, manage properties and technicians, and finalize completed work.',
    permissions: [
      'dashboard:read',
      'properties:read',
      'properties:manage',
      'inspections:read',
      'inspections:manage',
      'inspections:assign',
      'inspections:finalize',
      'technicians:read',
      'technicians:manage',
      'technicians:provision',
      'findings:read',
      'reports:share',
      'integrations:read',
    ],
  },
  {
    name: 'Inspection Coordinator',
    description:
      'Schedules work and keeps technicians moving. Can assign and reschedule, but cannot finalize an inspection or alter the findings that follow from it.',
    permissions: [
      'dashboard:read',
      'properties:read',
      'inspections:read',
      'inspections:manage',
      'inspections:assign',
      'technicians:read',
      'findings:read',
    ],
  },
  {
    name: 'Condition Reviewer',
    description:
      'Reviews AI findings and move-in/move-out comparisons. Reads evidence and rules on it; does not decide money.',
    permissions: [
      'dashboard:read',
      'properties:read',
      'inspections:read',
      'findings:read',
      'findings:review',
      'comparisons:review',
    ],
  },
  {
    name: 'Charge Approver',
    description:
      'Decides tenant charges. Separated from Condition Reviewer on purpose — the person who judges the damage should not be the only person who prices it.',
    permissions: [
      'dashboard:read',
      'properties:read',
      'inspections:read',
      'findings:read',
      'charges:review',
      'charges:configure',
    ],
  },
  {
    name: 'Read Only',
    description:
      'Sees the workspace and its records, changes nothing. Suitable for an owner, an auditor, or somebody being onboarded.',
    permissions: [
      'dashboard:read',
      'properties:read',
      'inspections:read',
      'technicians:read',
      'findings:read',
      'users:read',
      'roles:read',
      'integrations:read',
    ],
  },
];

export async function seedRoles(environment: NodeJS.ProcessEnv = process.env) {
  const config = roleSeedEnvironmentSchema.parse(environment);
  const prisma = new PrismaClient({
    datasources: { db: { url: environment.DIRECT_URL ?? environment.DATABASE_URL } },
  });
  try {
    // Fails loudly rather than creating an orphan role against an organization
    // that does not exist — the unique key is (organizationId, name), so a typo
    // would otherwise produce a second invisible set.
    const organization = await prisma.organization.findUnique({
      where: { id: config.SEED_ROLES_ORGANIZATION_ID },
      select: { id: true, name: true },
    });
    if (!organization)
      throw new Error(
        `No organization ${config.SEED_ROLES_ORGANIZATION_ID}. Run the super-admin seed first.`,
      );

    const results: { name: string; permissions: number; created: boolean }[] = [];
    for (const seed of ROLE_SEEDS) {
      // Guards against a key being renamed in the catalog and silently
      // surviving here as a permission that grants nothing.
      const unknown = seed.permissions.filter((permission) => !isPermissionKey(permission));
      if (unknown.length)
        throw new Error(`Role "${seed.name}" names unknown permissions: ${unknown.join(', ')}.`);

      const existing = await prisma.role.findUnique({
        where: {
          organizationId_name: { organizationId: organization.id, name: seed.name },
        },
        select: { id: true },
      });
      // Only the description is refreshed on re-run. Permissions are left alone
      // because an administrator may have tightened a role deliberately, and a
      // seed that resets that is a silent privilege change.
      await prisma.role.upsert({
        where: {
          organizationId_name: { organizationId: organization.id, name: seed.name },
        },
        update: { description: seed.description },
        create: {
          organizationId: organization.id,
          name: seed.name,
          description: seed.description,
          permissions: seed.permissions,
        },
      });
      results.push({
        name: seed.name,
        permissions: seed.permissions.length,
        created: !existing,
      });
    }
    return { organization, roles: results };
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  void seedRoles()
    .then((result) => {
      console.log(`Starter roles seeded for ${result.organization.name}.`);
      for (const role of result.roles)
        console.log(
          `  ${role.created ? 'created' : 'kept   '}  ${role.name.padEnd(24)}${role.permissions} permissions`,
        );
      console.log('\n  Existing roles keep their permissions; only descriptions refresh.');
      console.log('  SYSTEM_ADMIN is not among these — it already holds the whole catalog.');
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Role seed failed.');
      process.exit(1);
    });
