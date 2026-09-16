import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InspectionType, TbpPlanStatus, TbpStopStatus, TbpUnitResolution } from '@prisma/client';
import type { Prisma, TbpOrderSource } from '@prisma/client';
import {
  MAX_CARRY_BACK_QUARTERS,
  type PriorRank,
  type Quarter,
  type RotationCandidate,
  type TbpInspectionReason,
  type TbpInspectionType,
  carryForwardOrder,
  detailsNamingInspection,
  previousQuarter,
  quarterLabel,
  quarterStart,
  tbpInspectionFor,
  tbpServicesLine,
  tbpServicesLineFromTenancy,
  tbpVisitDetails,
  tenancyZoneLabel,
  unitFilterSizes,
} from '@texasrenters/shared';

import { type AuthenticatedUser, auditActor } from '../common/auth';
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
 * Selected explicitly rather than taking the whole row because several of these
 * -- the filter sizes, the zone, the plans the visit's type is decided from --
 * are copied onto the stop and frozen there, and a reader should be able to see
 * at a glance which parts of a tenancy a published plan depends on.
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
  hvacFilterLocation: true,
  managementPlan: true,
  hvacPlan: true,
  propertywareBuildingId: true,
} satisfies Prisma.PropertywareTenantSelect;

type PlanTenant = Prisma.PropertywareTenantGetPayload<{ select: typeof TENANT_SELECT }>;

interface ResolvedUnit {
  unitId: string | null;
  leaseId: string | null;
  resolution: TbpUnitResolution;
  /** The unit's name and address, and every unit of its building, when a unit was found. */
  unit?: { name: string; addressLine1: string | null } | null;
  units?: { name: string; addressLine1: string | null }[];
}

export interface GenerationResult {
  planId: string;
  quarter: Quarter;
  stopCount: number;
  blockedCount: number;
  unverifiedEnrollmentCount: number;
  regenerated: boolean;
}

/** One row of the office's sheet of visit Details for a quarter. */
export interface OfficeDetailsRow {
  address: string;
  city?: string | null;
  postalCode?: string | null;
  details: string;
}

type OfficeDetailsAddress = Pick<OfficeDetailsRow, 'address' | 'city' | 'postalCode'>;

/** What an import of the office's sheet matched, for the coordinator to check. */
export interface OfficeDetailsImport {
  planId: string;
  rows: number;
  matched: number;
  unmatched: OfficeDetailsAddress[];
  ambiguous: OfficeDetailsAddress[];
  duplicates: OfficeDetailsAddress[];
  stopsWithoutOfficeDetails: number;
}

