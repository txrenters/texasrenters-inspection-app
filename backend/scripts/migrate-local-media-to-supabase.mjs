#!/usr/bin/env node
/**
 * Moves inspection media and floor plans off the API container's local disk into
 * Supabase Storage, preserving each object's storage key exactly.
 *
 * Local disk is ephemeral: a redeploy destroys every uploaded video, photo, and
 * floor plan. Storage keys are preserved byte-for-byte so the existing database
 * rows (InspectionMedia.providerMediaId, InspectionPhoto.storageKey,
 * PropertyFloorPlan.storageKey) keep resolving after the provider switch.
 *
 *   node --env-file-if-exists=.env.local scripts/migrate-local-media-to-supabase.mjs [--apply]
 *
 * Without --apply this is a dry run. Existing remote objects are never
 * overwritten, so the script is safe to re-run.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

const TARGETS = [
  {
    label: 'inspection media',
    root: resolve(process.cwd(), '.local-inspection-media'),
    bucket: process.env.INSPECTION_MEDIA_STORAGE_BUCKET || 'inspection-media',
  },
  {
    label: 'floor plans',
    root: resolve(process.cwd(), '.local-floor-plans'),
    bucket: process.env.FLOOR_PLAN_STORAGE_BUCKET || 'floor-plans',
  },
];

const MIME_BY_EXTENSION = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

function contentType(key) {
  const dot = key.lastIndexOf('.');
  if (dot === -1) return 'video/mp4'; // extension-less keys are room videos
  return MIME_BY_EXTENSION[key.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

async function walk(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) {
    console.error(`Could not list buckets: ${listError.message}`);
    process.exit(1);
  }
  const existing = new Set(buckets.map((bucket) => bucket.name));

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const target of TARGETS) {
    const files = await walk(target.root);
    console.log(`\n${target.label}: ${files.length} local file(s) → bucket "${target.bucket}"`);
    if (!files.length) continue;

    if (!existing.has(target.bucket)) {
      if (!APPLY) {
        console.log(`  would create private bucket "${target.bucket}"`);
      } else {
        // Private: bytes are served through the API, never anonymously.
        const { error } = await client.storage.createBucket(target.bucket, { public: false });
        if (error && !/already exists/i.test(error.message)) {
          console.error(`  could not create bucket: ${error.message}`);
          failed += files.length;
          continue;
        }
        console.log(`  created private bucket "${target.bucket}"`);
        existing.add(target.bucket);
      }
    }

    for (const path of files) {
      // Storage keys always use forward slashes, whatever the host OS.
      const key = relative(target.root, path).split(sep).join('/');
      const { size } = await stat(path);
      if (!APPLY) {
        console.log(`  would upload ${key} (${size} bytes)`);
        uploaded += 1;
        continue;
      }
      const { error } = await client.storage
        .from(target.bucket)
        .upload(key, createReadStream(path), {
          contentType: contentType(key),
          duplex: 'half',
          upsert: false,
        });
      if (error) {
        if (/exists/i.test(error.message)) {
          console.log(`  skip (already present) ${key}`);
          skipped += 1;
        } else {
          console.error(`  FAILED ${key}: ${error.message}`);
          failed += 1;
        }
        continue;
      }
      console.log(`  uploaded ${key} (${size} bytes)`);
      uploaded += 1;
    }
  }

  console.log(
    `\n${APPLY ? 'Migrated' : 'Dry run'}: ${uploaded} uploaded, ${skipped} already present, ${failed} failed.`,
  );
  if (!APPLY) console.log('Re-run with --apply to perform the migration.');
  if (failed) process.exit(1);
}

await main();
