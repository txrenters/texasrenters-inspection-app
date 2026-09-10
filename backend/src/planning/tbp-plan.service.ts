import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InspectionType, TbpPlanStatus, TbpStopStatus, TbpUnitResolution } from '@prisma/client';
import type { Prisma, TbpOrderSource } from '@prisma/client';
import {
  MAX_CARRY_BACK_QUARTERS,
  type Quarter,
  type RotationCandidate,
  carryForwardOrder,
  previousQuarter,
  quarterLabel,
  quarterStart,
} from '@texasrenters/shared';

import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import {
  addressKeyCandidates,
  buildAddressIndex,
  buildLooseAddressIndex,
  looseAddressKey,
  matchBuildingWithFallback,
  normalizeAddressKey,
} from '../integrations/jobber/jobber.address';
import { isTbpEnrolled } from '../integrations/propertyware/propertyware.tenant-report';

/**
 * What the office calls the programme, lowercased for the SQL comparison.
 *
 * The same phrase `DEFAULT_VISIT_TYPE_RULES` files under `AC_FILTER_DELIVERY`.
 * Kept as one constant rather than repeated inline so the bootstrap and the
 * classifier cannot end up looking for different things.
 */
const TBP_TITLE_MARKER = 'tenant benefit package';

/**
 * The tenancy fields generation needs, and no more.
 *
 * Selected explicitly rather than taking the whole row because two of these —
 * `hvacFilterSizes` and `zone` — are copied onto the stop and frozen there, and
 * a reader should be able to see at a glance which parts of a tenancy a
 * published plan depends on.
 */
const TENANT_SELECT = {
  id: true,
  externalId: true,
  leaseName: true,
  startDate: true,
  zone: true,
  addressLine1: true,
  postalCode: true,
  hvacFilterSizes: true,
  propertywareBuildingId: true,
} satisfies Prisma.PropertywareTenantSelect;

type PlanTenant = Prisma.PropertywareTenantGetPayload<{ select: typeof TENANT_SELECT }>;

interface ResolvedUnit {
  unitId: string | null;
  leaseId: string | null;
  resolution: TbpUnitResolution;
}

export interface GenerationResult {
  planId: string;
  quarter: Quarter;
  stopCount: number;
  blockedCount: number;
  unverifiedEnrollmentCount: number;
  regenerated: boolean;
}

