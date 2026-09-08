import { Inject, Injectable } from '@nestjs/common';
import {
  ComparisonClassification,
  ComparisonMatchMethod,
  ComparisonStatus,
  InspectionStatus,
  InspectionType,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/media-processing.service';

// A move-in inspection is usable as a baseline once the technician has submitted
// it (findings exist) — completion/finalization is not required.
const BASELINE_READY_STATUSES: InspectionStatus[] = [
  InspectionStatus.REVIEW_REQUIRED,
  InspectionStatus.UNDER_REVIEW,
  InspectionStatus.TBD,
  InspectionStatus.FOLLOW_UP_REQUIRED,
  InspectionStatus.COMPLETED,
];

/**
 * The one definition of "a move-in that can be this move-out's baseline".
 *
 * Same building, unit and lease, a MOVE_IN, dated before the move-out, and far
 * enough along to have evidence. Nulls match nulls, so a unit-less inspection
 * only matches a unit-less baseline.
 *
 * The lease stays in scope deliberately. Dropping it would let a move-out be
 * compared against the *previous* tenancy's move-in, which is how a new tenant
 * gets charged for the last one's damage.
 *
 * Exported as a function rather than kept as a method so the console's
 * missing-baseline warning can share it without injecting this service. A
 * warning that disagreed with the comparison would be worse than no warning: a
 * looser check — building and date only — reported 14 of 17 move-outs where
 * this rule finds 15, telling one of them it had a baseline the comparison
 * would then refuse.
 */
export function baselineWhere(moveOut: {
  organizationId: string;
  propertywareBuildingId: string | null;
  propertywareUnitId: string | null;
  propertywareLeaseId: string | null;
  scheduledAt: Date;
}) {
  return {
    organizationId: moveOut.organizationId,
    propertywareBuildingId: moveOut.propertywareBuildingId,
    propertywareUnitId: moveOut.propertywareUnitId,
    propertywareLeaseId: moveOut.propertywareLeaseId,
    inspectionType: InspectionType.MOVE_IN,
    scheduledAt: { lt: moveOut.scheduledAt },
    status: { in: BASELINE_READY_STATUSES },
  } satisfies Prisma.InspectionWhereInput;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

type AreaRow = {
  propertyAreaId: string;
  name: string;
  floorName: string | null;
  category: string | null;
  aliases: string[];
};

type AreaMatch = { area: AreaRow; method: ComparisonMatchMethod; confidence: number };

type AreaResult = {
  moveInPropertyAreaId: string | null;
  moveOutPropertyAreaId: string | null;
  areaName: string;
  floorName: string | null;
  classification: ComparisonClassification;
  matchMethod: ComparisonMatchMethod;
  matchConfidence: number;
  requiresReview: boolean;
  summary: string;
};

/**
 * Move-in vs move-out comparison engine (spec §12). Matching is deterministic
 * (local area id → approved alias → normalized name → category+floor); anything
 * uncertain is flagged for human review. The generated comparison is always a
 * DRAFT — a human approves it, and AI (not used here yet) could only ever assist,
 * never finalize.
 */
@Injectable()
export class ComparisonService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The comparison for a move-out inspection, or null if none exists yet. */
  async get(user: AuthenticatedUser, moveOutInspectionId: string) {
    return this.load(user.organizationId, moveOutInspectionId);
  }

  /**
   * Generate (or regenerate) the comparison for a move-out inspection. Called
   * automatically after move-out review is ready, and on demand by an admin.
   * `actor` is absent for the system trigger.
   */
  async generate(
    moveOutInspectionId: string,
    actor?: { organizationId: string; userId: string },
  ) {
    const moveOut = await this.prisma.inspection.findUnique({
      where: { id: moveOutInspectionId },
      select: {
        id: true,
        organizationId: true,
        inspectionType: true,
        propertywareBuildingId: true,
        propertywareUnitId: true,
        propertywareLeaseId: true,
        baselineInspectionId: true,
        scheduledAt: true,
      },
    });
    if (!moveOut)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (actor && moveOut.organizationId !== actor.organizationId)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    if (moveOut.inspectionType !== InspectionType.MOVE_OUT)
      throw new ApplicationError(
        422,
        'NOT_A_MOVE_OUT',
        'A move-in/move-out comparison is generated only for move-out inspections.',
      );

    const moveIn = await this.resolveBaseline(moveOut);
    if (!moveIn)
      throw new ApplicationError(
        409,
        'MOVE_IN_BASELINE_NOT_FOUND',
        'No matching move-in baseline inspection was found for this property, unit, and lease.',
      );

    const existing = await this.prisma.inspectionComparison.findUnique({
      where: { moveOutInspectionId },
      select: { id: true, status: true, version: true },
    });
    // Never silently overwrite a human-approved comparison.
    if (existing?.status === ComparisonStatus.APPROVED)
      throw new ApplicationError(
        409,
        'COMPARISON_ALREADY_APPROVED',
        'This comparison has been approved; reject it before regenerating.',
      );

    const [moveOutAreas, moveInAreas, moveOutDamage, moveInDamage, moveOutMedia] =
      await Promise.all([
        this.loadAreas(moveOut.id),
        this.loadAreas(moveIn.id),
        this.loadDamageCounts(moveOut.id),
        this.loadDamageCounts(moveIn.id),
        this.loadAreaMediaCounts(moveOut.id),
      ]);

    const areaResults = this.buildAreaComparisons(
      moveOutAreas,
      moveInAreas,
      moveOutDamage,
      moveInDamage,
      moveOutMedia,
    );
    const requiresReviewCount = areaResults.filter((a) => a.requiresReview).length;
    const overallCondition = this.overallCondition(areaResults);
    const version = (existing?.version ?? 0) + 1;
    const summary = this.summaryText(overallCondition, requiresReviewCount, areaResults.length);
    const metadata = {
      moveInInspectionId: moveIn.id,
      moveOutAreaCount: moveOutAreas.length,
      moveInAreaCount: moveInAreas.length,
      matchedAreas: areaResults.filter((a) => a.matchMethod !== ComparisonMatchMethod.UNMATCHED)
        .length,
    } satisfies Prisma.InputJsonValue;

    await this.prisma.$transaction(async (tx) => {
      let comparisonId: string;
      if (existing) {
        await tx.inspectionAreaComparison.deleteMany({ where: { comparisonId: existing.id } });
        const record = await tx.inspectionComparison.update({
          where: { id: existing.id },
          data: {
            moveInInspectionId: moveIn.id,
            status: ComparisonStatus.DRAFT,
            overallCondition,
            version,
            generator: 'DETERMINISTIC',
            requiresReviewCount,
            summary,
            reviewedById: null,
            reviewedAt: null,
            reviewNote: null,
            metadata,
            generatedAt: new Date(),
          },
          select: { id: true },
        });
        comparisonId = record.id;
      } else {
        const record = await tx.inspectionComparison.create({
          data: {
            organizationId: moveOut.organizationId,
            moveOutInspectionId: moveOut.id,
            moveInInspectionId: moveIn.id,
            status: ComparisonStatus.DRAFT,
            overallCondition,
            version,
            generator: 'DETERMINISTIC',
            requiresReviewCount,
            summary,
            metadata,
          },
          select: { id: true },
        });
        comparisonId = record.id;
      }
      if (areaResults.length)
        await tx.inspectionAreaComparison.createMany({
          data: areaResults.map((a) => ({ ...a, comparisonId })),
        });
      await this.audit(tx, moveOut.organizationId, actor?.userId ?? null, 'INSPECTION_COMPARISON_GENERATED', comparisonId, {
        moveOutInspectionId: moveOut.id,
        moveInInspectionId: moveIn.id,
        version,
        overallCondition,
        requiresReviewCount,
        system: !actor,
      });
    });

    return this.load(moveOut.organizationId, moveOutInspectionId);
  }

  /** Approve or reject a comparison — a human decision (spec §12). */
  async review(
    user: AuthenticatedUser,
    comparisonId: string,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { id: comparisonId, organizationId: user.organizationId },
      select: { id: true, status: true, moveOutInspectionId: true },
    });
    if (!comparison)
      throw new ApplicationError(404, 'COMPARISON_NOT_FOUND', 'Comparison was not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.inspectionComparison.update({
        where: { id: comparisonId },
        data: {
          status: decision === 'APPROVED' ? ComparisonStatus.APPROVED : ComparisonStatus.REJECTED,
          reviewedById: user.id,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      await this.audit(
        tx,
        user.organizationId,
        user.id,
        decision === 'APPROVED' ? 'INSPECTION_COMPARISON_APPROVED' : 'INSPECTION_COMPARISON_REJECTED',
        comparisonId,
        { note: note ?? null },
      );
    });
    return this.load(user.organizationId, comparison.moveOutInspectionId);
  }

  /** Override a single area's classification, with an audit trail (spec §12). */
  async overrideArea(
    user: AuthenticatedUser,
    areaComparisonId: string,
    classification: ComparisonClassification,
    reason?: string,
  ) {
    const area = await this.prisma.inspectionAreaComparison.findFirst({
      where: { id: areaComparisonId, comparison: { organizationId: user.organizationId } },
      select: {
        id: true,
        classification: true,
        originalClassification: true,
        comparisonId: true,
        comparison: { select: { moveOutInspectionId: true } },
      },
    });
    if (!area)
      throw new ApplicationError(404, 'AREA_COMPARISON_NOT_FOUND', 'Area comparison was not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.inspectionAreaComparison.update({
        where: { id: areaComparisonId },
        data: {
          classification,
          // Keep the first machine-generated value for the audit trail.
          originalClassification: area.originalClassification ?? area.classification,
          overriddenById: user.id,
          overriddenAt: new Date(),
          overrideReason: reason ?? null,
          requiresReview: false,
        },
      });
      // Recompute the parent roll-up from the (now overridden) areas.
      const areas = await tx.inspectionAreaComparison.findMany({
        where: { comparisonId: area.comparisonId },
        select: { classification: true, requiresReview: true },
      });
      await tx.inspectionComparison.update({
        where: { id: area.comparisonId },
        data: {
          overallCondition: this.overallCondition(areas),
          requiresReviewCount: areas.filter((a) => a.requiresReview).length,
        },
      });
      await this.audit(
        tx,
        user.organizationId,
        user.id,
        'INSPECTION_AREA_COMPARISON_OVERRIDDEN',
        areaComparisonId,
        {
          comparisonId: area.comparisonId,
          from: area.classification,
          to: classification,
          reason: reason ?? null,
        },
      );
    });
    return this.load(user.organizationId, area.comparison.moveOutInspectionId);
  }

  // --- internals ---------------------------------------------------------

  /**
   * Which move-outs on a page have nothing to compare against.
   *
   * Shares `baselineWhere` with `resolveBaseline` rather than restating the
   * rule, because a warning that disagreed with the comparison would be worse
   * than no warning. A looser check — building and date only, ignoring unit,
   * lease and status — reported 14 of 17 where the real rule finds 15: one
   * move-out was told it had a baseline that the comparison would then refuse.
   *
   * One query per move-out, and a page holds twenty. The alternative is
   * reimplementing the scope in SQL or in JavaScript, which is the drift this
   * exists to avoid.
   */
  async missingBaselines(
    moveOuts: ReadonlyArray<{
      id: string;
      organizationId: string;
      propertywareBuildingId: string | null;
      propertywareUnitId: string | null;
      propertywareLeaseId: string | null;
      scheduledAt: Date;
    }>,
  ): Promise<Set<string>> {
    const missing = new Set<string>();
    for (const moveOut of moveOuts) {
      const baseline = await this.prisma.inspection.findFirst({
        where: baselineWhere(moveOut),
        select: { id: true },
      });
      if (!baseline) missing.add(moveOut.id);
    }
    return missing;
  }

  private async resolveBaseline(moveOut: {
    organizationId: string;
    propertywareBuildingId: string | null;
    propertywareUnitId: string | null;
    propertywareLeaseId: string | null;
    baselineInspectionId: string | null;
    scheduledAt: Date;
  }) {
    /**
     * Always the latest qualifying move-in, never the one linked at creation.
     *
     * `baselineInspectionId` is written when the move-out is created and
     * records what was current *then*. It used to be preferred here, which
     * quietly broke the rule this report follows: a move-in that happened after
     * the move-out was scheduled but before it was carried out lost to an older
     * one that was still technically in scope.
     *
     * A new tenancy usually hid that, because the lease is part of the scope
     * and a stale link fails it — but a Jobber-created inspection often carries
     * no lease at all, and nulls match nulls. On exactly those, the older
     * move-in won.
     *
     * Preferring the link also skipped both filters below: that lookup checked
     * neither `scheduledAt` nor status, so it could return a move-in dated
     * after this move-out, or one that never reached a reviewable state.
     *
     * The link is still written and still useful as a record of intent. It is
     * simply not what decides the comparison.
     */
    return this.prisma.inspection.findFirst({
      // The same predicate the missing-baseline warning uses, so the console
      // can never claim a baseline exists that this would then refuse.
      where: baselineWhere(moveOut),
      orderBy: { scheduledAt: 'desc' },
      select: { id: true },
    });
  }

  private async loadAreas(inspectionId: string): Promise<AreaRow[]> {
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      select: {
        propertyAreaId: true,
        propertyArea: {
          select: {
            name: true,
            category: true,
            floor: { select: { name: true } },
            aliases: { select: { alias: true } },
          },
        },
      },
    });
    return areas.map((a) => ({
      propertyAreaId: a.propertyAreaId,
      name: a.propertyArea.name,
      floorName: a.propertyArea.floor?.name ?? null,
      category: a.propertyArea.category ?? null,
      aliases: a.propertyArea.aliases.map((x) => x.alias),
    }));
  }

  /** New-damage finding count per property area (excludes room summaries). */
  private async loadDamageCounts(inspectionId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.inspectionFinding.findMany({
      where: {
        inspectionId,
        NOT: { ...ROOM_SUMMARY_WHERE },
        OR: [{ findingType: 'POSSIBLE_NEW_DAMAGE' }, { comparisonResult: 'POSSIBLE_NEW_DAMAGE' }],
      },
      select: { propertyAreaId: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows)
      counts.set(row.propertyAreaId, (counts.get(row.propertyAreaId) ?? 0) + 1);
    return counts;
  }

  private async loadAreaMediaCounts(inspectionId: string): Promise<Map<string, number>> {
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      select: { propertyAreaId: true, _count: { select: { media: true } } },
    });
    return new Map(areas.map((a) => [a.propertyAreaId, a._count.media]));
  }

  private buildAreaComparisons(
    moveOutAreas: AreaRow[],
    moveInAreas: AreaRow[],
    moveOutDamage: Map<string, number>,
    moveInDamage: Map<string, number>,
    moveOutMedia: Map<string, number>,
  ): AreaResult[] {
    const usedMoveIn = new Set<string>();
    const results: AreaResult[] = [];

    for (const mo of moveOutAreas) {
      const match = this.matchArea(mo, moveInAreas, usedMoveIn);
      if (match) usedMoveIn.add(match.area.propertyAreaId);
      const moDamage = moveOutDamage.get(mo.propertyAreaId) ?? 0;
      const miDamage = match ? (moveInDamage.get(match.area.propertyAreaId) ?? 0) : 0;
      const moMedia = moveOutMedia.get(mo.propertyAreaId) ?? 0;
      const { classification, requiresReview } = this.classify(match, moDamage, miDamage, moMedia);
      results.push({
        moveInPropertyAreaId: match?.area.propertyAreaId ?? null,
        moveOutPropertyAreaId: mo.propertyAreaId,
        areaName: mo.name,
        floorName: mo.floorName,
        classification,
        matchMethod: match?.method ?? ComparisonMatchMethod.UNMATCHED,
        matchConfidence: match?.confidence ?? 0,
        requiresReview,
        summary: this.areaSummary(classification),
      });
    }

    // Areas documented at move-in but absent at move-out.
    for (const mi of moveInAreas) {
      if (usedMoveIn.has(mi.propertyAreaId)) continue;
      results.push({
        moveInPropertyAreaId: mi.propertyAreaId,
        moveOutPropertyAreaId: null,
        areaName: mi.name,
        floorName: mi.floorName,
        classification: ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE,
        matchMethod: ComparisonMatchMethod.UNMATCHED,
        matchConfidence: 0,
        requiresReview: true,
        summary: 'Documented at move-in but no move-out capture was found.',
      });
    }
    return results;
  }

  private matchArea(mo: AreaRow, moveInAreas: AreaRow[], used: Set<string>): AreaMatch | null {
    const candidates = moveInAreas.filter((mi) => !used.has(mi.propertyAreaId));
    // 1. Same catalog area id (local id / configured mapping).
    const localId = candidates.find((mi) => mi.propertyAreaId === mo.propertyAreaId);
    if (localId) return { area: localId, method: ComparisonMatchMethod.LOCAL_AREA_ID, confidence: 1 };
    // 2. Approved alias (either direction).
    const moNorm = normalizeName(mo.name);
    const moAliases = new Set(mo.aliases.map(normalizeName));
    const aliasHit = candidates.find((mi) => {
      const miAliases = new Set(mi.aliases.map(normalizeName));
      return (
        miAliases.has(moNorm) ||
        moAliases.has(normalizeName(mi.name)) ||
        [...moAliases].some((alias) => miAliases.has(alias))
      );
    });
    if (aliasHit)
      return { area: aliasHit, method: ComparisonMatchMethod.APPROVED_ALIAS, confidence: 0.9 };
    // 3. Normalized name equality.
    const nameHit = candidates.find((mi) => normalizeName(mi.name) === moNorm);
    if (nameHit)
      return { area: nameHit, method: ComparisonMatchMethod.NORMALIZED_NAME, confidence: 0.8 };
    // 4. Same category + floor (weak — flagged for review).
    if (mo.category) {
      const categoryHit = candidates.find(
        (mi) => mi.category === mo.category && (mi.floorName ?? '') === (mo.floorName ?? ''),
      );
      if (categoryHit)
        return { area: categoryHit, method: ComparisonMatchMethod.AREA_CATEGORY, confidence: 0.5 };
    }
    return null;
  }

  private classify(
    match: AreaMatch | null,
    moDamage: number,
    miDamage: number,
    moMedia: number,
  ): { classification: ComparisonClassification; requiresReview: boolean } {
    if (!match)
      return { classification: ComparisonClassification.MISSING_BASELINE, requiresReview: true };
    if (moMedia === 0)
      return {
        classification: ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE,
        requiresReview: true,
      };
    // Any move-out damage is a charge-relevant call → always human-reviewed.
    if (moDamage > 0 && miDamage === 0)
      return { classification: ComparisonClassification.NEW_DAMAGE, requiresReview: true };
    if (moDamage > 0 && miDamage > 0)
      return { classification: ComparisonClassification.REQUIRES_REVIEW, requiresReview: true };
    if (moDamage === 0 && miDamage > 0)
      return { classification: ComparisonClassification.RESOLVED, requiresReview: true };
    // No damage either side; a weak (category-only) match still deserves a look.
    if (match.method === ComparisonMatchMethod.AREA_CATEGORY)
      return { classification: ComparisonClassification.REQUIRES_REVIEW, requiresReview: true };
    return { classification: ComparisonClassification.UNCHANGED, requiresReview: false };
  }

  private overallCondition(
    areas: Array<{ classification: ComparisonClassification; requiresReview: boolean }>,
  ): ComparisonClassification {
    if (!areas.length) return ComparisonClassification.REQUIRES_REVIEW;
    if (
      areas.some(
        (a) =>
          a.classification === ComparisonClassification.NEW_DAMAGE ||
          a.classification === ComparisonClassification.WORSENED,
      )
    )
      return ComparisonClassification.NEW_DAMAGE;
    if (
      areas.some(
        (a) =>
          a.requiresReview ||
          a.classification === ComparisonClassification.REQUIRES_REVIEW ||
          a.classification === ComparisonClassification.MISSING_BASELINE ||
          a.classification === ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE,
      )
    )
      return ComparisonClassification.REQUIRES_REVIEW;
    if (
      areas.some(
        (a) =>
          a.classification === ComparisonClassification.RESOLVED ||
          a.classification === ComparisonClassification.IMPROVED,
      )
    )
      return ComparisonClassification.IMPROVED;
    return ComparisonClassification.UNCHANGED;
  }

  private areaSummary(classification: ComparisonClassification): string {
    switch (classification) {
      case ComparisonClassification.NEW_DAMAGE:
        return 'New damage flagged at move-out that was not present at move-in.';
      case ComparisonClassification.RESOLVED:
        return 'A condition documented at move-in was not flagged at move-out.';
      case ComparisonClassification.MISSING_BASELINE:
        return 'No matching move-in area — nothing to compare against.';
      case ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE:
        return 'No move-out capture was found for this area.';
      case ComparisonClassification.UNCHANGED:
        return 'No new damage detected relative to the move-in baseline.';
      default:
        return 'Automated comparison is uncertain — needs a human review.';
    }
  }

  private summaryText(
    overall: ComparisonClassification,
    requiresReviewCount: number,
    areaCount: number,
  ): string {
    const base = `Compared ${areaCount} area${areaCount === 1 ? '' : 's'}.`;
    if (requiresReviewCount > 0)
      return `${base} ${requiresReviewCount} need${requiresReviewCount === 1 ? 's' : ''} human review. Overall: ${overall}.`;
    return `${base} Overall: ${overall}.`;
  }

  private async load(organizationId: string, moveOutInspectionId: string) {
    const record = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId },
      include: { areaComparisons: { orderBy: { createdAt: 'asc' } } },
    });
    if (!record) return null;
    const reviewer = record.reviewedById
      ? await this.prisma.userProfile.findUnique({
          where: { id: record.reviewedById },
          select: { displayName: true },
        })
      : null;
    return {
      id: record.id,
      moveOutInspectionId: record.moveOutInspectionId,
      moveInInspectionId: record.moveInInspectionId,
      status: record.status,
      overallCondition: record.overallCondition,
      version: record.version,
      generator: record.generator,
      requiresReviewCount: record.requiresReviewCount,
      summary: record.summary,
      reviewedByName: reviewer?.displayName ?? null,
      reviewedAt: record.reviewedAt,
      reviewNote: record.reviewNote,
      generatedAt: record.generatedAt,
      areas: record.areaComparisons.map((area) => ({
        id: area.id,
        areaName: area.areaName,
        floorName: area.floorName,
        classification: area.classification,
        matchMethod: area.matchMethod,
        matchConfidence: area.matchConfidence,
        requiresReview: area.requiresReview,
        summary: area.summary,
        originalClassification: area.originalClassification,
        overriddenAt: area.overriddenAt,
        overrideReason: area.overrideReason,
      })),
    };
  }

  private audit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string | null,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return tx.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action,
        entityType: 'InspectionComparison',
        entityId,
        metadata,
      },
    });
  }
}
