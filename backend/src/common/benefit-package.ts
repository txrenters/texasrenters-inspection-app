import { TbpPackageChangeKind, type TbpPackageChangeSource } from '@prisma/client';
import { isTbpZone, zoneNumberOf, type PackageLeftReason } from '@texasrenters/shared';

import { SERVICE_STATUS_VIEW_SELECT } from '../admin/property-service-status';
import { isTbpEnrolled } from '../integrations/propertyware/propertyware.tenant-report';
import type { PrismaService } from './prisma.service';

/**
 * Whether a property is in the tenant benefit package, and when it joined or
 * left (the office, 2026-10-15).
 *
 * One rule, read everywhere a property's place in the package matters -- the
 * Group maker, a quarter's visits, the package changes -- and recorded as it
 * changes, because the nightly tenant sync overwrites a tenancy's enrolment in
 * place and a Yes that became a No used to leave no trace.
 */

/** The office's switches on a property, as `SERVICE_STATUS_VIEW_SELECT` reads them. */
export interface PackageSwitches {
  managementEndedAt: Date | null;
  tbpOptedOutAt: Date | null;
  managementEndedBy: { displayName: string } | null;
  tbpOptedOutBy: { displayName: string } | null;
}

export interface PackageTenancy {
  isActive: boolean;
  tbpEnrollment: string | null;
  zone: string | null;
  deactivatedAt: Date | null;
}

export interface PackageStanding {
  inPackage: boolean;
  /** Why it is not, most telling first; empty when it is. */
  reasons: PackageLeftReason[];
}

/**
 * Whether a building is in the benefit package, and if not, why.
 *
 * The same rule the Group maker and a quarter use (`GroupTemplateService
 * .properties`, `TbpPlanService.enrolledTenancies`): an active tenancy the
 * tenant report enrols (Yes), in a zone the package covers, at a property the
 * office has not switched out. Reasons come most telling first -- the
 * office's own switches, which say when and who, then what Propertyware says.
 */
export function packageStanding(
  switches: PackageSwitches | null | undefined,
  tenancies: readonly PackageTenancy[],
): PackageStanding {
  const reasons: PackageLeftReason[] = [];
  if (switches?.managementEndedAt)
    reasons.push({
      code: 'MANAGEMENT_ENDED',
      since: switches.managementEndedAt.toISOString(),
      by: switches.managementEndedBy?.displayName ?? null,
      detail: null,
    });
  if (switches?.tbpOptedOutAt)
    reasons.push({
      code: 'OPTED_OUT',
      since: switches.tbpOptedOutAt.toISOString(),
      by: switches.tbpOptedOutBy?.displayName ?? null,
      detail: null,
    });

  const active = tenancies.filter((tenancy) => tenancy.isActive);
  const covered = active.filter((tenancy) => isTbpZone(tenancy.zone));
  const enrolled = covered.some((tenancy) => isTbpEnrolled(tenancy.tbpEnrollment));
  if (!active.length) {
    // Off the tenant report: the latest lease to drop off says when.
    const ended = tenancies
      .map((tenancy) => tenancy.deactivatedAt?.getTime() ?? null)
      .filter((at): at is number => at !== null);
    reasons.push({
      code: 'NO_ACTIVE_LEASE',
      since: ended.length ? new Date(Math.max(...ended)).toISOString() : null,
      by: null,
      detail: null,
    });
  } else if (!covered.length) {
    const zones = [...new Set(active.map((tenancy) => zoneNumberOf(tenancy.zone) ?? tenancy.zone?.trim() ?? ''))].filter(Boolean);
    reasons.push({ code: 'ZONE_EXCLUDED', since: null, by: null, detail: zones.map((zone) => `Zone ${zone}`).join(', ') || null });
  } else if (!enrolled) {
    // "Not Verified" is not a no, but it is not the Yes a visit needs either.
    const said = [...new Set(covered.map((tenancy) => tenancy.tbpEnrollment?.trim() || 'blank'))];
    reasons.push({ code: 'NOT_ENROLLED', since: null, by: null, detail: said.join(', ') });
  }
  const switchedOut = Boolean(switches?.managementEndedAt || switches?.tbpOptedOutAt);
  return { inPackage: enrolled && !switchedOut, reasons };
}

type MembershipClient = Pick<PrismaService, 'propertywareTenant' | 'propertyServiceStatus'>;

/**
 * Each building's standing: the ones named, or every building any tenancy is
 * placed at. Read before and after anything that can move a building in or out,
 * so the difference can be recorded (`recordPackageChanges`).
 */