/** The most rows one sheet may hold: the programme is a few hundred tenancies. */
export const MAX_OFFICE_DETAILS_ROWS = 2000;

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
    const previousTechnician = previousTechnicians(priorQuarters);

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
      select: { id: true, officeDetailsRows: true },
    });

    const office = matchOfficeDetails(officeRowsFrom(plan.officeDetailsRows), enrolled);

    let blockedCount = 0;
    // Sequentially, in chunks. Unit resolution is several queries per tenancy
    // and there are a few hundred of them; firing them all at once buys
    // nothing and risks exhausting the pool the rest of the API is sharing.
    for (const batch of chunk(ranked, 25)) {
      for (const stop of batch) {
        const tenant = byExternalId.get(stop.tenantExternalId);
        if (!tenant) continue;
        const blocked = await this.upsertStop(organizationId, plan.id, tenant, stop, quarter, {
          officeDetails: office.byTenantId.get(tenant.id) ?? null,
          previousTechnicianId: previousTechnician.get(tenant.externalId) ?? null,
        });
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
        inspectionTypeOverriddenAt: null,
        visitTitleOverriddenAt: null,
        visitDetailsOverriddenAt: null,
        onSiteMinutesOverriddenAt: null,
        unitOverriddenAt: null,
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
      officeDetailsMatched: office.byTenantId.size,
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
   * Take the office's sheet of visit Details for the quarter.
   *
   * The office writes each tenancy's services line by hand -- "Filter Change:
   * 20x25x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC
   * Plan)" -- and those are the Details the quarter's visits carry (the office,
   * 2026-09-16), with the inspection made an HVAC inspection where the rule
   * applies. A tenancy the sheet does not cover gets a line written the same
   * way from the tenant report.
   *
   * The rows are kept whole on the plan, so a regeneration matches them to the
   * tenancies it adds; importing again replaces them. Only a draft takes a
   * sheet: a published stop's Details are what Jobber was sent.
   */
  async importOfficeDetails(
    user: AuthenticatedUser,
    planId: string,
    input: readonly OfficeDetailsRow[],
  ): Promise<OfficeDetailsImport> {
    const organizationId = user.organizationId;
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { id: true, status: true },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    if (plan.status !== TbpPlanStatus.DRAFT)
      throw new ApplicationError(409, 'PLAN_NOT_DRAFT', 'Visit Details can only be imported into a draft plan.');
    if (input.length > MAX_OFFICE_DETAILS_ROWS)
      throw new ApplicationError(
        422,
        'TOO_MANY_ROWS',
        `A sheet can hold at most ${MAX_OFFICE_DETAILS_ROWS} rows; this one has ${input.length}.`,
      );

    const rows = cleanOfficeRows(input);
    await this.prisma.tbpQuarterPlan.update({
      where: { id: plan.id },
      data: { officeDetailsRows: rows as unknown as Prisma.InputJsonValue, officeDetailsImportedAt: new Date() },
    });

    const stops = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId: plan.id, organizationId },
      select: {
        id: true,
        status: true,
        inspectionId: true,
        inspectionType: true,
        hvacFilterSizes: true,
        visitDetailsOverriddenAt: true,
        tenant: { select: TENANT_SELECT },
      },
    });
    // Matched against every stop, published or not, so a row for a tenancy the
    // coordinator excluded is not reported as an address nobody recognises.
    const match = matchOfficeDetails(
      rows,
      stops.map((stop) => stop.tenant),
    );

    let withoutOfficeDetails = 0;
    for (const stop of stops) {
      if (!editableStop(stop)) continue;
      const officeDetails = match.byTenantId.get(stop.tenant.id) ?? null;
      if (!officeDetails) withoutOfficeDetails += 1;
      await this.prisma.tbpQuarterPlanStop.update({
        where: { id: stop.id },
        // Details a coordinator wrote are sent as written; the sheet's line is
        // still kept on the stop, beside them.
        data: stop.visitDetailsOverriddenAt
          ? { officeDetails }
          : {
              officeDetails,
              visitDetails: planVisitDetails(
                { ...stop.tenant, hvacFilterSizes: stop.hvacFilterSizes },
                stop.inspectionType as TbpInspectionType,
                officeDetails,
              ),
            },
      });
    }

    const summary: OfficeDetailsImport = {
      planId: plan.id,
      rows: rows.length,
      matched: match.byTenantId.size,
      unmatched: match.unmatched.map(addressOf),
      ambiguous: match.ambiguous.map(addressOf),
      duplicates: match.duplicates.map(addressOf),
      stopsWithoutOfficeDetails: withoutOfficeDetails,
    };

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        ...auditActor(user),
        action: 'TBP_PLAN_OFFICE_DETAILS_IMPORTED',
        entityType: 'TbpQuarterPlan',
        entityId: plan.id,
        // Counts only: the rows carry addresses and whatever the office typed.
        metadata: {
          rows: summary.rows,
          matched: summary.matched,
          unmatched: summary.unmatched.length,
          ambiguous: summary.ambiguous.length,
          duplicates: summary.duplicates.length,
          stopsWithoutOfficeDetails: withoutOfficeDetails,
        },
      },
    });

    return summary;
  }

  /**
   * A coordinator deciding a stop is an HVAC or an occupied inspection.
   *
   * The rule reads a tenant report typed by hand, and some tenancies are
   * flagged for exactly this -- a BX plan "On our AC Plan", say. The choice
   * sticks through regeneration, and the Details follow it: Details a
   * coordinator wrote keep their words, with only the inspection on their
   * services line renamed. A length a coordinator set stays. The day it sits on
   * is measured again by `TbpStopEditService`, which is how the console asks.
   */
  async setInspectionType(user: AuthenticatedUser, stopId: string, inspectionType: TbpInspectionType) {
    const stop = await this.prisma.tbpQuarterPlanStop.findFirst({
      where: { id: stopId, organizationId: user.organizationId },
      select: {
        id: true,
        planId: true,
        status: true,
        inspectionId: true,
        inspectionType: true,
        officeDetails: true,
        visitDetails: true,
        visitDetailsOverriddenAt: true,
        onSiteMinutesOverriddenAt: true,
        hvacFilterSizes: true,
        plan: { select: { status: true, occupiedVisitMinutes: true, hvacVisitMinutes: true } },
        tenant: { select: TENANT_SELECT },
      },
    });
    if (!stop) throw new ApplicationError(404, 'STOP_NOT_FOUND', 'This stop does not exist.');
    if (stop.plan.status !== TbpPlanStatus.DRAFT || !editableStop(stop))
      throw new ApplicationError(
        409,
        'STOP_NOT_EDITABLE',
        'Only a stop in a draft plan that has not been published or excluded can change type.',
      );

    const reason: TbpInspectionReason = 'SET_BY_COORDINATOR';
    const updated = await this.prisma.tbpQuarterPlanStop.update({
      where: { id: stop.id },
      data: {
        inspectionType,
        inspectionTypeReason: reason,
        inspectionTypeNeedsReview: false,
        inspectionTypeOverriddenAt: new Date(),
        ...(stop.onSiteMinutesOverriddenAt
          ? {}
          : { onSiteMinutes: inspectionType === 'HVAC' ? stop.plan.hvacVisitMinutes : stop.plan.occupiedVisitMinutes }),
        visitDetails:
          stop.visitDetailsOverriddenAt && stop.visitDetails
            ? detailsNamingInspection(
                stop.visitDetails,
                inspectionType,
                servicesLineFor({ ...stop.tenant, hvacFilterSizes: stop.hvacFilterSizes }, inspectionType, stop.officeDetails),
              )
            : planVisitDetails({ ...stop.tenant, hvacFilterSizes: stop.hvacFilterSizes }, inspectionType, stop.officeDetails),
      },
      select: { id: true, inspectionType: true, inspectionTypeReason: true, onSiteMinutes: true, visitDetails: true },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action: 'TBP_PLAN_STOP_TYPE_SET',
        entityType: 'TbpQuarterPlanStop',
        entityId: stop.id,
        metadata: { planId: stop.planId, from: stop.inspectionType, to: inspectionType },
      },
    });

    return updated;
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
  private async ordersForRotation(organizationId: string, quarter: Quarter): Promise<PriorRank[][]> {
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
  private async bootstrapOrderFromJobber(organizationId: string, quarter: Quarter): Promise<PriorRank[]> {
    const previous = previousQuarter(quarter);
    const from = quarterStart(previous);
    const to = quarterStart(quarter);

    // Ordering lexicographically on the raw string, which is safe *here* and
    // only because it was checked: every `startAt` in this table ends in `Z`,
    // so the text sorts the same way the instants do. A mixed-offset feed would
    // silently interleave the quarter, so this is asserted below rather than
    // assumed.
    const visits = await this.prisma.$queryRaw<BootstrapVisit[]>`
      SELECT payload->>'startAt' AS "startAt",
             payload->'property'->'address'->>'street1'    AS street1,
             payload->'property'->'address'->>'street2'    AS street2,
             payload->'property'->'address'->>'postalCode' AS "postalCode",
             payload->'assignedUsers'->'nodes'->0->'email'->>'raw' AS "technicianEmail"
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

    // Who ran each visit, as one of our technicians. Matched by email, as the
    // booking does; an assignee with no account here is simply not preferred.
    const emails = [
      ...new Set(ranks.map((rank) => rank.technicianEmail?.toLowerCase()).filter((email): email is string => Boolean(email))),
    ];
    const technicians = emails.length
      ? await this.prisma.userProfile.findMany({
          where: {
            email: { in: emails, mode: 'insensitive' },
            memberships: { some: { organizationId } },
          },
          select: { id: true, email: true },
        })
      : [];
    const technicianByEmail = new Map(technicians.map((technician) => [technician.email.toLowerCase(), technician.id]));
    const technicianOf = (email: string | undefined) => (email ? (technicianByEmail.get(email.toLowerCase()) ?? null) : null);

    this.logger.log({
      event: 'tbp_rotation_bootstrapped_from_jobber',
      organizationId,
      fromQuarter: quarterLabel(previous),
      visitsFound: visits.length,
      ranked: ranks.length,
      unmatchedAddress,
      ambiguousBuilding,
      withTechnician: ranks.filter((rank) => technicianOf(rank.technicianEmail)).length,
    });

    return ranks.map(({ technicianEmail, ...rank }) => ({ ...rank, technicianId: technicianOf(technicianEmail) }));
  }

  /**
   * Earlier quarters' orders, newest first.
   *
   * Read from `TbpQuarterPlanStop` rather than from `Inspection`: this is the
   * order that was actually published, and it survives an inspection being
   * cancelled or deleted afterwards. Only PUBLISHED plans count — a draft
   * somebody abandoned is not evidence of anything.
   */
  private async priorOrders(organizationId: string, quarter: Quarter): Promise<PriorRank[][]> {
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
          select: { tenantExternalId: true, sequence: true, assignedTechnicianId: true },
          orderBy: { sequence: 'asc' },
        },
      },
    });

    const byQuarter = new Map(
      plans.map((plan) => [
        `${plan.quarterYear}-${plan.quarterNumber}`,
        plan.stops.map((stop) => ({
          tenantExternalId: stop.tenantExternalId,
          sequence: stop.sequence,
          technicianId: stop.assignedTechnicianId,
        })),
      ]),
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
    context: { officeDetails: string | null; previousTechnicianId: string | null },
  ) {
    const existing = await this.prisma.tbpQuarterPlanStop.findUnique({
      where: { planId_propertywareTenantId: { planId, propertywareTenantId: tenant.id } },
      select: {
        id: true,
        status: true,
        sequenceOverriddenAt: true,
        inspectionId: true,
        inspectionType: true,
        inspectionTypeOverriddenAt: true,
        visitDetails: true,
        visitTitleOverriddenAt: true,
        visitDetailsOverriddenAt: true,
        propertywareUnitId: true,
        unitOverriddenAt: true,
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

    // The unit a coordinator chose stands: nothing in the reports can say better.
    const unit = tenant.propertywareBuildingId
      ? existing?.unitOverriddenAt && existing.propertywareUnitId
        ? await this.chosenUnit(organizationId, tenant.propertywareBuildingId, existing.propertywareUnitId)
        : await this.resolveUnit(organizationId, tenant)
      : { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };

    const blocked = !tenant.propertywareBuildingId
      ? { code: 'NO_BUILDING', message: 'This tenancy is not linked to a building.' }
      : unit.resolution === TbpUnitResolution.UNRESOLVED
        ? {
            code: 'UNIT_REQUIRED',
            message: 'This building has several units, and Propertyware does not say which this tenancy is in. Open the visit and choose its unit.',
          }
        : null;

    // A coordinator who chose the type decided it; the rule does not get to
    // undo that on the next run.
    const decided = existing?.inspectionTypeOverriddenAt
      ? {
          inspectionType: existing.inspectionType as TbpInspectionType,
          reason: 'SET_BY_COORDINATOR' as const,
          needsReview: false,
        }
      : tbpInspectionFor(quarter.quarter, tenant);

    // In a building of several units, the unit's own filter sizes, where the
    // office labels the building's by unit.
    const sizes = unit.unit && unit.units ? (unitFilterSizes(tenant.hvacFilterSizes, unit.unit, unit.units) ?? tenant.hvacFilterSizes) : tenant.hvacFilterSizes;
    const sized = { ...tenant, hvacFilterSizes: sizes };
    // A coordinator's title and Details are sent as written; only the
    // inspection on the Details' services line follows a new kind of visit.
    const details =
      existing?.visitDetailsOverriddenAt && existing.visitDetails
        ? existing.inspectionType === decided.inspectionType
          ? existing.visitDetails
          : detailsNamingInspection(
              existing.visitDetails,
              decided.inspectionType,
              servicesLineFor(sized, decided.inspectionType, context.officeDetails),
            )
        : planVisitDetails(sized, decided.inspectionType, context.officeDetails);

    const shared = {
      previousSequence: ranked.previousSequence,
      orderSource: ranked.orderSource as TbpOrderSource,
      zone: tenant.zone,
      propertywareBuildingId: tenant.propertywareBuildingId,
      propertywareUnitId: unit.unitId,
      propertywareLeaseId: unit.leaseId,
      unitResolution: unit.resolution,
      hvacFilterSizes: sizes,
      inspectionType: decided.inspectionType,
      inspectionTypeReason: decided.reason,
      inspectionTypeNeedsReview: decided.needsReview,
      previousTechnicianId: context.previousTechnicianId,
      officeDetails: context.officeDetails,
      ...(existing?.visitTitleOverriddenAt
        ? {}
        : {
            // A unit a coordinator chose is the door the visit is for.
            visitTitle: visitTitle(
              unit.resolution === TbpUnitResolution.MANUAL && unit.unit?.addressLine1
                ? { ...tenant, addressLine1: unit.unit.addressLine1 }
                : tenant,
              quarter,
            ),
          }),
      visitDetails: details,
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
      select: { id: true, name: true, addressLine1: true },
    });
    const named = (unitId: string | null) => {
      const found = units.find((candidate) => candidate.id === unitId);
      return found ? { unit: { name: found.name, addressLine1: found.addressLine1 }, units } : {};
    };

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
        ...named(leases[0].unitId),
      };

    if (units.length === 1)
      return { unitId: units[0].id, leaseId: null, resolution: TbpUnitResolution.SOLE_UNIT, ...named(units[0].id) };

    // Somebody has already inspected this tenancy and named a unit. That is a
    // human answer to the same question, and it is better than none -- an HVAC
    // visit to the tenancy answers it as well as an occupied one.
    const prior = await this.prisma.inspection.findFirst({
      where: {
        organizationId,
        propertywareBuildingId: buildingId,
        propertywareUnitId: { not: null },
        inspectionType: { in: [InspectionType.OCCUPIED, InspectionType.HVAC] },
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
        ...named(prior.propertywareUnitId),
      };

    return { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };
  }

  /**
   * The unit a coordinator chose for a tenancy, if it is still one of its
   * building's. A unit Propertyware has since removed falls back to the ladder.
   */
  private async chosenUnit(organizationId: string, buildingId: string, unitId: string): Promise<ResolvedUnit> {
    const units = await this.prisma.propertywareUnit.findMany({
      where: { organizationId, buildingId, isActive: true },
      select: { id: true, name: true, addressLine1: true },
    });
    const chosen = units.find((candidate) => candidate.id === unitId);
    if (!chosen) return { unitId: null, leaseId: null, resolution: TbpUnitResolution.UNRESOLVED };
    return {
      unitId: chosen.id,
      leaseId: null,
      resolution: TbpUnitResolution.MANUAL,
      unit: { name: chosen.name, addressLine1: chosen.addressLine1 },
      units,
    };
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
  /** Whoever Jobber had on the visit first, when anybody. */
  technicianEmail?: string | null;
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
  const ranks: { tenantExternalId: string; sequence: number; technicianEmail?: string }[] = [];
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
    ranks.push({
      tenantExternalId: resolved,
      sequence: ranks.length + 1,
      // Who ran it, carried for the planner to prefer again -- not part of the order.
      ...(visit.technicianEmail ? { technicianEmail: visit.technicianEmail } : {}),
    });
  }

  return { ranks, unmatchedAddress, ambiguousBuilding };
}

/** Each tenancy's last known technician, from the newest quarter that names one. */
export function previousTechnicians(priorQuarters: readonly (readonly PriorRank[])[]): Map<string, string> {
  const technicians = new Map<string, string>();
  for (const quarter of priorQuarters)
    for (const entry of quarter)
      if (entry.technicianId && !technicians.has(entry.tenantExternalId))
        technicians.set(entry.tenantExternalId, entry.technicianId);
  return technicians;
}

const rotationCandidate = (tenant: PlanTenant): RotationCandidate => ({
  tenantExternalId: tenant.externalId,
  zone: tenant.zone,
  // The same normaliser the Jobber and Propertyware syncs share. A second one
  // here would let a stop and a visit disagree about the same address with
  // nothing to report it.
  addressKey: normalizeAddressKey(tenant.addressLine1, tenant.postalCode) || null,
});

/** A stop a person may still change: not published, not excluded, no inspection. */
function editableStop(stop: { status: TbpStopStatus; inspectionId: string | null }) {
  return !stop.inspectionId && stop.status !== TbpStopStatus.PUBLISHED && stop.status !== TbpStopStatus.EXCLUDED;
}

const addressOf = (row: OfficeDetailsRow): OfficeDetailsAddress => ({
  address: row.address,
  city: row.city ?? null,
  postalCode: row.postalCode ?? null,
});

/** Rows as stored: trimmed, bounded, and only those carrying both an address and Details. */
function cleanOfficeRows(rows: readonly OfficeDetailsRow[]): OfficeDetailsRow[] {
  const clip = (value: unknown, length: number) => (typeof value === 'string' ? value.trim().slice(0, length) : '');
  return rows
    .map((row) => ({
      address: clip(row?.address, 200),
      city: clip(row?.city, 100) || null,
      postalCode: clip(row?.postalCode, 20) || null,
      details: clip(row?.details, 2000),
    }))
    .filter((row) => row.address && row.details);
}

/** The rows a plan holds, read back defensively: it is JSON a person's sheet produced. */
function officeRowsFrom(value: Prisma.JsonValue | null): OfficeDetailsRow[] {
  return Array.isArray(value) ? cleanOfficeRows(value as unknown as OfficeDetailsRow[]) : [];
}

/**
 * The office's Details for each tenancy, matched by address.
 *
 * The same address rules as the Jobber sync -- strict first, then without the
 * street type -- so a sheet and a visit cannot disagree about one house. A row
 * matching two tenancies, which a building with two enrolled units would, is
 * left out rather than handed to either; a second row for a tenancy already
 * matched is left out too, and both are reported.
 */
export function matchOfficeDetails(
  rows: readonly OfficeDetailsRow[],
  tenancies: readonly { id: string; addressLine1: string | null; postalCode: string | null }[],
) {
  const strict = buildAddressIndex(tenancies);
  const loose = buildLooseAddressIndex(tenancies);
  const byTenantId = new Map<string, string>();
  const unmatched: OfficeDetailsRow[] = [];
  const ambiguous: OfficeDetailsRow[] = [];
  const duplicates: OfficeDetailsRow[] = [];

  for (const row of rows) {
    const match = matchBuildingWithFallback(
      strict,
      loose,
      addressKeyCandidates(row.address, null, row.postalCode),
      looseAddressKey(row.address, row.postalCode),
    );
    if (match.outcome === 'AMBIGUOUS') ambiguous.push(row);
    else if (match.outcome === 'NONE') unmatched.push(row);
    else if (byTenantId.has(match.buildingId)) duplicates.push(row);
    else byTenantId.set(match.buildingId, row.details.trim());
  }

  return { byTenantId, unmatched, ambiguous, duplicates };
}

/**
 * The title the office already reads in Jobber.
 *
 * Reproduced rather than improved on: a real one is
 * `19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package`, and the
 * technicians and coordinators have been reading that shape for as long as the
 * programme has run. A tidier format would be a change nobody asked for, on the
 * one string every person in this workflow sees.
 *
 * The tenant report holds the zone as "4" or "Not Set", so it goes through
 * `tenancyZoneLabel`, the rule the console's booking uses, rather than being
 * copied in as it is.
 */
export function visitTitle(
  tenant: Pick<PlanTenant, 'addressLine1' | 'zone'>,
  quarter: Quarter,
): string {
  const address = tenant.addressLine1?.trim() || 'Unknown address';
  return [address, tenancyZoneLabel(tenant.zone), `${quarterLabel(quarter)} Tenant Benefit Package`]
    .filter(Boolean)
    .join(' - ');
}

/**
 * The Details a planned visit carries.
 *
 * The office's own services line where its sheet has one, otherwise one written
 * the same way from the tenant report -- either way naming the inspection this
 * quarter's rule chose -- and then the office's completion steps. The services
 * line is what makes a benefit-package title an inspection here:
 * `benefitPackageInspectionInDetails` reads "Occupied Inspection" or "HVAC
 * Inspection" on it. Change the wording and the visits we create stop becoming
 * inspections, silently.
 */
export function planVisitDetails(
  tenant: Pick<PlanTenant, 'hvacFilterSizes' | 'hvacFilterLocation' | 'managementPlan' | 'hvacPlan'>,
  inspectionType: TbpInspectionType,
  officeDetails?: string | null,
): string {
  return tbpVisitDetails(servicesLineFor(tenant, inspectionType, officeDetails));
}

/** The services line a planned visit's Details open with: the office's, or one written from the tenancy. */
export function servicesLineFor(
  tenant: Pick<PlanTenant, 'hvacFilterSizes' | 'hvacFilterLocation' | 'managementPlan' | 'hvacPlan'>,
  inspectionType: TbpInspectionType,
  officeDetails?: string | null,
): string {
  return officeDetails?.trim()
    ? tbpServicesLine(officeDetails, inspectionType)
    : tbpServicesLineFromTenancy(tenant, inspectionType);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
