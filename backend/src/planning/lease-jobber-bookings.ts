import {
  InspectionStatus,
  JobberConnectionStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
  LeaseInspectionOutcome,
} from '@prisma/client';
import { bookingFromTenancy, jobberBookingText, type JobberBookingInput } from '@texasrenters/shared';

import { managementHasEnded } from '../admin/property-service-status';
import { tenancyOnFile } from '../admin/tenancy-on-file';
import type { PrismaService } from '../common/prisma.service';
import { linkedJobberProperty } from '../integrations/jobber/jobber.booking';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { resolveVisitType, visitTypeRules } from '../integrations/jobber/jobber.visit-type';

/**
 * Lease move-outs and move-ins, booked in Jobber too (the office, 2026-10-01).
 *
 * On 2026-09-18 these were made here only -- "PW will be there just for the
 * integration" -- so a lease move-out showed on a technician's day in the
 * console and nowhere in Jobber, and the two calendars could never agree. The
 * office now wants every visit on both, syncing both ways.
 *
 * So every move-out and move-in the lease schedule booked, still scheduled and
 * not yet in Jobber, is queued for Jobber exactly as a console booking is: the
 * visit title and Details are written onto the inspection, and a VISIT_CREATE
 * task asks the outbound worker to make the job and its visit, on the
 * inspection's day, for its technician. The worker then claims the visit, and
 * from there Jobber and the console follow each other's moves and deletions
 * like any other.
 *
 * Run after each lease run, for new bookings and the ones made before this
 * existed alike, so a failure here is simply tried again on the next run. Only
 * while bookings are switched on (JOBBER_BOOKING_ENABLED) and Jobber is
 * connected; a property not linked to a Jobber property is left here, said so
 * on its schedule row, and tried again once someone links it. Nothing is sent
 * for a property whose owner ended the management (2026-10-08) -- not even one
 * the office moved by hand, which the lease run leaves for a person to cancel.
 */
export interface LeaseJobberBookings {
  queued: number;
  notLinked: number;
  /** Left alone: Jobber already has the office's own for it, not imported here. */
  alreadyInJobber: number;
}

/** How near the day a Jobber visit of the office's has to be to be this one -- the lease schedule's own window. */
const OFFICE_WINDOW_DAYS = 30;

