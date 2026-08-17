/**
 * Creates the first administrator on a fresh production database.
 *
 * A clean install has no users at all. Migrations create the tables and nothing
 * else — the login page then correctly refuses everyone, and there is no way
 * in. `prisma/seed-super-admin.ts` cannot fill that gap: it refuses outright
 * when NODE_ENV is production, and its defaults are a development address in an
 * organisation called "TexasRenters Development". Both of those are right for
 * what it is. This is the production counterpart.
 *
 * It is a bootstrap, not a seed, and the difference is the guard below: it
 * refuses if *any* user profile already exists. That makes it usable exactly
 * once, on an empty database. Re-running it after go-live is a no-op rather
 * than a way to mint an administrator or reset somebody's password, which is
 * what it would be if it upserted.
 *
 *   docker compose ... run --rm bootstrap-admin
 *
 * Reads, and requires:
 *   BOOTSTRAP_ADMIN_EMAIL
 *   BOOTSTRAP_ADMIN_PASSWORD           replaced at first sign-in, see below
 *   BOOTSTRAP_ADMIN_DISPLAY_NAME
 *   BOOTSTRAP_ADMIN_ORGANIZATION_NAME
 * Optional:
 *   BOOTSTRAP_ADMIN_ORGANIZATION_ID    a uuid; generated when absent
 */
import { randomUUID } from 'node:crypto';

import { PrismaClient, UserRole } from '@prisma/client';
import { hash } from 'bcryptjs';
import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_MESSAGES,
  PASSWORD_PATTERNS,
} from '@texasrenters/shared';

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

const email = required('BOOTSTRAP_ADMIN_EMAIL').toLowerCase();
const password = required('BOOTSTRAP_ADMIN_PASSWORD');
const displayName = required('BOOTSTRAP_ADMIN_DISPLAY_NAME');
const organizationName = required('BOOTSTRAP_ADMIN_ORGANIZATION_NAME');
const organizationId = process.env.BOOTSTRAP_ADMIN_ORGANIZATION_ID?.trim() || randomUUID();

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('BOOTSTRAP_ADMIN_EMAIL is not an address.');

/**
 * The same rules the change-password screen enforces, imported rather than
 * restated. They drifted twice when they were written out separately — the API
 * asked for twelve characters while the app checked eight — and a bootstrap
 * password that the product would refuse is a trap waiting at first sign-in.
 */
for (const [check, message] of [
  [password.length >= MINIMUM_PASSWORD_LENGTH, PASSWORD_MESSAGES.tooShort],
  [password.length <= MAXIMUM_PASSWORD_LENGTH, PASSWORD_MESSAGES.tooLong],
  [PASSWORD_PATTERNS.capital.test(password), PASSWORD_MESSAGES.capital],
  [PASSWORD_PATTERNS.number.test(password), PASSWORD_MESSAGES.number],
  [PASSWORD_PATTERNS.special.test(password), PASSWORD_MESSAGES.special],
])
  if (!check) fail(`BOOTSTRAP_ADMIN_PASSWORD: ${message}`);

// DIRECT_URL first: this writes across organizations, which the least-privilege
// application role is deliberately not permitted to do.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

try {
  const existing = await prisma.userProfile.count();
  if (existing > 0) {
    // Not an error. This runs on every deploy, and after the first one there is
    // nothing to do — exiting non-zero would fail the deployment for a
    // condition that means everything is fine.
    console.log(
      `Bootstrap skipped: ${existing} ${existing === 1 ? 'user already exists' : 'users already exist'}. ` +
        'The first administrator is created once, on an empty database.',
    );
    process.exit(0);
  }

  const authUserId = randomUUID();
  const passwordHash = await hash(password, 10);

  await prisma.$transaction(async (tx) => {
    await tx.organization.create({ data: { id: organizationId, name: organizationName } });
    const profile = await tx.userProfile.create({
      data: { authUserId, email, displayName, isActive: true },
    });
    await tx.organizationMember.create({
      data: { organizationId, userProfileId: profile.id, role: UserRole.SYSTEM_ADMIN },
    });
    // Second, because it references UserProfile.authUserId.
    //
    // `mustChangePassword` is not advice. This password has been sitting in an
    // env file, which is a shared secret that outlives whoever set it, so it is
    // a way in exactly once — RolesGuard refuses every role-protected route
    // until it is replaced with one this script never saw.
    await tx.authCredential.create({
      data: { authUserId, email, passwordHash, mustChangePassword: true },
    });
  });

  // Deliberately no password echoed. It is already in the operator's env file,
  // and printing it would put it into `docker compose logs` as well, where it
  // persists long after first sign-in has made it useless.
  console.log('First administrator created.');
  console.log(`  email        : ${email}`);
  console.log(`  organization : ${organizationName} (${organizationId})`);
  console.log(`  role         : SYSTEM_ADMIN`);
  console.log('  password     : as set in BOOTSTRAP_ADMIN_PASSWORD.');
  console.log('  Sign-in goes straight to the change-password screen; clear the value');
  console.log('  from the environment file once that is done.');
} finally {
  await prisma.$disconnect();
}