@Injectable()
export class TbpPlanService {
  private readonly logger = new Logger(TbpPlanService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Build, or rebuild, the draft plan for a quarter.
   *
   * Idempotent by construction: the plan is upserted on
   * `(organization, year, quarter)` and every stop on `(plan, tenancy)`, and
   * the ordering is deterministic. Running this every day inside the planning
   * window produces the same draft, which is what lets the cron be a window
   * rather than a single date it can miss.
   *
   * A plan that is no longer DRAFT is never touched. Once a coordinator has
   * published, the quarter is several hundred real appointments and a
   * regeneration would be rewriting history.
   */
  async generate(organizationId: string, quarter: Quarter): Promise<GenerationResult> {
    const existing = await this.prisma.tbpQuarterPlan.findUnique({
      where: {
        organizationId_quarterYear_quarterNumber: {
          organizationId,
          quarterYear: quarter.year,
          quarterNumber: quarter.quarter,
        },
      },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== TbpPlanStatus.DRAFT)
      throw new ApplicationError(
        409,
        'PLAN_NOT_DRAFT',
        `The ${quarterLabel(quarter)} plan is ${existing.status.toLowerCase()} and cannot be regenerated.`,
      );

    const { enrolled, unverified } = await this.enrolledTenancies(organizationId);
    const priorQuarters = await this.ordersForRotation(organizationId, quarter);
    const ranked = carryForwardOrder(enrolled.map(rotationCandidate), priorQuarters);

    const byExternalId = new Map(enrolled.map((tenant) => [tenant.externalId, tenant]));
    const generationRunId = randomUUID();

    const plan = await this.prisma.tbpQuarterPlan.upsert({
      where: {
        organizationId_quarterYear_quarterNumber: {
          organizationId,
          quarterYear: quarter.year,
          quarterNumber: quarter.quarter,
        },
      },
      create: {
        organizationId,
        quarterYear: quarter.year,
        quarterNumber: quarter.quarter,
        quarterStartsOn: quarterStart(quarter),
        generationRunId,
        // A seed, not a constant: k-means++ needs randomness to escape a bad
        // start, and storing the draw is what makes the result reproducible.
        randomSeed: Math.floor(Math.random() * 2_147_483_647),
        unverifiedEnrollmentCount: unverified,
      },
      update: { generationRunId, generatedAt: new Date(), unverifiedEnrollmentCount: unverified },
      select: { id: true },
    });

    let blockedCount = 0;
    // Sequentially, in chunks. Unit resolution is several queries per tenancy
    // and there are a few hundred of them; firing them all at once buys
    // nothing and risks exhausting the pool the rest of the API is sharing.
    for (const batch of chunk(ranked, 25)) {
      for (const stop of batch) {
        const tenant = byExternalId.get(stop.tenantExternalId);
        if (!tenant) continue;
        const blocked = await this.upsertStop(organizationId, plan.id, tenant, stop, quarter);
        if (blocked) blockedCount += 1;
      }
    }

    // Anything left from a previous run whose tenancy is no longer enrolled.
    // Only untouched, unpublished stops: a coordinator's edit or a published
    // row is a decision, and a regeneration must not quietly reverse it.
    const { count: removed } = await this.prisma.tbpQuarterPlanStop.deleteMany({
      where: {
        planId: plan.id,
        status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.BLOCKED] },
        inspectionId: null,
        propertywareTenantId: { notIn: enrolled.map((tenant) => tenant.id) },
        sequenceOverriddenAt: null,
        scheduleOverriddenAt: null,
        technicianOverriddenAt: null,
      },
    });

    const stopCount = await this.prisma.tbpQuarterPlanStop.count({ where: { planId: plan.id } });
    await this.prisma.tbpQuarterPlan.update({
      where: { id: plan.id },
      data: { stopCount, blockedCount },
    });

    this.logger.log({
      event: 'tbp_plan_generated',
      organizationId,
      quarter: quarterLabel(quarter),
      planId: plan.id,
      regenerated: Boolean(existing),
      stopCount,
      blockedCount,
      unverifiedEnrollmentCount: unverified,
      removedUnenrolled: removed,
    });

    return {
      planId: plan.id,
      quarter,
      stopCount,
      blockedCount,
      unverifiedEnrollmentCount: unverified,
      regenerated: Boolean(existing),
    };
  }

  /**
   * Tenancies the office has confirmed are enrolled, plus a count of the ones
   * nobody has checked.
   *
   * `Not Verified` is Propertyware's third value and it is neither a yes nor a
   * no. Those tenancies get no stop — booking a visit somebody may not be
   * paying for is the worse error — but they are counted so the console can
   * say so rather than letting them vanish between the tenant list and the
   * plan.
   */
  private async enrolledTenancies(organizationId: string) {
    const tenancies = await this.prisma.propertywareTenant.findMany({
      where: { organizationId, isActive: true },
      select: { ...TENANT_SELECT, tbpEnrollment: true },
      orderBy: { externalId: 'asc' },
    });

    const enrolled: PlanTenant[] = [];
    let unverified = 0;
    for (const tenancy of tenancies) {
      const { tbpEnrollment, ...rest } = tenancy;
      if (isTbpEnrolled(tbpEnrollment)) enrolled.push(rest);
      else if ((tbpEnrollment ?? '').trim().toLowerCase() !== 'no') unverified += 1;
    }
    return { enrolled, unverified };
  }

  /**
   * Earlier quarters' orders, newest first, falling back to Jobber's own
   * history for the first quarter this system plans.
   *
   * Without the fallback the first plan would treat every enrolled tenancy as a
   * new enrolment and order the lot alphabetically by zone — discarding the
   * rotation the office has actually been running and moving every tenant to a
   * different point in the year. That is the one quarter where getting it wrong
   * is most visible, and the data to get it right already exists.
   */
  private async ordersForRotation(organizationId: string, quarter: Quarter) {
    const published = await this.priorOrders(organizationId, quarter);
    if (published.length > 0) return published;

    const bootstrapped = await this.bootstrapOrderFromJobber(organizationId, quarter);
    return bootstrapped.length > 0 ? [bootstrapped] : [];
  }

