#!/usr/bin/env node
/**
 * Copy sign-in credentials out of Supabase's `auth.users` into `AuthCredential`.
 *
 * Phase 2 of docs/migration/SUPABASE_TO_SELF_HOSTED.md. Supabase stores bcrypt
 * in `encrypted_password`, and bcrypt is bcrypt — the hash moves across
 * verbatim and every existing password keeps working. Nobody is forced to
 * reset, which is the entire reason this runs against `auth.users` rather than
 * mailing everyone a new temporary password.
 *
 * `authUserId` is preserved exactly. It is the JWT `sub` and the link every
 * `UserProfile` already carries, so both auth systems resolve the same person
 * for as long as they run side by side.
 *
 * Reads `auth.users` through the same connection Prisma uses, so it must run
 * while DATABASE_URL still points at Supabase — that schema does not exist on
 * the dockerized Postgres and is deliberately not being copied there.
 *
 * Idempotent: re-running updates rather than duplicating. Dry run by default.
 *
 *   node --env-file=.env.local scripts/import-supabase-credentials.mjs
 *   node --env-file=.env.local scripts/import-supabase-credentials.mjs --confirm
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const CONFIRM = process.argv.includes('--confirm');
const prisma = new PrismaClient();

/**
 * A bcrypt hash, and nothing else.
 *
 * Supabase can also hold argon2 or an empty string for accounts created through
 * a provider or an invite that was never completed. Importing one of those
 * would produce a credential that can never authenticate, which is worse than
 * having none: `deletePhoto`-style "row exists" checks would treat the account
 * as provisioned. bcrypt is `$2a$`/`$2b$`/`$2y$` followed by a cost and a
 * 53-character salt+digest.
 */
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const rows = await prisma.$queryRawUnsafe(`
  select u.id::text                                        as "authUserId",
         lower(u.email)                                    as email,
         u.encrypted_password                              as "passwordHash",
         (u.raw_app_meta_data ->> 'must_change_password')  as "mustChange",
         p."displayName"                                   as "profileName",
         p."isActive"                                      as "profileActive"
  from auth.users u
  left join public."UserProfile" p on p."authUserId" = u.id::text
  order by u.created_at
`);

const importable = [];
const skipped = [];

for (const row of rows) {
  if (!row.email) {
    skipped.push({ account: row.authUserId, reason: 'no email' });
  } else if (!row.passwordHash || !BCRYPT.test(row.passwordHash)) {
    // Never report the value, only the shape.
    skipped.push({ account: row.email, reason: 'no usable bcrypt hash' });
  } else if (!row.profileName) {
    // The foreign key would reject it, and rightly: authentication resolves a
    // profile straight after verifying the token, so a credential without one
    // signs in and is refused a step later. Skipping is the correct outcome,
    // not a workaround for the constraint.
    skipped.push({ account: row.email, reason: 'no application profile' });
  } else {
    importable.push(row);
  }
}

console.log(`auth.users holds ${rows.length} account(s).\n`);
console.table(
  importable.map((row) => ({
    email: row.email,
    profile: row.profileName,
    active: row.profileActive,
    mustChangePassword: row.mustChange === 'true',
  })),
);

if (skipped.length) {
  console.log('\nSkipped:');
  console.table(skipped);
}

const existing = await prisma.authCredential.count();
console.log(`\nAuthCredential currently holds ${existing} row(s).`);

if (!CONFIRM) {
  console.log(`\nDRY RUN — nothing was written. ${importable.length} would be imported.`);
  console.log('Re-run with --confirm.');
  await prisma.$disconnect();
  process.exit(0);
}

let created = 0;
let updated = 0;
for (const row of importable) {
  const before = await prisma.authCredential.findUnique({
    where: { authUserId: row.authUserId },
    select: { id: true },
  });
  await prisma.authCredential.upsert({
    where: { authUserId: row.authUserId },
    // `mustChangePassword` moves out of the JWT's app_metadata and becomes a
    // column, which is what lets the two clients stop disagreeing about where
    // to read it.
    create: {
      authUserId: row.authUserId,
      email: row.email,
      passwordHash: row.passwordHash,
      mustChangePassword: row.mustChange === 'true',
    },
    update: {
      email: row.email,
      passwordHash: row.passwordHash,
      mustChangePassword: row.mustChange === 'true',
    },
  });
  if (before) updated += 1;
  else created += 1;
}

console.log(`\nImported: ${created} created, ${updated} updated.`);

// Prove the round trip rather than trusting the writes: a hash that arrived
// truncated or re-encoded would still be a 60-character string.
const verified = await prisma.$queryRawUnsafe(`
  select count(*)::int as matching
  from auth.users u
  join public."AuthCredential" c on c."authUserId" = u.id::text
  where c."passwordHash" = u.encrypted_password
`);
const matching = verified[0]?.matching ?? 0;
console.log(`Verified: ${matching}/${created + updated} hashes match auth.users byte for byte.`);

await prisma.$disconnect();
process.exit(matching === created + updated ? 0 : 1);
