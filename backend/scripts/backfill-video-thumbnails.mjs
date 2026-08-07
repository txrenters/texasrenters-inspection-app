#!/usr/bin/env node
/**
 * Generates poster frames for videos uploaded before thumbnails existed.
 *
 *   node --env-file-if-exists=.env.local scripts/backfill-video-thumbnails.mjs [--apply]
 *
 * New uploads get a thumbnail automatically during processing; this only fills
 * the gap for older recordings. Videos that already have one are skipped, so the
 * script is safe to re-run, and a failure on one video never stops the rest.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const APPLY = process.argv.includes('--apply');

const { InspectionMediaStorageService } = await import(
  '../dist/technician/inspection-media-storage.service.js'
);
const { thumbnailKeyFor } = await import('../dist/common/object-storage.js');
const { MediaProcessingService } = await import('../dist/technician/media-processing.service.js');

// Owner connection: this script is deliberately cross-organization, and the
// application role is subject to the tenant-isolation policies.
const prisma = ownerPrismaClient();
const storage = new InspectionMediaStorageService();
// Only the thumbnail generator is exercised; no AI or database work runs.
const processor = new MediaProcessingService({}, storage, {}, undefined);

const videos = await prisma.inspectionMedia.findMany({
  select: { id: true, storageKey: true, mimeType: true },
  orderBy: { createdAt: 'asc' },
});
console.log(`${videos.length} video(s); storage provider = ${storage.providerName()}\n`);

let created = 0;
let present = 0;
let failed = 0;

for (const video of videos) {
  const key = thumbnailKeyFor(video.storageKey);
  try {
    await storage.get(key);
    present += 1;
    continue;
  } catch {
    // No thumbnail yet — fall through and build one.
  }
  if (!APPLY) {
    console.log(`  would generate ${key}`);
    created += 1;
    continue;
  }
  try {
    const bytes = await storage.get(video.storageKey);
    await processor.generateThumbnail(bytes, video.mimeType, video.storageKey);
    const thumb = await storage.get(key);
    console.log(`  generated ${key} (${thumb.length} bytes)`);
    created += 1;
  } catch (error) {
    console.error(`  FAILED ${video.storageKey}: ${error.message}`);
    failed += 1;
  }
}

console.log(
  `\n${APPLY ? 'Backfilled' : 'Dry run'}: ${created} generated, ${present} already present, ${failed} failed.`,
);
if (!APPLY) console.log('Re-run with --apply to generate them.');
await prisma.$disconnect();