  /**
   * Last quarter's order, recovered from the visits Jobber already ran.
   *
   * Benefit-package visits type as `AC_FILTER_DELIVERY`, which is in
   * `TYPES_NOT_SYNCED`, so there are no `Inspection` rows to read and no plans
   * of our own yet. But `processVisit` upserts `JobberVisitImport.payload` for
   * *every* visit it sees, before any of the skip branches — so the full title,
   * address and start time of every benefit-package visit is sitting there
   * regardless of the row being marked `SKIPPED_NOT_SYNCED`. It is the only
   * surviving record of the order the office ran, and this reads it.
   *
   * Runs only when no plan of ours has been published. Once one has, that is a
   * better answer and this never runs again.
   */
  private async bootstrapOrderFromJobber(organizationId: string, quarter: Quarter) {
    const previous = previousQuarter(quarter);
    const from = quarterStart(previous);
    const to = quarterStart(quarter);

    // Ordering lexicographically on the raw string, which is safe *here* and
    // only because it was checked: every `startAt` in this table ends in `Z`,
    // so the text sorts the same way the instants do. A mixed-offset feed would
    // silently interleave the quarter, so this is asserted below rather than
    // assumed.
    const visits = await this.prisma.$queryRaw<
      {
        startAt: string;
        street1: string | null;
        street2: string | null;
        postalCode: string | null;
      }[]
    >`
      SELECT payload->>'startAt' AS "startAt",
             payload->'property'->'address'->>'street1'    AS street1,
             payload->'property'->'address'->>'street2'    AS street2,
             payload->'property'->'address'->>'postalCode' AS "postalCode"
      FROM "JobberVisitImport"
      WHERE "organizationId" = ${organizationId}::uuid
        AND lower(payload->>'title') LIKE ${`%${TBP_TITLE_MARKER}%`}
        AND payload->>'startAt' >= ${from.toISOString()}
        AND payload->>'startAt' <  ${to.toISOString()}
      ORDER BY payload->>'startAt' ASC
    `;
    if (visits.length === 0) return [];

    const offending = visits.filter((visit) => !isUtcTimestamp(visit.startAt)).length;
    if (offending > 0) {
      // Refuse rather than produce a plausible wrong order. A rotation built
      // from an interleaved quarter looks entirely normal and moves hundreds of
      // tenants to the wrong week.
      this.logger.warn({
        event: 'tbp_rotation_bootstrap_refused',
        reason: 'Some Jobber startAt values are not UTC, so text ordering is not chronological.',
        offending,
      });
      return [];
    }

    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId },
      select: { id: true, addressLine1: true, postalCode: true },
    });
    const strict = buildAddressIndex(buildings);
    const loose = buildLooseAddressIndex(buildings);

    // A building can hold more than one enrolled tenancy, and a visit carries
    // an address rather than a lease — so there is no tiebreak here that would
    // not be a guess. Those buildings are skipped and their tenancies start as
    // new enrolments, which is the honest answer to "we cannot tell which of
    // these two this visit was for".
    const tenancies = await this.prisma.propertywareTenant.findMany({
      where: { organizationId, isActive: true },
      select: { externalId: true, propertywareBuildingId: true, tbpEnrollment: true },
    });
    const byBuilding = new Map<string, string[]>();
    for (const tenancy of tenancies) {
      if (!tenancy.propertywareBuildingId || !isTbpEnrolled(tenancy.tbpEnrollment)) continue;
      const held = byBuilding.get(tenancy.propertywareBuildingId);
      if (held) held.push(tenancy.externalId);
      else byBuilding.set(tenancy.propertywareBuildingId, [tenancy.externalId]);
    }

    const { ranks, unmatchedAddress, ambiguousBuilding } = rankBootstrapVisits(
      visits,
      (visit) => {
        const match = matchBuildingWithFallback(
          strict,
          loose,
          // Jobber splits a unit onto its own line while Propertyware writes it
          // inline, so both the unit-bearing and street-only keys are tried,
          // most specific first.
          addressKeyCandidates(visit.street1, visit.street2, visit.postalCode),
          looseAddressKey(visit.street1, visit.postalCode),
        );
        if (match.outcome !== 'MATCHED') return 'NO_ADDRESS_MATCH';
        const candidates = byBuilding.get(match.buildingId) ?? [];
        return candidates.length === 1 ? candidates[0] : 'AMBIGUOUS_BUILDING';
      },
    );

    this.logger.log({
      event: 'tbp_rotation_bootstrapped_from_jobber',
      organizationId,
      fromQuarter: quarterLabel(previous),
      visitsFound: visits.length,
      ranked: ranks.length,
      unmatchedAddress,
      ambiguousBuilding,
    });

    return ranks;
  }

  /**
   * Earlier quarters' orders, newest first.
   *
   * Read from `TbpQuarterPlanStop` rather than from `Inspection`: this is the
   * order that was actually published, and it survives an inspection being
   * cancelled or deleted afterwards. Only PUBLISHED plans count — a draft
   * somebody abandoned is not evidence of anything.
   */
  private async priorOrders(organizationId: string, quarter: Quarter) {
    const wanted: Quarter[] = [];
    let cursor = quarter;
    for (let index = 0; index < MAX_CARRY_BACK_QUARTERS; index += 1) {
      cursor = previousQuarter(cursor);
      wanted.push(cursor);
    }

    const plans = await this.prisma.tbpQuarterPlan.findMany({
      where: {
        organizationId,
        status: TbpPlanStatus.PUBLISHED,
        OR: wanted.map((entry) => ({ quarterYear: entry.year, quarterNumber: entry.quarter })),
      },
      select: {
        quarterYear: true,
        quarterNumber: true,
        stops: {
          // A stop the coordinator excluded was a decision not to inspect, not
          // a position in the queue. Including it would hand next quarter a
          // rank for work that never happened.
          where: { status: { not: TbpStopStatus.EXCLUDED } },
          select: { tenantExternalId: true, sequence: true },
          orderBy: { sequence: 'asc' },
        },
      },
    });

    const byQuarter = new Map(
      plans.map((plan) => [`${plan.quarterYear}-${plan.quarterNumber}`, plan.stops]),
    );
    return wanted
      .map((entry) => byQuarter.get(`${entry.year}-${entry.quarter}`) ?? [])
      .filter((stops) => stops.length > 0);
  }

  /**
   * Write one stop, leaving anything a coordinator has touched alone.
   *
   * Returns whether the stop is blocked.
   */
  private async upsertStop(
    organizationId: string,
    planId: string,
    tenant: PlanTenant,
    ranked: { sequence: number; previousSequence: number | null; orderSource: string },
    quarter: Quarter,
  ) {
    const existing = await this.prisma.tbpQuarterPlanStop.findUnique({
      where: { planId_propertywareTenantId: { planId, propertywareTenantId: tenant.id } },
      select: {
        id: true,
        status: true,
        sequenceOverriddenAt: true,
        inspectionId: true,
      },
    });

    // Published or excluded stops are settled. Nothing a regeneration computes
    // is worth reopening a decision or a real appointment.
    if (
      existing &&
      (existing.inspectionId ||
        existing.status === TbpStopStatus.PUBLISHED ||
        existing.status === TbpStopStatus.EXCLUDED)
    )
      return false;

    const unit = tenant.propertywareBuildingId
      ? await this.resolveUnit(organizationId, tenant)
      : { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };

    const blocked = !tenant.propertywareBuildingId
      ? { code: 'NO_BUILDING', message: 'This tenancy is not linked to a building.' }
      : unit.resolution === TbpUnitResolution.UNRESOLVED
        ? {
            code: 'UNIT_REQUIRED',
            message: 'This building has several units and none of them matched this tenancy.',
          }
        : null;

    const shared = {
      previousSequence: ranked.previousSequence,
      orderSource: ranked.orderSource as TbpOrderSource,
      zone: tenant.zone,
      propertywareBuildingId: tenant.propertywareBuildingId,
      propertywareUnitId: unit.unitId,
      propertywareLeaseId: unit.leaseId,
      unitResolution: unit.resolution,
      hvacFilterSizes: tenant.hvacFilterSizes,
      visitTitle: visitTitle(tenant, quarter),
      visitDetails: visitDetails(tenant),
      status: blocked ? TbpStopStatus.BLOCKED : TbpStopStatus.PLANNED,
      blockedCode: blocked?.code ?? null,
      blockedMessage: blocked?.message ?? null,
    };

    await this.prisma.tbpQuarterPlanStop.upsert({
      where: { planId_propertywareTenantId: { planId, propertywareTenantId: tenant.id } },
      create: {
        organizationId,
        planId,
        propertywareTenantId: tenant.id,
        tenantExternalId: tenant.externalId,
        sequence: ranked.sequence,
        ...shared,
      },
      // A coordinator who dragged this stop decided where it goes. Recomputing
      // its sequence would silently undo that on the next fortnightly run,
      // which is the single most annoying thing an automation can do.
      update: existing?.sequenceOverriddenAt ? shared : { sequence: ranked.sequence, ...shared },
    });

    return Boolean(blocked);
  }

  /**
   * Which unit a tenancy is in.
   *
   * `PropertywareTenant` records a building and nothing finer — there is no
   * unit and no lease on a tenancy row — while `resolveInspectionPlan` refuses
   * any multi-unit building without one. This ladder is what bridges that, and
   * every rung is recorded rather than inferred: `SOLE_UNIT` and `LEASE_MATCH`
   * are the same answer reached with very different confidence, and when a
   * technician is sent to the wrong door that difference is the first thing
   * worth knowing.
   *
   * Nothing here guesses. An unresolved tenancy is blocked and stays in the
   * plan for a person to fix, because a tenancy dropped quietly is one nobody
   * inspects for a year.
   */
  private async resolveUnit(organizationId: string, tenant: PlanTenant): Promise<ResolvedUnit> {
    const buildingId = tenant.propertywareBuildingId;
    if (!buildingId) return { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };

    const units = await this.prisma.propertywareUnit.findMany({
      where: { organizationId, buildingId, isActive: true },
      select: { id: true },
    });

    // A building with no units of its own is inspected as the building, which
    // `resolveInspectionPlan` accepts.
    if (units.length === 0)
      return { unitId: null, leaseId: null, resolution: TbpUnitResolution.NO_UNITS };

    // The tenancy's own key is sha256(leaseName | startDate | address), so the
    // lease it came from carries the same two fields. This is an exact match,
    // not an approximation.
    const leases = await this.prisma.propertywareLease.findMany({
      where: {
        organizationId,
        buildingId,
        isActive: true,
        leaseName: tenant.leaseName,
        ...(tenant.startDate ? { startDate: tenant.startDate } : {}),
        unitId: { not: null },
      },
      select: { id: true, unitId: true },
    });
    if (leases.length === 1 && leases[0].unitId)
      return {
        unitId: leases[0].unitId,
        leaseId: leases[0].id,
        resolution: TbpUnitResolution.LEASE_MATCH,
      };

    if (units.length === 1)
      return { unitId: units[0].id, leaseId: null, resolution: TbpUnitResolution.SOLE_UNIT };

    // Somebody has already inspected this tenancy and named a unit. That is a
    // human answer to the same question, and it is better than none.
    const prior = await this.prisma.inspection.findFirst({
      where: {
        organizationId,
        propertywareBuildingId: buildingId,
        propertywareUnitId: { not: null },
        inspectionType: InspectionType.OCCUPIED,
        propertywareLease: { leaseName: tenant.leaseName },
      },
      orderBy: { scheduledAt: 'desc' },
      select: { propertywareUnitId: true, propertywareLeaseId: true },
    });
    if (prior?.propertywareUnitId)
      return {
        unitId: prior.propertywareUnitId,
        leaseId: prior.propertywareLeaseId,
        resolution: TbpUnitResolution.PRIOR_INSPECTION,
      };

    return { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };
  }
}

