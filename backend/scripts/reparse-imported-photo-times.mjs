/**
 * Puts imported photographs' capture times right, from the reports themselves.
 *
 * Every photograph imported from an Inspect & Cloud PDF carries the time printed
 * on it in the report, but the importer read that text in the zone of whichever
 * machine ran the import. Production runs UTC, so most are five or six hours
 * early; the Propertyware backfill was also run from machines in other zones, so
 * no single shift fixes them all. This re-reads each report from the copy the
 * import kept and stores the stamp as Texas time, with its words beside it.
 *
 * Until a report is re-read its photographs carry no stamp at all -- a missing
 * time is honest, a wrong one on evidence is not.
 *
 *   node scripts/reparse-imported-photo-times.mjs            dry run, every report
 *   node scripts/reparse-imported-photo-times.mjs --apply    write
 *
 * Options
 *   --apply                 actually write (a dry run without it)
 *   --limit 25              stop after this many reports
 *   --fingerprint <sha256>  just this report
 *
 * Uses the built application's own parser and importer, so the rules live in
 * one place -- but constructs only those, never the whole application. Booting
 * AppModule in a second process would start its schedulers and startup sweeps
 * beside the live API: a second Jobber sync every five minutes, and recordings
 * still being processed re-queued as if interrupted.
 *
 * Inside the API container `dist` is already there: `docker cp` this file and
 * `owner-prisma.mjs` into /app/backend/scripts and run it from /app/backend. A
 * report whose photographs no longer line up with how it reads today is left
 * untouched and listed at the end.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const { InspectionMediaStorageService } = await import(
  '../dist/technician/inspection-media-storage.service.js'
);
const { InspectionImportService } = await import(
  '../dist/admin/inspection-import/inspection-import.service.js'
);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const APPLY = flag('apply');
const LIMIT = value('limit') ? Number(value('limit')) : undefined;
const ONLY = value('fingerprint');

/** A courtesy to storage: reports run to 80 MB and there are hundreds. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

// Owner connection: deliberately cross-organization, and the application role is
// subject to the tenant-isolation policies, which would hide every row and let the
// run report that there was nothing to do.
const prisma = ownerPrismaClient();
const storage = new InspectionMediaStorageService();
// The model reader is never reached: a correction reads the report's own layout.
const imports = new InspectionImportService(prisma, storage, {});

async function main() {
  /**
   * Reports with at least one photograph still unconfirmed.
   *
   * From the import jobs, oldest first, so a run stopped part-way has done the
   * backlog in the order it arrived.
   */
  const jobs = await prisma.inspectionImportJob.findMany({
    where: { committedAt: { not: null }, ...(ONLY ? { fingerprint: ONLY } : {}) },
    distinct: ['organizationId', 'fingerprint'],
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true, fingerprint: true },
  });
  const queue = [];
  for (const job of jobs) {
    if (LIMIT !== undefined && queue.length >= LIMIT) break;
    const photos = await prisma.inspectionPhoto.count({
      where: {
        organizationId: job.organizationId,
        captureTimeSource: null,
        metadata: { path: ['importedFrom'], equals: job.fingerprint },
      },
    });
    if (photos) queue.push({ ...job, photos });
  }

  const unconfirmed = queue.reduce((sum, report) => sum + report.photos, 0);
  console.log(
    `${queue.length} reports, ${unconfirmed} photographs unconfirmed; ${APPLY ? 'correcting' : 'DRY RUN'}…\n`,
  );

  const tally = {};
  const leftAlone = [];
  for (const report of queue) {
    try {
      const result = await imports.correctImportedPhotoTimes(report.organizationId, report.fingerprint, {
        apply: APPLY,
      });
      tally[result.status] = (tally[result.status] ?? 0) + 1;
      console.log(
        `${report.fingerprint.slice(0, 12)}  ${result.status.padEnd(17)} photos ${result.photos}` +
          `  corrected ${result.corrected}  unreadable ${result.unreadable}  mismatched ${result.mismatched}`,
      );
      if (result.status !== 'CORRECTED' && result.status !== 'WOULD_CORRECT') leftAlone.push(result);
    } catch (error) {
      tally.FAILED = (tally.FAILED ?? 0) + 1;
      leftAlone.push({ fingerprint: report.fingerprint, status: 'FAILED' });
      console.error(`${report.fingerprint.slice(0, 12)}  FAILED  ${error instanceof Error ? error.message : error}`);
    }
    await pause();
  }

  console.log(`\n${Object.entries(tally).map(([status, count]) => `${status} ${count}`).join(' · ')}`);
  if (leftAlone.length) {
    console.log('\nleft untouched:');
    for (const result of leftAlone) console.log(`  ${result.fingerprint}  ${result.status}`);
  }
  if (!APPLY) console.log('\ndry run — pass --apply to write');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
