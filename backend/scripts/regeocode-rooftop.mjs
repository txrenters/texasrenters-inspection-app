/**
 * Re-places buildings that the US Census geocoder put on the street outside.
 *
 * The Census service interpolates along a segment: it takes a block's
 * house-number range and picks a proportional point on the road. Measured
 * against Google on four live properties it was 18, 18, 61 and 75 metres from
 * the roof. Seventy-five metres on a suburban street is several houses -- the
 * difference between a technician parking outside the inspection and outside
 * a stranger's home.
 *
 * Only rows whose `geocodeSource` is still CENSUS are touched, and a row
 * Google answers becomes GOOGLE, so a second run has nothing left to do. Rows
 * Google cannot place keep their Census coordinate rather than losing one.
 *
 * Dry run unless `--apply`. The plan is printed either way, so the run that
 * writes is the one already read.
 *
 *   node scripts/regeocode-rooftop.mjs                  # plan only
 *   node scripts/regeocode-rooftop.mjs --limit 25       # plan a sample
 *   node scripts/regeocode-rooftop.mjs --apply          # write
 *
 * Needs GOOGLE_SERVER_API_KEY. Without it this refuses rather than quietly
 * re-asking the geocoder that produced the coordinates in the first place.
 */
import { geocodableAddress } from '@texasrenters/shared';

import { ownerPrismaClient } from './owner-prisma.mjs';

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const { PropertyGeocodingService } = require(
  join(dist, 'admin', 'property-geocoding.service.js'),
);
const { withSystemTenant } = require(join(dist, 'database', 'tenant-context.js'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const at = argv.indexOf('--limit');
const LIMIT = at >= 0 ? Number(argv[at + 1]) : 1000;

// The owner connection, not DATABASE_URL. The application role is subject to
// the tenant-isolation policies, so this would see zero rows and report
// "nothing to do" -- indistinguishable from genuinely being finished.
const prisma = ownerPrismaClient();

/** Metres between two coordinates, to say how far each pin actually moved. */
function metresBetween(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function main() {
  if (!process.env.GOOGLE_SERVER_API_KEY) {
    console.error('GOOGLE_SERVER_API_KEY is not set. Nothing to upgrade to.');
    process.exitCode = 1;
    return;
  }

  const service = new PropertyGeocodingService(prisma);

  const rows = await withSystemTenant(() =>
    prisma.propertywareBuilding.findMany({
      where: {
        isActive: true,
        addressLine1: { not: null },
        geocodeSource: 'CENSUS',
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        id: true,
        name: true,
        addressLine1: true,
        city: true,
        state: true,
        postalCode: true,
        latitude: true,
        longitude: true,
      },
      orderBy: { name: 'asc' },
      take: LIMIT,
    }),
  );

  console.log(`${rows.length} building(s) still placed by the Census geocoder.`);
  if (!rows.length) return;

  const moved = [];
  let improved = 0;
  let unchanged = 0;
  let missed = 0;

  for (const row of rows) {
    const address = geocodableAddress({
      addressLine1: row.addressLine1 ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      postalCode: row.postalCode ?? '',
    });
    if (!address) continue;

    const answer = await service.geocodeAddress(address);
    // A miss leaves the Census coordinate alone. A property that disappears
    // from the map is a worse outcome than one placed approximately.
    if (!answer || answer.source !== 'GOOGLE') {
      missed += 1;
      continue;
    }

    const distance = metresBetween(
      row.latitude.toNumber(),
      row.longitude.toNumber(),
      answer.latitude,
      answer.longitude,
    );
    if (answer.precision === 'ROOFTOP') improved += 1;
    else unchanged += 1;
    moved.push({ name: row.name, precision: answer.precision, distance });

    if (APPLY)
      await withSystemTenant(() =>
        prisma.propertywareBuilding.update({
          where: { id: row.id },
          data: {
            latitude: answer.latitude,
            longitude: answer.longitude,
            // The address we *sent*, not the one Google echoed back: storing
            // the normalised match would make every row look permanently
            // stale against its own source data.
            geocodedFor: address,
            geocodedAt: new Date(),
            geocodeSource: answer.source,
            geocodePrecision: answer.precision,
          },
        }),
      );
  }

  moved.sort((left, right) => right.distance - left.distance);
  console.log('\nFurthest ten:');
  for (const row of moved.slice(0, 10))
    console.log(`  ${row.distance.toFixed(0).padStart(5)} m  ${row.precision.padEnd(12)} ${row.name}`);

  const median = moved.length
    ? moved[Math.floor(moved.length / 2)].distance.toFixed(0)
    : '0';
  console.log(
    `\n${improved} rooftop, ${unchanged} still interpolated, ${missed} not placed by Google.` +
      `\nMedian move ${median} m.` +
      (APPLY ? '\nWritten.' : '\nDry run — pass --apply to write.'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
