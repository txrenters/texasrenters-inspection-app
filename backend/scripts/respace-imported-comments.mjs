/**
 * Takes the spaces pdf.js invented back out of imported checklist comments.
 *
 * Until the fix beside `inspect-cloud-spacing.ts`, every comment imported from
 * an Inspect & Cloud PDF was stored as pdf.js read it: a space after nearly
 * every "s" ("s hower runs non s top", "cons tantly"), which the comparison
 * prints for owners and tenants. Telling those spaces from real ones needs the
 * page's geometry, which was never stored, so this re-reads each report from
 * the copy the import kept, with the importer as it reads today. A stored
 * comment is replaced only when the new reading has exactly its letters and
 * differs from it only by having fewer spaces. Anything else, a comment
 * somebody has edited since included, is left as it is.
 *
 *   node scripts/respace-imported-comments.mjs            dry run: prints every change
 *   node scripts/respace-imported-comments.mjs --apply    write
 *
 * Options
 *   --apply                 actually write (a dry run without it)
 *   --limit 25              stop after this many inspections
 *   --inspection <uuid>     just this inspection
 *
 * Finalized inspections are included: the comment is the import's own reading
 * of the office's report, put right, which is the one write the import is
 * already allowed to make through finalization. Each inspection that changes
 * gets an `IMPORTED_COMMENTS_RESPACED` audit row carrying every comment before
 * and after, and whether it was finalized. A comment edited between the dry run
 * and `--apply` is not overwritten: each write is conditional on the text it
 * replaces.
 *
 * Uses the built application's own reader, so the rule lives in one place, and
 * constructs only what it needs, never the whole application (see
 * `reparse-imported-photo-times.mjs` for why). Inside the API container `dist`
 * is already there: `docker cp` this file and `owner-prisma.mjs` into
 * /app/backend/scripts and run it from /app/backend.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const { InspectionMediaStorageService } = await import(
  '../dist/technician/inspection-media-storage.service.js'
);
const { sourceKey } = await import('../dist/admin/inspection-import/inspection-import.service.js');
const { readPages } = await import('../dist/admin/inspection-import/inspect-cloud-pdf.js');
const { parseReport } = await import('../dist/admin/inspection-import/inspect-cloud-report.js');
const { storedCommentRespacer } = await import(
  '../dist/admin/inspection-import/inspect-cloud-spacing.js'
);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const APPLY = flag('apply');
const LIMIT = value('limit') ? Number(value('limit')) : undefined;
const ONLY = value('inspection');

/** A courtesy to storage: reports run to 80 MB and there are hundreds. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));

// Owner connection: deliberately cross-organization, and the application role is
// subject to the tenant-isolation policies, which would hide every row and let the
// run report that there was nothing to do.
const prisma = ownerPrismaClient();
const storage = new InspectionMediaStorageService();

/**
 * Every inspection a report was written into, with all the reports written
 * into it. An inspection can hold more than one: a report imported to ADD
 * leaves the rooms it does not mention as the earlier one left them.
 */
async function importedInspections() {
  const jobs = await prisma.inspectionImportJob.findMany({
    where: {
      committedAt: { not: null },
      inspectionId: ONLY ?? { not: null },
    },
    orderBy: { createdAt: 'asc' },
    select: { organizationId: true, inspectionId: true, fingerprint: true },
  });
  const byInspection = new Map();
  for (const job of jobs) {
    const entry = byInspection.get(job.inspectionId) ?? {
      organizationId: job.organizationId,
      inspectionId: job.inspectionId,
      fingerprints: new Set(),
    };
    entry.fingerprints.add(job.fingerprint);
    byInspection.set(job.inspectionId, entry);
  }
  const all = [...byInspection.values()];
  return LIMIT === undefined ? all : all.slice(0, LIMIT);
}