/**
 * One benefit-package visit as it survives in `JobberVisitImport.payload`.
 */
export interface BootstrapVisit {
  startAt: string;
  street1: string | null;
  street2: string | null;
  postalCode: string | null;
}

/**
 * Why a visit could not be turned into a place in the queue.
 *
 * Two distinct failures, counted separately because they need different fixes:
 * an address we hold no building for is a mapping gap, while a building with
 * two enrolled tenancies is a question no address can answer.
 */
export type BootstrapResolution = string | 'NO_ADDRESS_MATCH' | 'AMBIGUOUS_BUILDING';

/**
 * Whether a Jobber timestamp is UTC, and therefore safe to order as text.
 *
 * The bootstrap sorts on the raw string in SQL, which is only chronological if
 * every value shares an offset. Every `startAt` in the live table ends in `Z`,
 * but a feed that started mixing offsets would interleave the quarter while
 * looking entirely normal — so this is checked rather than assumed.
 */
export function isUtcTimestamp(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.endsWith('Z');
}

/**
 * Turn a quarter's visits, already in chronological order, into positions.
 *
 * Separated from the database work so the three decisions here — order,
 * de-duplication, and what counts as unresolvable — can be tested without a
 * Prisma fake. The address matching itself is `jobber.address`'s job and is
 * tested there.
 */