export async function queueLeaseBookingsInJobber(
  prisma: PrismaService,
  organizationId: string,
  today: string,
  /** Only this property's, as the lease run was. */
  buildingId?: string,
): Promise<LeaseJobberBookings | null> {
  if (!getJobberConfig().bookingEnabled) return null;
  const connection = await prisma.jobberConnection.findUnique({
    where: { organizationId },
    select: { status: true },
  });
  if (connection?.status !== JobberConnectionStatus.CONNECTED) return null;

  const rows = await prisma.leaseScheduledInspection.findMany({
    where: {
      organizationId,
      outcome: LeaseInspectionOutcome.SCHEDULED,
      inspection: {
        ...(buildingId ? { propertywareBuildingId: buildingId } : {}),
        status: InspectionStatus.SCHEDULED,
        startedAt: null,
        jobberVisitId: null,
        scheduledAt: { gte: new Date(`${today}T00:00:00.000Z`) },
        // Asked once: a booking Jobber refused is the office's to look at, not
        // something to send again every night.
        jobberOutboundTasks: { none: { kind: JobberOutboundKind.VISIT_CREATE } },
      },
    },
    select: {
      id: true,
      detail: true,
      inspection: {
        select: {
          id: true,
          inspectionType: true,
          scheduledAt: true,
          internalNotes: true,
          propertywareBuildingId: true,
          propertywareUnitId: true,
          propertywareLeaseId: true,
          propertywareBuilding: {
            select: { name: true, addressLine1: true, serviceStatus: { select: { managementEndedAt: true } } },
          },
          propertywareUnit: { select: { addressLine1: true } },
        },
      },
    },
  });

  const outcome: LeaseJobberBookings = { queued: 0, notLinked: 0, alreadyInJobber: 0 };
  for (const row of rows) {
    const inspection = row.inspection;
    if (!inspection?.propertywareBuildingId) continue;
    // Only what the lease schedule books; anything else here is not its to send.
    if (inspection.inspectionType !== 'MOVE_OUT' && inspection.inspectionType !== 'MOVE_IN') continue;
    if (managementHasEnded(inspection.propertywareBuilding?.serviceStatus)) continue;
    const place = { buildingId: inspection.propertywareBuildingId, unitId: inspection.propertywareUnitId };
    const link = await linkedJobberProperty(prisma, organizationId, place);
    if (link.status !== 'LINKED') {
      outcome.notLinked += 1;
      if (!row.detail)
        await prisma.leaseScheduledInspection.update({
          where: { id: row.id },
          data: {
            detail:
              link.status === 'AMBIGUOUS'
                ? 'Not in Jobber yet: this property is linked to more than one Jobber property. Fix the link on the Jobber page.'
                : 'Not in Jobber yet: this property is not linked to a Jobber property. Link it on the Jobber page.',
          },
        });
      continue;
    }

    const kind = inspection.inspectionType;
    const scheduledOn = inspection.scheduledAt.toISOString().slice(0, 10);

    /**
     * The office's own, in Jobber but never imported here.
     *
     * The lease schedule gives way to an office booking it can see, and it
     * sees only the ones the sync imported. One at a property whose link is
     * broken, or refused for some other reason, is invisible to it -- and
     * booking ours on top would put the same move-out in Jobber twice.
     */
    const office = await officeVisitInJobber(prisma, organizationId, link.jobberPropertyId, kind, scheduledOn);
    if (office) {
      outcome.alreadyInJobber += 1;
      const said = `Not booked in Jobber: Jobber already has this ${kind === 'MOVE_OUT' ? 'move-out' : 'move-in'} for ${office}, which has not reached the console. Check that visit in Jobber.`;
      if (row.detail !== said)
        await prisma.leaseScheduledInspection.update({ where: { id: row.id }, data: { detail: said } });
      continue;
    }

    const file = await tenancyOnFile(prisma, { organizationId, ...place, leaseId: inspection.propertywareLeaseId });
    const prefill =
      file.tenancy || file.tenantNames.length
        ? bookingFromTenancy({
            zone: file.tenancy?.zone ?? null,
            managementPlan: file.tenancy?.managementPlan ?? null,
            hvacPlan: file.tenancy?.hvacPlan ?? null,
            hvacFilterLocation: file.tenancy?.hvacFilterLocation ?? null,
            hvacFilterSizes: file.tenancy?.hvacFilterSizes ?? [],
            tbpEnrollment: file.tenancy?.tbpEnrollment ?? null,
            tenantNames: file.tenantNames,
          })
        : null;
    const booking: JobberBookingInput = {
      zone: prefill?.zone ?? null,
      benefitPackage: false,
      // A move books nothing besides itself; the office adds services in Jobber.
      services: { filterChange: false, pestControl: false, fleaTreatment: false },
      filters: [],
      planTier: prefill?.planTier ?? null,
      hvacOptedOut: prefill?.hvacOptedOut ?? false,
      contactTenantsBeforeArrival: false,
      // The tenant leaving, for a move-out. Not for a move-in: the tenancy on
      // file is the one that ended, and naming them would send the technician
      // to the wrong people.
      tenants: kind === 'MOVE_OUT' ? (prefill?.tenants ?? []) : [],
      accessNotes: [],
      notes: inspection.internalNotes ? [inspection.internalNotes] : [],
    };
    const text = jobberBookingText(booking, {
      inspectionType: kind,
      address:
        inspection.propertywareUnit?.addressLine1?.trim() ||
        inspection.propertywareBuilding?.addressLine1?.trim() ||
        inspection.propertywareBuilding?.name ||
        '',
      scheduledOn,
      inspectionUrl: `${webOrigin()}/inspections/${inspection.id}`,
    });

    await prisma.$transaction(async (tx) => {
      await tx.inspection.update({
        where: { id: inspection.id },
        data: { jobberVisitTitle: text.visitTitle, jobberVisitDetails: text.visitDetails },
      });
      await tx.jobberOutboundTask.create({
        data: {
          organizationId,
          inspectionId: inspection.id,
          kind: JobberOutboundKind.VISIT_CREATE,
          status: JobberOutboundStatus.PENDING,
          jobTitle: text.jobTitle,
          createdById: null,
        },
      });
      // The property and kind, never the Details: they carry the tenant's name.
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'JOBBER_VISIT_BOOKING_QUEUED',
          entityType: 'Inspection',
          entityId: inspection.id,
          metadata: { jobberPropertyId: link.jobberPropertyId, inspectionType: kind, fromLease: true },
        },
      });
      if (row.detail?.startsWith('Not in Jobber yet') || row.detail?.startsWith('Not booked in Jobber'))
        await tx.leaseScheduledInspection.update({ where: { id: row.id }, data: { detail: null } });
    });
    outcome.queued += 1;
  }
  return outcome;
}

/**
 * The day of a not-yet-finished move-out or move-in Jobber has at this Jobber
 * property within the window, as the sync last saw it, or null.
 *
 * Read from what the sync stored rather than asked of Jobber: it sees the
 * whole calendar every five minutes, and the lease run should not be the one
 * thing here that calls Jobber directly. A visit it imported is not counted --
 * the lease schedule already sees that one and gives way to it.
 */
async function officeVisitInJobber(
  prisma: PrismaService,
  organizationId: string,
  jobberPropertyId: string,
  kind: 'MOVE_OUT' | 'MOVE_IN',
  scheduledOn: string,
): Promise<string | null> {
  const seen = await prisma.jobberVisitImport.findMany({
    where: {
      organizationId,
      status: { notIn: [JobberVisitImportStatus.IMPORTED, JobberVisitImportStatus.IGNORED] },
      payload: { path: ['property', 'id'], equals: jobberPropertyId },
    },
    select: { payload: true },
  });
  const rules = visitTypeRules();
  const day = Date.parse(`${scheduledOn}T00:00:00Z`);
  for (const { payload } of seen) {
    const visit = payload as { title?: string | null; startAt?: string | null; completedAt?: string | null } | null;
    if (!visit?.startAt || visit.completedAt) continue;
    const type = resolveVisitType(visit.title, rules);
    if (type.outcome !== 'RESOLVED' || type.inspectionType !== kind) continue;
    if (Math.abs(Date.parse(visit.startAt) - day) <= OFFICE_WINDOW_DAYS * 86_400_000) return visit.startAt.slice(0, 10);
  }
  return null;
}

/** Where the console is, for the link a booked visit's Details carry back to its inspection. */
function webOrigin(): string {
  return (process.env.WEB_APP_ORIGIN ?? 'http://localhost:5454').replace(/\/$/, '');
}