/** Every comment in the reports, as the importer reads them today. */
async function readComments(organizationId, fingerprints) {
  const comments = [];
  const unread = [];
  for (const fingerprint of fingerprints) {
    const bytes = await storage.get(sourceKey(organizationId, fingerprint)).catch(() => null);
    if (!bytes) {
      unread.push({ fingerprint, status: 'SOURCE_MISSING' });
      continue;
    }
    try {
      const report = parseReport(await readPages(bytes));
      for (const area of report.areas)
        for (const item of area.items) if (item.comment) comments.push(item.comment);
    } catch {
      unread.push({ fingerprint, status: 'SOURCE_UNREADABLE' });
    }
  }
  return { comments, unread };
}

async function main() {
  const inspections = await importedInspections();
  console.log(`${inspections.length} imported inspections; ${APPLY ? 'WRITING' : 'DRY RUN'}…\n`);

  const tally = { inspections: 0, changed: 0, comments: 0, written: 0, skippedAsEdited: 0 };
  const leftAlone = [];
  for (const target of inspections) {
    const { comments, unread } = await readComments(target.organizationId, target.fingerprints);
    for (const entry of unread) leftAlone.push({ inspectionId: target.inspectionId, ...entry });
    // A report that could not be read leaves its inspection alone entirely: its
    // comments would otherwise be judged against another report's.
    if (unread.length) {
      await pause();
      continue;
    }
    tally.inspections += 1;

    const respace = storedCommentRespacer(comments);
    const inspection = await prisma.inspection.findUnique({
      where: { id: target.inspectionId },
      select: { finalizedAt: true, property: { select: { addressLine1: true } } },
    });
    const responses = await prisma.inspectionAreaChecklistResponse.findMany({
      where: {
        organizationId: target.organizationId,
        inspectionArea: { inspectionId: target.inspectionId },
        comment: { not: null },
      },
      select: {
        id: true,
        comment: true,
        checklistItem: { select: { label: true } },
        inspectionArea: { select: { propertyArea: { select: { name: true } } } },
      },
    });
    // The dry run is what gets approved, so it shows every comment it would
    // change, where it is, and the words before and after.
    const changes = responses
      .map((response) => ({ response, after: respace(response.comment) }))
      .filter(({ response, after }) => after !== response.comment);
    if (!changes.length) {
      await pause();
      continue;
    }

    tally.changed += 1;
    tally.comments += changes.length;
    const finalized = Boolean(inspection?.finalizedAt);
    console.log(
      `${target.inspectionId}  ${inspection?.property?.addressLine1 ?? '(no property)'}` +
        `${finalized ? '  [finalized]' : ''}  ${changes.length} comment(s)`,
    );
    for (const { response, after } of changes) {
      console.log(
        `  ${response.inspectionArea.propertyArea.name} / ${response.checklistItem.label}`,
      );
      console.log(`    - ${response.comment}`);
      console.log(`    + ${after}`);
    }
    console.log('');

    if (APPLY) {
      // One round trip per comment, so the default five-second transaction is
      // tight from outside the container, through the pooler.
      const written = await prisma.$transaction(async (tx) => {
        const applied = [];
        for (const { response, after } of changes) {
          const { count } = await tx.inspectionAreaChecklistResponse.updateMany({
            where: { id: response.id, comment: response.comment },
            data: { comment: after },
          });
          if (count) applied.push({ responseId: response.id, before: response.comment, after });
          else tally.skippedAsEdited += 1;
        }
        if (applied.length)
          await tx.auditLog.create({
            data: {
              organizationId: target.organizationId,
              action: 'IMPORTED_COMMENTS_RESPACED',
              entityType: 'Inspection',
              entityId: target.inspectionId,
              metadata: {
                reason: 'respace-imported-comments',
                fingerprints: [...target.fingerprints],
                afterFinalization: finalized,
                changes: applied,
              },
            },
          });
        return applied.length;
      }, { timeout: 60_000 });
      tally.written += written;
    }
    await pause();
  }

  console.log(
    `${tally.inspections} inspections read · ${tally.changed} with comments to put right · ` +
      `${tally.comments} comments` +
      (APPLY ? ` · ${tally.written} written · ${tally.skippedAsEdited} edited since, left alone` : ''),
  );
  if (leftAlone.length) {
    console.log('\nleft untouched, report not readable:');
    for (const entry of leftAlone) console.log(`  ${entry.inspectionId}  ${entry.fingerprint}  ${entry.status}`);
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