export function rankBootstrapVisits(
  visits: readonly BootstrapVisit[],
  resolveTenant: (visit: BootstrapVisit) => BootstrapResolution,
) {
  const ranks: { tenantExternalId: string; sequence: number }[] = [];
  const seen = new Set<string>();
  let unmatchedAddress = 0;
  let ambiguousBuilding = 0;

  for (const visit of visits) {
    const resolved = resolveTenant(visit);
    if (resolved === 'NO_ADDRESS_MATCH') {
      unmatchedAddress += 1;
      continue;
    }
    if (resolved === 'AMBIGUOUS_BUILDING') {
      ambiguousBuilding += 1;
      continue;
    }
    // A property visited twice in a quarter keeps its first position: the
    // second visit is a repeat of the same work, not a later place in the
    // queue.
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    ranks.push({ tenantExternalId: resolved, sequence: ranks.length + 1 });
  }

  return { ranks, unmatchedAddress, ambiguousBuilding };
}

const rotationCandidate = (tenant: PlanTenant): RotationCandidate => ({
  tenantExternalId: tenant.externalId,
  zone: tenant.zone,
  // The same normaliser the Jobber and Propertyware syncs share. A second one
  // here would let a stop and a visit disagree about the same address with
  // nothing to report it.
  addressKey: normalizeAddressKey(tenant.addressLine1, tenant.postalCode) || null,
});

