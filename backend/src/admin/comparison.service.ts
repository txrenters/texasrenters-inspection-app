import { Inject, Injectable } from '@nestjs/common';
import {
  ComparisonClassification,
  ComparisonMatchMethod,
  ComparisonResult,
  ComparisonStatus,
  FindingType,
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

/**
 * What one inspection recorded about each of its areas.
 *
 * `damage` counts the defects. `graded` is the wider question of whether the
 * area was assessed *at all*, which is not the same as being assessed and found
 * clean -- and the difference decides whether "new" is a claim this can make.
 */
type ConditionSignals = { damage: Map<string, number>; graded: Set<string> };

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
    // A person may regenerate an approved comparison. The approval is theirs to
    // supersede, and nothing is lost quietly: the rewrite below sets the record
    // back to DRAFT and clears the reviewer, so the new draft never inherits a
    // decision nobody made about it, and the audit row records what it replaced.
    //
    // The automatic trigger may not. It fires whenever a move-out becomes ready
    // for review, and letting a background job discard a human decision is the
    // silent overwrite this guard existed to prevent -- the reviewer would never
    // learn their approval had gone.
    const supersedesApproval = existing?.status === ComparisonStatus.APPROVED;
    if (supersedesApproval && !actor)
      throw new ApplicationError(
        409,
        'COMPARISON_ALREADY_APPROVED',
        'This comparison has been approved; only a reviewer can regenerate over it.',
      );

    const [moveOutAreas, moveInAreas, moveOutCondition, moveInCondition, moveOutEvidence] =
      await Promise.all([
        this.loadAreas(moveOut.id),
        this.loadAreas(moveIn.id),
        this.loadConditionSignals(moveOut.id),
        this.loadConditionSignals(moveIn.id),
        this.loadAreaEvidenceCounts(moveOut.id),
      ]);

    const areaResults = this.buildAreaComparisons(
      moveOutAreas,
      moveInAreas,
      moveOutCondition,
      moveInCondition,
      moveOutEvidence,
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
          // The index is the order the areas were built in -- the move-out's
          // own area order, then anything documented only at move-in. Written
          // down because nothing else on the row records it.
          data: areaResults.map((a, position) => ({ ...a, comparisonId, position })),
        });
      await this.audit(tx, moveOut.organizationId, actor?.userId ?? null, 'INSPECTION_COMPARISON_GENERATED', comparisonId, {
        moveOutInspectionId: moveOut.id,
        moveInInspectionId: moveIn.id,
        version,
        overallCondition,
        requiresReviewCount,
        system: !actor,
        // What this replaced, so an approval that vanished has a trail.
        supersededApproval: supersedesApproval,
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
      // Ordered, because the matcher walks this list and the weak fallback used
      // to take whichever row the database happened to return first -- so the
      // same two inspections could pair differently from one run to the next.
      orderBy: { propertyArea: { inspectionOrder: 'asc' } },
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

  /**
   * What an inspection recorded about each area: the defects, and whether the
   * area was assessed at all.
   *
   * Damage comes from two places. AI analysis of a recording produces
   * `InspectionFinding` rows. A graded checklist produces failed
   * `InspectionAreaChecklistResponse` rows, and that is the *only* damage an
   * imported inspection has, since `InspectionFinding` requires an
   * `inspectionMediaId` the Inspect & Cloud importer cannot supply.
   *
   * **`isClean` is deliberately not damage.** A move-out is expected to come
   * back dirty — that is the tenant's cleaning obligation, not harm to the
   * property — and counting it here put one "not clean" item's worth of
   * NEW_DAMAGE on every room that had one. Damage is `isUndamaged` and
   * `isWorking`; cleanliness is a separate charge, read off the checklist.
   *
   * `graded` answers a different question from `damage` being zero: an area
   * nobody assessed and an area assessed and found sound both score zero
   * defects, and only one of those supports calling a later defect *new*.
   * `false` is a failed grade; `null` is an item nobody graded.
   */
  private async loadConditionSignals(inspectionId: string): Promise<ConditionSignals> {
    const [findings, responses] = await Promise.all([
      this.prisma.inspectionFinding.findMany({
        where: { inspectionId, NOT: { ...ROOM_SUMMARY_WHERE } },
        select: { propertyAreaId: true, findingType: true, comparisonResult: true },
      }),
      this.prisma.inspectionAreaChecklistResponse.findMany({
        where: {
          inspectionArea: { inspectionId },
          OR: [
            { isClean: { not: null } },
            { isUndamaged: { not: null } },
            { isWorking: { not: null } },
          ],
        },
        select: {
          isUndamaged: true,
          isWorking: true,
          inspectionArea: { select: { propertyAreaId: true } },
        },
      }),
    ]);

    const damage = new Map<string, number>();
    const graded = new Set<string>();
    const addDamage = (propertyAreaId: string) =>
      damage.set(propertyAreaId, (damage.get(propertyAreaId) ?? 0) + 1);

    for (const row of findings) {
      // A finding of any type means somebody assessed this area.
      graded.add(row.propertyAreaId);
      if (
        row.findingType === FindingType.POSSIBLE_NEW_DAMAGE ||
        row.comparisonResult === ComparisonResult.POSSIBLE_NEW_DAMAGE
      )
        addDamage(row.propertyAreaId);
    }
    for (const row of responses) {
      const propertyAreaId = row.inspectionArea.propertyAreaId;
      graded.add(propertyAreaId);
      if (row.isUndamaged === false || row.isWorking === false) addDamage(propertyAreaId);
    }
    return { damage, graded };
  }

  /**
   * Captured evidence per property area, counting photographs as well as
   * recordings.
   *
   * An area's evidence is a video *or* a set of stills. `AreaEvidenceService`
   * -- the screen a reviewer actually opens -- reads both, and two ordinary
   * cases produce an area with stills and no recording at all: an inspection
   * imported from an Inspect & Cloud PDF, whose importer writes
   * `InspectionPhoto` and never `InspectionMedia`, and a walkthrough where the
   * technician photographed a room instead of filming it.
   *
   * Counting `media` alone classified every such area MISSING_MOVE_OUT_EVIDENCE
   * however well it had matched, and regenerating could never clear it: the
   * count it re-read was empty by construction.
   */
  private async loadAreaEvidenceCounts(inspectionId: string): Promise<Map<string, number>> {
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId },
      select: { propertyAreaId: true, _count: { select: { media: true, photos: true } } },
    });
    return new Map(areas.map((a) => [a.propertyAreaId, a._count.media + a._count.photos]));
  }

  private buildAreaComparisons(
    moveOutAreas: AreaRow[],
    moveInAreas: AreaRow[],
    moveOutCondition: ConditionSignals,
    moveInCondition: ConditionSignals,
    moveOutEvidence: Map<string, number>,
  ): AreaResult[] {
    const usedMoveIn = new Set<string>();
    const results: AreaResult[] = [];

    for (const mo of moveOutAreas) {
      const match = this.matchArea(mo, moveInAreas, usedMoveIn);
      if (match) usedMoveIn.add(match.area.propertyAreaId);
      const moDamage = moveOutCondition.damage.get(mo.propertyAreaId) ?? 0;
      const miDamage = match ? (moveInCondition.damage.get(match.area.propertyAreaId) ?? 0) : 0;
      const moEvidence = moveOutEvidence.get(mo.propertyAreaId) ?? 0;
      const baselineGraded = match ? moveInCondition.graded.has(match.area.propertyAreaId) : false;
      const { classification, requiresReview, summary } = this.classify(
        match,
        moDamage,
        miDamage,
        moEvidence,
        baselineGraded,
      );
      results.push({
        moveInPropertyAreaId: match?.area.propertyAreaId ?? null,
        moveOutPropertyAreaId: mo.propertyAreaId,
        areaName: mo.name,
        floorName: mo.floorName,
        classification,
        matchMethod: match?.method ?? ComparisonMatchMethod.UNMATCHED,
        matchConfidence: match?.confidence ?? 0,
        requiresReview,
        summary,
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
    /*
     * 4. Same category and floor -- but only when there is exactly one.
     *
     * This used to take the first candidate that matched, which on a house with
     * four bedrooms meant the move-out Kitchen could pair with a move-in
     * Bedroom: both are INDOOR_ROOM on floor 1, and the list was unordered. The
     * badge honestly read 50%, but the report then showed that other room's
     * photographs under the Kitchen, and nothing on the page said so. On a
     * document used to justify a charge that is worse than admitting no match.
     *
     * One candidate is an inference. Several is a guess, and a guess here is
     * indistinguishable from evidence once it is printed.
     */
    if (mo.category) {
      const sameCategory = candidates.filter(
        (mi) => mi.category === mo.category && (mi.floorName ?? '') === (mo.floorName ?? ''),
      );
      if (sameCategory.length === 1)
        return {
          area: sameCategory[0],
          method: ComparisonMatchMethod.AREA_CATEGORY,
          confidence: 0.5,
        };
    }
    return null;
  }

  private classify(
    match: AreaMatch | null,
    moDamage: number,
    miDamage: number,
    moEvidence: number,
    baselineGraded: boolean,
  ): { classification: ComparisonClassification; requiresReview: boolean; summary: string } {
    const verdict = (classification: ComparisonClassification, requiresReview: boolean) => ({
      classification,
      requiresReview,
      summary: this.areaSummary(classification),
    });

    if (!match) return verdict(ComparisonClassification.MISSING_BASELINE, true);
    if (moEvidence === 0) return verdict(ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE, true);
    // Any move-out damage is a charge-relevant call → always human-reviewed.
    if (moDamage > 0 && miDamage === 0) {
      // A baseline that graded nothing here scores zero for the same reason a
      // spotless one does, and the two mean opposite things. Calling the defect
      // *new* on that basis invents a baseline nobody recorded, and it is the
      // tenant's deposit that pays for the guess — so say what is actually
      // known and let a reviewer decide.
      if (!baselineGraded)
        return {
          classification: ComparisonClassification.REQUIRES_REVIEW,
          requiresReview: true,
          summary:
            'Flagged at move-out, but the move-in baseline recorded no condition for this area — whether it is new cannot be determined from the record.',
        };
      return verdict(ComparisonClassification.NEW_DAMAGE, true);
    }
    if (moDamage > 0 && miDamage > 0) return verdict(ComparisonClassification.REQUIRES_REVIEW, true);
    if (moDamage === 0 && miDamage > 0) return verdict(ComparisonClassification.RESOLVED, true);
    // No damage either side; a weak (category-only) match still deserves a look.
    if (match.method === ComparisonMatchMethod.AREA_CATEGORY)
      return verdict(ComparisonClassification.REQUIRES_REVIEW, true);
    return verdict(ComparisonClassification.UNCHANGED, false);
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
      include: {
        areaComparisons: {
          // Position, because `createdAt` cannot order these: one `createMany`
          // in one transaction gives every row the same `CURRENT_TIMESTAMP`, and
          // ordering on a tie lets the database return them differently on every
          // read. `id` breaks the remaining tie so a comparison written before
          // the column existed is at least stable rather than shuffling.
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        },
      },
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
