import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

/**
 * A Prisma client on the **owner** connection, for maintenance scripts.
 *
 * `DATABASE_URL` is the least-privilege application role, which is subject to
 * the tenant-isolation policies (Phase 3 of
 * docs/migration/SUPABASE_TO_SELF_HOSTED.md). Every script here is deliberately
 * cross-organization — wiping inspection data, backfilling thumbnails,
 * migrating storage — so under that role they would quietly see and touch
 * nothing, which for a delete script reads as "already clean".
 *
 * `DIRECT_URL` is the owner: a superuser, so RLS does not apply. That is the
 * right identity for a human running a one-off against the whole database, and
 * it is deliberate rather than incidental — hence a named helper rather than
 * each script constructing its own client and inheriting whichever URL happened
 * to be set.
 */
export function ownerPrismaClient() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DIRECT_URL (preferred) or DATABASE_URL.');
  return new PrismaClient({ datasources: { db: { url } } });
}