export async function packageMembership(
  client: MembershipClient,
  organizationId: string,
  buildingIds?: readonly string[],
): Promise<Map<string, PackageStanding>> {
  const only = buildingIds ? { in: [...buildingIds] } : undefined;
  const [tenancies, statuses] = await Promise.all([
    client.propertywareTenant.findMany({
      where: { organizationId, propertywareBuildingId: only ?? { not: null } },
      select: { propertywareBuildingId: true, isActive: true, tbpEnrollment: true, zone: true, deactivatedAt: true },
    }),
    client.propertyServiceStatus.findMany({
      where: { organizationId, ...(only ? { buildingId: only } : {}) },
      select: { buildingId: true, ...SERVICE_STATUS_VIEW_SELECT },
    }),
  ]);
  const tenanciesOf = new Map<string, PackageTenancy[]>();
  for (const tenancy of tenancies) {
    const buildingId = tenancy.propertywareBuildingId!;
    tenanciesOf.set(buildingId, [...(tenanciesOf.get(buildingId) ?? []), tenancy]);
  }
  const switchesOf = new Map(statuses.map(({ buildingId, ...switches }) => [buildingId, switches]));
  const ids = new Set([...(buildingIds ?? []), ...tenanciesOf.keys()]);
  return new Map(
    [...ids].map((buildingId) => [buildingId, packageStanding(switchesOf.get(buildingId), tenanciesOf.get(buildingId) ?? [])]),
  );
}

/**
 * The joins and leaves between two readings of the package, written as
 * history: one row per building whose membership changed, none for the rest.
 * A leave keeps its most telling reason, and what the report said instead.
 */
export async function recordPackageChanges(
  client: Pick<PrismaService, 'tbpPackageChange'>,
  organizationId: string,
  before: ReadonlyMap<string, PackageStanding>,
  after: ReadonlyMap<string, PackageStanding>,
  change: { source: TbpPackageChangeSource; actor?: { id: string; name: string } | null; at?: Date },
): Promise<{ joined: number; left: number }> {
  const at = change.at ?? new Date();
  const rows: {
    organizationId: string;
    buildingId: string;
    kind: TbpPackageChangeKind;
    source: TbpPackageChangeSource;
    reason: string | null;
    detail: string | null;
    actorUserId: string | null;
    actorName: string | null;
    occurredAt: Date;
  }[] = [];
  const add = (buildingId: string, kind: TbpPackageChangeKind, reason: PackageLeftReason | null) =>
    rows.push({
      organizationId,
      buildingId,
      kind,
      source: change.source,
      reason: reason?.code ?? null,
      detail: reason?.detail ?? null,
      actorUserId: change.actor?.id ?? null,
      actorName: change.actor?.name ?? null,
      occurredAt: at,
    });
  for (const [buildingId, now] of after) {
    const was = before.get(buildingId)?.inPackage ?? false;
    if (now.inPackage && !was) add(buildingId, TbpPackageChangeKind.JOINED, null);
    else if (!now.inPackage && was) add(buildingId, TbpPackageChangeKind.LEFT, now.reasons[0] ?? null);
  }
  // A building no tenancy is placed at any more: its last one moved to another building.
  for (const [buildingId, was] of before)
    if (was.inPackage && !after.has(buildingId)) add(buildingId, TbpPackageChangeKind.LEFT, null);

  if (rows.length) await client.tbpPackageChange.createMany({ data: rows });
  return {
    joined: rows.filter((row) => row.kind === TbpPackageChangeKind.JOINED).length,
    left: rows.filter((row) => row.kind === TbpPackageChangeKind.LEFT).length,
  };
}

/** A building's recorded joins, or leaves, newest first. */
export async function packageHistory(
  client: Pick<PrismaService, 'tbpPackageChange'>,
  organizationId: string,
  buildingIds: readonly string[],
  kind: TbpPackageChangeKind,
): Promise<Map<string, { reason: string | null; occurredAt: Date }[]>> {
  if (!buildingIds.length) return new Map();
  const changes = await client.tbpPackageChange.findMany({
    where: { organizationId, kind, buildingId: { in: [...buildingIds] } },
    orderBy: { occurredAt: 'desc' },
    select: { buildingId: true, reason: true, occurredAt: true },
  });
  const byBuilding = new Map<string, { reason: string | null; occurredAt: Date }[]>();
  for (const { buildingId, ...change } of changes) byBuilding.set(buildingId, [...(byBuilding.get(buildingId) ?? []), change]);
  return byBuilding;
}

/** When each building's enrolled tenancies first appeared on the tenant report: the earliest of them. ISO timestamps. */
export async function firstOnReport(
  client: Pick<PrismaService, 'propertywareTenant'>,
  organizationId: string,
  buildingIds: readonly string[],
): Promise<Map<string, string>> {
  if (!buildingIds.length) return new Map();
  const tenancies = await client.propertywareTenant.findMany({
    where: { organizationId, isActive: true, propertywareBuildingId: { in: [...buildingIds] } },
    select: { propertywareBuildingId: true, tbpEnrollment: true, zone: true, firstSyncedAt: true },
  });
  const first = new Map<string, Date>();
  for (const tenancy of tenancies) {
    if (!isTbpEnrolled(tenancy.tbpEnrollment) || !isTbpZone(tenancy.zone)) continue;
    const buildingId = tenancy.propertywareBuildingId!;
    const was = first.get(buildingId);
    if (!was || tenancy.firstSyncedAt < was) first.set(buildingId, tenancy.firstSyncedAt);
  }
  return new Map([...first].map(([buildingId, at]) => [buildingId, at.toISOString()]));
}
