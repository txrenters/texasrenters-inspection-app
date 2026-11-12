/**
 * Lists the room recordings whose stored transcript holds lines whisper made up.
 *
 * On a recording with nobody talking, whisper-1 writes what subtitled videos end
 * with: "Thanks for watching", "Subtitles by…", credits to invented people. Those
 * lines are dropped from new transcripts now (`invented-speech.ts`), but
 * transcripts stored before that keep them, and the report prints a room's
 * narration to owners and tenants.
 *
 * This only reads. Each recording it lists is put right by pressing **Re-run AI**
 * on its room in the console: a re-run that finds one of these lines transcribes
 * the recording again, then rewrites the room's report summary. That works on a
 * finalized inspection too.
 *
 *   node scripts/find-invented-transcripts.mjs
 *
 * Uses the built application's own rule, so the phrases live in one place.
 * Inside the API container `dist` is already there: `docker cp` this file and
 * `owner-prisma.mjs` into /app/backend/scripts and run it from /app/backend.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const { isInventedLine } = await import('../dist/technician/invented-speech.js');

// Owner connection: deliberately cross-organization, and the application role
// is subject to the tenant-isolation policies (it would list nothing).
const prisma = ownerPrismaClient();

const jobs = await prisma.transcriptionJob.findMany({
  where: { status: 'COMPLETED' },
  select: {
    provider: true,
    updatedAt: true,
    segments: {
      orderBy: { startSeconds: 'asc' },
      select: { startSeconds: true, text: true },
    },
    inspectionMedia: {
      select: {
        id: true,
        inspectionArea: {
          select: {
            id: true,
            propertyArea: { select: { name: true } },
            inspection: {
              select: {
                id: true,
                inspectionType: true,
                scheduledAt: true,
                finalizedAt: true,
                propertywareBuilding: { select: { addressLine1: true } },
              },
            },
          },
        },
      },
    },
  },
});

const affected = jobs.filter((job) => job.segments.some((segment) => isInventedLine(segment.text)));

for (const job of affected) {
  const area = job.inspectionMedia.inspectionArea;
  const inspection = area.inspection;
  const invented = job.segments.filter((segment) => isInventedLine(segment.text));
  console.log(
    [
      `${inspection.propertywareBuilding?.addressLine1 ?? '(no address)'} · ${inspection.inspectionType} ${inspection.scheduledAt.toISOString().slice(0, 10)}${inspection.finalizedAt ? ' · finalized' : ''}`,
      `  ${area.propertyArea.name}: /inspections/${inspection.id}?area=${area.id}`,
      `  recording ${job.inspectionMedia.id}, transcribed by ${job.provider} ${job.updatedAt.toISOString().slice(0, 10)}`,
      // Only the invented lines. The rest is a technician's narration, which
      // can name a tenant or a way in, and has no business in a terminal.
      ...invented.map((segment) => `    [${segment.startSeconds}s] ${segment.text}`),
      `    + ${job.segments.length - invented.length} other line(s)`,
      '',
    ].join('\n'),
  );
}

console.log(
  `${affected.length} of ${jobs.length} transcribed recording(s) hold invented lines. ` +
    'Press Re-run AI on each room above to transcribe it again.',
);
await prisma.$disconnect();
