/**
 * Gives a scheduled inspection the rooms it was created without.
 *
 *   node scripts/give-empty-inspections-their-areas.mjs                    # report
 *   node scripts/give-empty-inspections-their-areas.mjs --actor <userId> --apply
 *
 * Options
 *   --actor <userId>  who the audit names. Required for a real run: this adds
 *                     rooms to somebody's job, and the audit row has to name a
 *                     person who exists rather than a guess.
 *   --apply           add them. Without it, nothing is written.
 *
 * Runs against the built application, so from inside the API container or
 * after `npm run build`.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 *
 * Twenty-four room-by-room inspections have no areas at all. They were created
 * before 2026-09-22, when every property was given a layout, and back then a
 * property with no approved areas produced an inspection with none either --
 * a scheduling success that reaches the technician as an empty job.
 *
 * Nine are still SCHEDULED, which is the part that matters: somebody is going
 * to open one. The rest are COMPLETED or CANCELLED and are left alone, because
 * adding rooms to a finished visit rewrites a record of what was walked.
 *
 * ── Why a script rather than the console ────────────────────────────────────
 *
 * The console's "Add areas to this inspection" does exactly this, and for one
 * or two that is the right tool. Nine inspections at fifteen rooms each is a
 * hundred and thirty-five checkboxes, and the cost of a slip is a technician
 * arriving at a job missing a room.
 *
 * It goes through `AdminService.addInspectionAreas` rather than inserting
 * rows, so it gets the same refusals the console gets, the same audit entry,
 * and the same push to the assigned technician's handset.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require(join(dist, 'app.module.js'));
const { PrismaService } = require(join(dist, 'common', 'prisma.service.js'));
const { AdminService } = require(join(dist, 'admin', 'admin.service.js'));
const { withSystemTenant } = require(join(dist, 'database', 'tenant-context.js'));
const { layoutAreasFor } = require('@texasrenters/shared');

const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const apply = argv.includes('--apply');

/** Only the types that walk rooms. An HVAC or roof visit resolves its own subjects. */
const ROOM_WALKS = ['OCCUPIED', 'MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET'];

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    const admin = app.get(AdminService);

    await withSystemTenant(async () => {
      const empty = await prisma.inspection.findMany({
        where: {
          inspectionType: { in: ROOM_WALKS },
          // SCHEDULED only. A completed or cancelled visit's areas are the
          // record of what was walked, and this is not the thing to edit it.
          status: 'SCHEDULED',
          finalizedAt: null,
          areas: { none: {} },
        },
        select: {
          id: true,
          organizationId: true,
          inspectionType: true,
          scheduledAt: true,
          propertywareBuildingId: true,
          propertywareUnitId: true,
          propertywareBuilding: { select: { addressLine1: true } },
        },
        orderBy: { scheduledAt: 'asc' },
      });

      if (!empty.length) {
        console.log('Every scheduled room-by-room inspection has its areas.');
        return;
      }

      const actorId = value('actor');
      if (apply && !actorId) throw new Error('Give --actor <userId> for a real run.');
      const actor = actorId
        ? await prisma.userProfile.findUnique({
            where: { id: actorId },
            select: { id: true, displayName: true },
          })
        : null;
      if (apply && !actor) throw new Error(`No user with id ${actorId}.`);

      console.log(`${empty.length} scheduled inspections have no areas.\n`);
      let given = 0;
      for (const inspection of empty) {
        const where = inspection.propertywareBuildingId
          ? {
              propertyId: inspection.propertywareBuildingId,
              status: 'APPROVED',
              archivedAt: null,
              unitId: inspection.propertywareUnitId ?? null,
            }
          : null;
        const label = [
          inspection.scheduledAt?.toISOString().slice(0, 10) ?? 'unscheduled',
          inspection.inspectionType,
          inspection.propertywareBuilding?.addressLine1 ?? '(no property)',
        ].join(' · ');

        if (!where) {
          console.log(`  ${label} — no property, so there is no layout to give it`);
          continue;
        }

        const onTheProperty = await prisma.propertyArea.findMany({
          where,
          select: { id: true, name: true, source: true },
        });
        /**
         * The same rule the server scopes an inspection with. Without it this
         * would offer an HVAC visit's A/C unit and filters as rooms, and
         * `addInspectionAreas` would refuse the whole call.
         */
        const rooms = layoutAreasFor(onTheProperty);
        if (!rooms.length) {
          console.log(`  ${label} — its property still has no approved rooms`);
          continue;
        }

        const skipped = onTheProperty.length - rooms.length;
        console.log(
          `  ${label} — ${rooms.length} rooms${skipped ? ` (${skipped} non-room areas left out)` : ''}`,
        );
        if (!apply) continue;

        try {
          await admin.addInspectionAreas({ ...actor, organizationId: inspection.organizationId, principalType: 'USER' }, inspection.id, {
            propertyAreaIds: rooms.map((room) => room.id),
          });
          given += 1;
        } catch (error) {
          // One refusal must not end the run: the inspections after it are
          // other technicians' jobs, and the reason is worth reading.
          console.log(`      not added: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!apply) {
        console.log('\nReport only. Re-run with --actor <userId> --apply to add them.');
        return;
      }
      console.log(`\nGave ${given} of ${empty.length} inspections their rooms.`);
    });
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
