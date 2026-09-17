import type { PrismaService } from '../common/prisma.service';

/**
 * What the office already knows about the tenancy a visit is booked for.
 *
 * Two records, read together: the lease, which names the tenants and its dates,
 * and the tenancy line from the Propertyware tenant report, which carries the
 * benefit plan, the filter sizes and where the filters go. The console reads it
 * to prefill a booking; the handset reads it so a technician knows which
 * filters the office believes are there before reading what a coordinator typed
 * on the visit.
 *
 * The tenant report records a building and nothing finer, so a tenancy is
 * matched to the lease by name, which the report's own key is built from. A
 * building with one tenancy and at most one unit needs no match. Anything less
 * certain answers with no tenancy at all: an empty block is better than one
 * belonging to the neighbours.
 */

export interface TenancyRecordOnFile {
  leaseName: string;
  zone: string | null;
  managementPlan: string | null;
  hvacPlan: string | null;
  hvacFilterLocation: string | null;
  hvacFilterSizes: string[];
  tbpEnrollment: string | null;
  /** As the report writes them: a date, a month, or a note. */
  lastFilterDelivery: string | null;
  lastHvacInspection: Date | null;
  lastOccupiedInspection: string | null;
}

export interface LeaseOnFile {
  leaseName: string | null;
  tenantDisplayNames: string[];
  moveInDate: Date | null;
  endDate: Date | null;
  scheduledMoveOutDate: Date | null;
}

export interface TenancyOnFile {
  tenancy: TenancyRecordOnFile | null;
  lease: LeaseOnFile | null;
  /** Everyone named on the lease, or empty when no single lease is certain. */
  tenantNames: string[];
}

export async function tenancyOnFile(
  prisma: PrismaService,
  where: { organizationId: string; buildingId: string; unitId?: string | null; leaseId?: string | null },
): Promise<TenancyOnFile> {
  const { organizationId, buildingId } = where;
  const unitId = where.unitId ?? null;
  const leaseId = where.leaseId ?? null;
  const leases =
    leaseId || unitId
      ? await prisma.propertywareLease.findMany({
          where: leaseId
            ? { id: leaseId, organizationId, buildingId }
            : { organizationId, buildingId, unitId, isActive: true },
          select: {
            leaseName: true,
            tenantDisplayNames: true,
            moveInDate: true,
            endDate: true,
            scheduledMoveOutDate: true,
          },
          // Two, so "exactly one" can be told from "several".
          take: 2,
        })
      : [];
  const lease = leases.length === 1 ? leases[0]! : null;
  const [tenancies, units] = await Promise.all([
    prisma.propertywareTenant.findMany({
      where: { organizationId, propertywareBuildingId: buildingId, isActive: true },
      select: {
        leaseName: true,
        zone: true,
        managementPlan: true,
        hvacPlan: true,
        hvacFilterLocation: true,
        hvacFilterSizes: true,
        tbpEnrollment: true,
        lastFilterDelivery: true,
        lastHvacInspection: true,
        lastOccupiedInspection: true,
      },
    }),
    prisma.propertywareUnit.count({ where: { organizationId, buildingId, isActive: true } }),
  ]);
  const named = lease?.leaseName ? tenancies.filter((tenancy) => tenancy.leaseName === lease.leaseName) : [];
  const tenancy = named.length === 1 ? named[0]! : tenancies.length === 1 && units <= 1 ? tenancies[0]! : null;
  return { tenancy, lease, tenantNames: lease?.tenantDisplayNames ?? [] };
}