/**
 * The title the office already reads in Jobber.
 *
 * Reproduced rather than improved on: a real one is
 * `19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package`, and the
 * technicians and coordinators have been reading that shape for as long as the
 * programme has run. A tidier format would be a change nobody asked for, on the
 * one string every person in this workflow sees.
 */
export function visitTitle(
  tenant: Pick<PlanTenant, 'addressLine1' | 'zone'>,
  quarter: Quarter,
): string {
  const address = tenant.addressLine1?.trim() || 'Unknown address';
  const zone = tenant.zone?.trim();
  return [address, zone, `${quarterLabel(quarter)} Tenant Benefit Package`]
    .filter(Boolean)
    .join(' - ');
}

/**
 * The details line, which is what makes this an occupied inspection here.
 *
 * `occupiedInspectionInDetails` looks for exactly this phrase — the title says
 * only "Tenant Benefit Package", which types as a filter delivery and is never
 * imported. Change the wording and the visits we create stop becoming
 * inspections, silently.
 */
export function visitDetails(tenant: Pick<PlanTenant, 'hvacFilterSizes'>): string {
  const filters = tenant.hvacFilterSizes.filter(Boolean).join(' + ');
  return [filters ? `Filter Change: ${filters}` : 'Filter Change', 'Pest Control', 'Occupied Inspection'].join(
    ' + ',
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
