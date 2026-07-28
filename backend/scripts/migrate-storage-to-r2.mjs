#!/usr/bin/env node
/**
 * Copies every object the database references from the current storage backend
 * into Cloudflare R2, preserving keys exactly.
 *
 *   node --env-file-if-exists=.env.local scripts/migrate-storage-to-r2.mjs [--apply]
 *
 * The object list comes from the database (InspectionMedia.storageKey,
 * InspectionPhoto.storageKey, PropertyFloorPlan.storageKey) rather than from a
 * bucket listing, so exactly what the application can reference is migrated and
 * orphaned objects are ignored.
 *
 * Source is whichever provider the *_STORAGE_PROVIDER vars currently name, so
 * this works from `local` or `supabase`. Existing R2 objects are skipped, making
 * the script safe to re-run and safe to run before cutting the providers over.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const MEDIA_BUCKET = process.env.INSPECTION_MEDIA_STORAGE_BUCKET || 'inspection-media';
const PLAN_BUCKET = process.env.FLOOR_PLAN_STORAGE_BUCKET || 'floor-plans';
const MEDIA_LOCAL_ROOT = resolve(process.cwd(), '.local-inspection-media');
const PLAN_LOCAL_ROOT = resolve(process.cwd(), '.local-floor-plans');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(1);
  }
  return value;
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  },
});

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

async function readSource(provider, bucket, localRoot, key) {
  if (provider === 'supabase') {
    if (!supabase) throw new Error('Supabase credentials are not configured.');
    const { data, error } = await supabase.storage.from(bucket).download(key);
    if (error || !data) throw new Error(error?.message ?? 'not found');
    return Buffer.from(await data.arrayBuffer());
  }
  return readFile(resolve(localRoot, key));
}

async function existsInR2(bucket, key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const prisma = new PrismaClient();
  const mediaProvider = process.env.INSPECTION_MEDIA_STORAGE_PROVIDER || 'local';
  const planProvider = process.env.FLOOR_PLAN_STORAGE_PROVIDER || 'local';
  if (mediaProvider === 'r2' && planProvider === 'r2')
    console.log('Note: both providers already read from r2; this will verify rather than move.\n');

  const [videos, photos, plans] = await Promise.all([
    prisma.inspectionMedia.findMany({ select: { storageKey: true, mimeType: true } }),
    prisma.inspectionPhoto.findMany({ select: { storageKey: true, mimeType: true } }),
    prisma.propertyFloorPlan.findMany({ select: { storageKey: true, mimeType: true } }),
  ]);

  const items = [
    ...videos.map((row) => ({
      ...row,
      bucket: MEDIA_BUCKET,
      provider: mediaProvider,
      localRoot: MEDIA_LOCAL_ROOT,
      kind: 'video',
    })),
    ...photos.map((row) => ({
      ...row,
      bucket: MEDIA_BUCKET,
      provider: mediaProvider,
      localRoot: MEDIA_LOCAL_ROOT,
      kind: 'photo',
    })),
    ...plans.map((row) => ({
      ...row,
      bucket: PLAN_BUCKET,
      provider: planProvider,
      localRoot: PLAN_LOCAL_ROOT,
      kind: 'floor-plan',
    })),
  ];

  console.log(
    `${items.length} referenced object(s): ${videos.length} video(s), ${photos.length} photo(s), ${plans.length} floor plan(s)`,
  );
  console.log(`source providers: media=${mediaProvider} floorPlans=${planProvider}\n`);

  let copied = 0;
  let skipped = 0;
  let missing = 0;

  for (const item of items) {
    if (await existsInR2(item.bucket, item.storageKey)) {
      skipped += 1;
      continue;
    }
    if (!APPLY) {
      console.log(`  would copy ${item.kind} ${item.bucket}/${item.storageKey}`);
      copied += 1;
      continue;
    }
    let bytes;
    try {
      bytes = await readSource(item.provider, item.bucket, item.localRoot, item.storageKey);
    } catch (error) {
      // A missing source is reported, never fatal: one unreadable object must not
      // abort the migration of everything else.
      console.error(`  MISSING ${item.kind} ${item.storageKey}: ${error.message}`);
      missing += 1;
      continue;
    }
    await r2.send(
      new PutObjectCommand({
        Bucket: item.bucket,
        Key: item.storageKey,
        Body: bytes,
        ContentType: item.mimeType,
      }),
    );
    console.log(`  copied ${item.kind} ${item.bucket}/${item.storageKey} (${bytes.length} bytes)`);
    copied += 1;
  }

  console.log(
    `\n${APPLY ? 'Migrated' : 'Dry run'}: ${copied} copied, ${skipped} already in R2, ${missing} missing at source.`,
  );
  if (!APPLY) console.log('Re-run with --apply to perform the migration.');
  await prisma.$disconnect();
  if (missing) process.exit(1);
}

await main();
