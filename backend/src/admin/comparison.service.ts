import { Inject, Injectable } from '@nestjs/common';
import {
  ComparisonClassification,
  ComparisonMatchMethod,
  ComparisonResult,
  ComparisonStatus,
  FindingReviewStatus,
  FindingType,
  InspectionStatus,
  InspectionType,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { findingMatchesChecklistItem } from '../common/checklist-item-match';
import { ApplicationError } from '../common/errors';
import { inspectedAreaWhere } from '../common/inspected-areas';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/room-summary';
import {
  compareItems,
  itemVerdict,
  type ChecklistRow,
  type ComparedItem,
  type FindingSignal,
} from './comparison-items';

/**
 * A move-in inspection is usable as a baseline once the technician has submitted
 * it -- completion or finalization is not required.
 *
 * "Submitted" includes the two states before the AI's pass is done. Submitted
 * is done (the office, 2026-10-05): the checklist the comparison reads is
 * complete at submission, and a move-in left in PROCESSING by one recording
 * that failed analysis is still the record of the tenancy. Leaving them out
 * made the comparison skip the latest move-in for an older one, or for none.
 */
const BASELINE_READY_STATUSES: InspectionStatus[] = [
  InspectionStatus.TECHNICIAN_SUBMITTED,
  InspectionStatus.PROCESSING,
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

/** Why a comparison no longer describes its two inspections; see `readiness`. */
export type ComparisonOutOfDate = 'NEWER_MOVE_IN' | 'CHECKLIST_CHANGED' | 'ROOMS_CHANGED';

const OUT_OF_DATE_TEXT: Record<ComparisonOutOfDate, string> = {
  NEWER_MOVE_IN: 'A later move-in has been recorded since it was generated.',
  CHECKLIST_CHANGED: 'A checklist answer changed after it was generated.',
  ROOMS_CHANGED: 'A room was added to one of the inspections after it was generated.',
};

/** The reasons, as one sentence each, for an error message. */
export function outOfDateText(reasons: readonly ComparisonOutOfDate[]) {
  return reasons.map((reason) => OUT_OF_DATE_TEXT[reason]).join(' ');
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
 * `checklist` and `findings` are the rows themselves, by area, for comparing
 * item by item (`comparison-items.ts`).
 */
type ConditionSignals = {
  damage: Map<string, number>;
  graded: Set<string>;
  checklist: Map<string, ChecklistRow[]>;
  findings: Map<string, FindingSignal[]>;
};

/** What `generate` keeps on an area row beside the verdict, for the console. */
type AreaDetail = { items: ComparedItem[]; aiNote: string | null };

function areaDetail(metadata: Prisma.JsonValue | null): AreaDetail | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const items = (metadata as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const aiNote = (metadata as { aiNote?: unknown }).aiNote;
  return {
    items: items as ComparedItem[],
    aiNote: typeof aiNote === 'string' ? aiNote : null,
  };
}

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
  metadata?: Prisma.InputJsonValue;
  originalClassification?: ComparisonClassification | null;
  overriddenById?: string | null;
  overriddenAt?: Date | null;
  overrideReason?: string | null;
};

type KeptOverride = {
  moveInPropertyAreaId: string | null;
  moveOutPropertyAreaId: string | null;
  classification: ComparisonClassification;
  originalClassification: ComparisonClassification | null;
  overriddenById: string | null;
  overriddenAt: Date | null;
  overrideReason: string | null;
};

/**
 * A reviewer's override survives a regenerate when what it overrode has not
 * changed: the same two rooms, and the machine's verdict on them the same as
 * the one the reviewer set aside.
 *
 * Regenerating used to delete every area row and write new ones, so the
 * overrides went with them -- the reasons the office wrote for the report
 * included -- and nothing said so. Where the evidence moved, the machine's
 * verdict moves with it and the override is dropped: it was a decision about
 * evidence that is no longer what the room shows.
 */
export function keepOverrides(results: AreaResult[], previous: readonly KeptOverride[]) {
  let kept = 0;
  const next = results.map((result) => {
    const override = previous.find(
      (row) =>
        row.moveInPropertyAreaId === result.moveInPropertyAreaId &&
        row.moveOutPropertyAreaId === result.moveOutPropertyAreaId &&
        row.originalClassification === result.classification,
    );
    if (!override) return result;
    kept += 1;
    return {
      ...result,
      classification: override.classification,
      originalClassification: override.originalClassification,
      overriddenById: override.overriddenById,
      overriddenAt: override.overriddenAt,
      overrideReason: override.overrideReason,
      // Decided by a person, as `overrideArea` leaves it.
      requiresReview: false,
    };
  });
  return { results: next, kept };
}

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
      select: {
        id: true,
        status: true,
        version: true,
        // A reviewer's decisions, to carry over where the evidence they were
        // made on has not changed; see `keepOverrides`.
        areaComparisons: {
          where: { overriddenAt: { not: null } },
          select: {
            moveInPropertyAreaId: true,
            moveOutPropertyAreaId: true,
            classification: true,
            originalClassification: true,
            overriddenById: true,
            overriddenAt: true,
            overrideReason: true,
          },
        },
      },
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
        this.loadAreas(moveOut.id, InspectionType.MOVE_OUT),
        this.loadAreas(moveIn.id, InspectionType.MOVE_IN),
        this.loadConditionSignals(moveOut.id),
        this.loadConditionSignals(moveIn.id),
        this.loadAreaEvidenceCounts(moveOut.id),
      ]);

    const { results: areaResults, kept: keptOverrides } = keepOverrides(
      this.buildAreaComparisons(
        moveOutAreas,
        moveInAreas,
        moveOutCondition,
        moveInCondition,
        moveOutEvidence,
      ),
      existing?.areaComparisons ?? [],
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
        keptOverrides,
      });
    });

    return this.load(moveOut.organizationId, moveOutInspectionId);
  }

  /**
   * Approve or reject a comparison — a human decision (spec §12).
   *
   * An approval is what lets the report go to an owner or a tenant, so it is
   * refused while the document would say something nobody decided: a room
   * still marked "Requires review", or a comparison drawn from evidence that
   * has changed since (`readiness`).
   */
  async review(
    user: AuthenticatedUser,
    comparisonId: string,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const comparison = await this.prisma.inspectionComparison.findFirst({
      where: { id: comparisonId, organizationId: user.organizationId },
      select: {
        id: true,
        status: true,
        moveOutInspectionId: true,
        moveInInspectionId: true,
        generatedAt: true,
      },
    });
    if (!comparison)
      throw new ApplicationError(404, 'COMPARISON_NOT_FOUND', 'Comparison was not found.');
    if (decision === 'APPROVED') {
      const ready = await this.readiness(comparison);
      if (ready.outOfDate.length)
        throw new ApplicationError(
          409,
          'COMPARISON_OUT_OF_DATE',
          `${outOfDateText(ready.outOfDate)} Regenerate the comparison, then approve it.`,
        );
      if (ready.undecidedRooms)
        throw new ApplicationError(
          409,
          'COMPARISON_ROOMS_UNDECIDED',
          `Decide the ${ready.undecidedRooms} ${ready.undecidedRooms === 1 ? 'room' : 'rooms'} marked Requires review (Override) before approving.`,
        );
    }
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

  /**
   * Override a single area's classification, with an audit trail (spec §12).
   *
   * The reason is required: it is printed on the comparison report beside the
   * verdict it changed, and a verdict that disagrees with the checklist beneath
   * it, unexplained, is the report an owner or tenant disputes.
   *
   * Overriding an approved comparison withdraws the approval. The approval was
   * of the report as it stood; what a share link shows next has to be approved
   * again, and until it is the link says the report is being updated.
   */
  async overrideArea(
    user: AuthenticatedUser,
    areaComparisonId: string,
    classification: ComparisonClassification,
    reason?: string,
  ) {
    const why = reason?.trim();
    if (!why)
      throw new ApplicationError(
        400,
        'OVERRIDE_REASON_REQUIRED',
        'Say why: the reason is printed on the comparison report.',
      );
    const area = await this.prisma.inspectionAreaComparison.findFirst({
      where: { id: areaComparisonId, comparison: { organizationId: user.organizationId } },
      select: {
        id: true,
        classification: true,
        originalClassification: true,
        comparisonId: true,
        comparison: { select: { moveOutInspectionId: true, status: true } },
      },
    });
    if (!area)
      throw new ApplicationError(404, 'AREA_COMPARISON_NOT_FOUND', 'Area comparison was not found.');
    const withdrawsApproval = area.comparison.status === ComparisonStatus.APPROVED;
    await this.prisma.$transaction(async (tx) => {
      await tx.inspectionAreaComparison.update({
        where: { id: areaComparisonId },
        data: {
          classification,
          // Keep the first machine-generated value for the audit trail.
          originalClassification: area.originalClassification ?? area.classification,
          overriddenById: user.id,
          overriddenAt: new Date(),
          overrideReason: why,
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
          ...(withdrawsApproval
            ? {
                status: ComparisonStatus.UNDER_REVIEW,
                reviewedById: null,
                reviewedAt: null,
                reviewNote: null,
              }
            : {}),
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
          reason: why,
          approvalWithdrawn: withdrawsApproval,
        },
      );
    });
    return this.load(user.organizationId, area.comparison.moveOutInspectionId);
  }

  /**
   * Whether the comparison says only what was decided, about the evidence as
   * it stands.
   *
   * - `undecidedRooms`: rooms still classified REQUIRES_REVIEW. On a document
   *   an owner or tenant reads, "requires review" is no verdict at all.
   * - `outOfDate`: why the comparison no longer describes the two inspections.
   *   The verdicts are worked out when it is generated; a checklist answer
   *   changed in review afterwards, a room added to either inspection, or a
   *   later move-in than the one compared, and the stored verdicts describe
   *   evidence that is not the evidence any more.
   *
   * Both stop an approval and a share link; the console says which.
   */
  async readiness(comparison: {
    id: string;
    moveOutInspectionId: string;
    moveInInspectionId: string;
    generatedAt: Date;
  }) {
    const inspectionIds = [comparison.moveOutInspectionId, comparison.moveInInspectionId];
    const [undecidedRooms, checklistChange, roomAdded, moveOut] = await Promise.all([
      this.prisma.inspectionAreaComparison.count({
        where: {
          comparisonId: comparison.id,
          classification: ComparisonClassification.REQUIRES_REVIEW,
        },
      }),
      this.prisma.inspectionAreaChecklistResponse.findFirst({
        where: {
          inspectionArea: { inspectionId: { in: inspectionIds } },
          updatedAt: { gt: comparison.generatedAt },
        },
        select: { id: true },
      }),
      // Rooms only, as `loadAreas` reads them: a job's photo area added later
      // is not a room the comparison is missing. Move-ins and move-outs both
      // walk rooms, so the one rule covers both sides.
      this.prisma.inspectionArea.findFirst({
        where: {
          inspectionId: { in: inspectionIds },
          createdAt: { gt: comparison.generatedAt },
          ...inspectedAreaWhere(InspectionType.MOVE_OUT),
        },
        select: { id: true },
      }),
      this.prisma.inspection.findUnique({
        where: { id: comparison.moveOutInspectionId },
        select: {
          organizationId: true,
          propertywareBuildingId: true,
          propertywareUnitId: true,
          propertywareLeaseId: true,
          baselineInspectionId: true,
          scheduledAt: true,
        },
      }),
    ]);
    const latest = moveOut ? await this.resolveBaseline(moveOut) : null;
    const outOfDate: ComparisonOutOfDate[] = [];
    if (latest && latest.id !== comparison.moveInInspectionId) outOfDate.push('NEWER_MOVE_IN');
    if (checklistChange) outOfDate.push('CHECKLIST_CHANGED');
    if (roomAdded) outOfDate.push('ROOMS_CHANGED');
    return { undecidedRooms, outOfDate };
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
      select: { id: true, scheduledAt: true },
    });
  }

  /**
   * The areas each side inspected (`inspectedAreaWhere`). A job's "AC filters"
   * photo area on either side would otherwise stand in the comparison as a
   * room with no counterpart (the office, 2026-09-29).
   */
  private async loadAreas(inspectionId: string, inspectionType: InspectionType): Promise<AreaRow[]> {
    const areas = await this.prisma.inspectionArea.findMany({
      where: { inspectionId, ...inspectedAreaWhere(inspectionType) },
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
        // A finding the office rejected is not damage. Counting it kept a room
        // the reviewer had cleared "uncertain" on every regeneration.
        where: {
          inspectionId,
          reviewStatus: { not: FindingReviewStatus.REJECTED },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        select: {
          propertyAreaId: true,
          findingType: true,
          comparisonResult: true,
          title: true,
          category: true,
        },
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
          isClean: true,
          isUndamaged: true,
          isWorking: true,
          comment: true,
          checklistItem: {
            select: { id: true, label: true, keywords: true, responseType: true },
          },
          inspectionArea: { select: { propertyAreaId: true } },
        },
        // In the checklist's own order, so the items read as the form does.
        orderBy: [{ checklistItem: { sortOrder: 'asc' } }, { checklistItem: { label: 'asc' } }],
      }),
    ]);

    const damage = new Map<string, number>();
    const graded = new Set<string>();
    const checklist = new Map<string, ChecklistRow[]>();
    const findingsByArea = new Map<string, FindingSignal[]>();
    const addDamage = (propertyAreaId: string) =>
      damage.set(propertyAreaId, (damage.get(propertyAreaId) ?? 0) + 1);

    for (const row of findings) {
      // A finding of any type means somebody assessed this area.
      graded.add(row.propertyAreaId);
      findingsByArea.set(row.propertyAreaId, [
        ...(findingsByArea.get(row.propertyAreaId) ?? []),
        {
          title: row.title,
          category: row.category,
          findingType: row.findingType,
          comparisonResult: row.comparisonResult,
        },
      ]);
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
      if (row.checklistItem)
        checklist.set(propertyAreaId, [...(checklist.get(propertyAreaId) ?? []), row]);
    }
    return { damage, graded, checklist, findings: findingsByArea };
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

  /**
   * Pair each move-out area with a move-in area, in the move-out's own order.
   *
   * Greedy on purpose: a move-in area pairs once, so an earlier room can take
   * the candidate a later one would also have accepted. That makes the order
   * part of the answer, which is why `baselineAreaFor` walks this same list
   * rather than matching one area on its own.
   */
  private pairAreas(moveOutAreas: AreaRow[], moveInAreas: AreaRow[]) {
    const used = new Set<string>();
    const pairs = moveOutAreas.map((mo) => {
      const match = this.matchArea(mo, moveInAreas, used);
      if (match) used.add(match.area.propertyAreaId);
      return { mo, match };
    });
    return { pairs, used };
  }

  /**
   * The move-in area one move-out area is compared against: the latest
   * qualifying move-in, and the area `generate` pairs with it.
   *
   * Shared with the AI analysis of a move-out recording. That analysis used to
   * read the move-in from `baselineInspectionId`, the link written at creation,
   * which `resolveBaseline` deliberately does not trust. On 5819 Flower Gate Dr
   * the link was empty, so every finding said no baseline existed while this
   * comparison was reading the June 2025 move-in, whose checklist already had
   * the entrance floor damaged.
   *
   * Null when there is no baseline move-in. `area` is null when the move-in has
   * no area this one pairs with.
   */
  async baselineAreaFor(moveOutInspectionId: string, propertyAreaId: string) {
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
    if (!moveOut || moveOut.inspectionType !== InspectionType.MOVE_OUT) return null;
    const moveIn = await this.resolveBaseline(moveOut);
    if (!moveIn) return null;
    const [moveOutAreas, moveInAreas] = await Promise.all([
      this.loadAreas(moveOut.id, InspectionType.MOVE_OUT),
      this.loadAreas(moveIn.id, InspectionType.MOVE_IN),
    ]);
    const paired = this.pairAreas(moveOutAreas, moveInAreas).pairs.find(
      (pair) => pair.mo.propertyAreaId === propertyAreaId,
    );
    return {
      inspectionId: moveIn.id,
      scheduledAt: moveIn.scheduledAt,
      area: paired?.match
        ? { propertyAreaId: paired.match.area.propertyAreaId, name: paired.match.area.name }
        : null,
    };
  }

  private buildAreaComparisons(
    moveOutAreas: AreaRow[],
    moveInAreas: AreaRow[],
    moveOutCondition: ConditionSignals,
    moveInCondition: ConditionSignals,
    moveOutEvidence: Map<string, number>,
  ): AreaResult[] {
    const { pairs, used: usedMoveIn } = this.pairAreas(moveOutAreas, moveInAreas);
    const results: AreaResult[] = [];

    for (const { mo, match } of pairs) {
      const moDamage = moveOutCondition.damage.get(mo.propertyAreaId) ?? 0;
      const miDamage = match ? (moveInCondition.damage.get(match.area.propertyAreaId) ?? 0) : 0;
      const moEvidence = moveOutEvidence.get(mo.propertyAreaId) ?? 0;
      const baselineGraded = match ? moveInCondition.graded.has(match.area.propertyAreaId) : false;
      let { classification, requiresReview, summary } = this.classify(
        match,
        moDamage,
        miDamage,
        moEvidence,
        baselineGraded,
      );
      // Item by item where both inspections graded the same items, which a
      // matched room with move-out evidence nearly always has. The counting
      // above stays the answer only where they did not.
      const items = match
        ? compareItems(
            moveInCondition.checklist.get(match.area.propertyAreaId) ?? [],
            moveOutCondition.checklist.get(mo.propertyAreaId) ?? [],
          )
        : [];
      let aiNote: string | null = null;
      const verdict =
        match && moEvidence > 0
          ? itemVerdict(
              items,
              moveOutCondition.findings.get(mo.propertyAreaId) ?? [],
              match.method === ComparisonMatchMethod.AREA_CATEGORY,
            )
          : null;
      if (verdict) {
        classification = ComparisonClassification[verdict.classification];
        requiresReview = verdict.requiresReview;
        summary = verdict.summary;
        aiNote = verdict.aiNote;
      }
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
        ...(items.length ? { metadata: { items, aiNote } as unknown as Prisma.InputJsonValue } : {}),
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
    const [reviewer, moveOutAreas, findings, ready] = await Promise.all([
      record.reviewedById
        ? this.prisma.userProfile.findUnique({
            where: { id: record.reviewedById },
            select: { displayName: true },
          })
        : Promise.resolve(null),
      // The move-out's own area rows, so the console can open one from here.
      this.prisma.inspectionArea.findMany({
        where: { inspectionId: record.moveOutInspectionId },
        select: { id: true, propertyAreaId: true },
      }),
      // Read now rather than kept with the comparison: a re-run of the AI
      // replaces undecided findings, and decisions move on after generation.
      this.prisma.inspectionFinding.findMany({
        where: {
          inspectionId: record.moveOutInspectionId,
          reviewStatus: { not: FindingReviewStatus.REJECTED },
          NOT: { ...ROOM_SUMMARY_WHERE },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          propertyAreaId: true,
          title: true,
          category: true,
          severity: true,
          findingType: true,
          reviewStatus: true,
          source: true,
        },
      }),
      this.readiness(record),
    ]);
    const areaIdFor = new Map(moveOutAreas.map((area) => [area.propertyAreaId, area.id]));
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
      // What stops an approval or a share link; see `readiness`.
      undecidedRooms: ready.undecidedRooms,
      outOfDate: ready.outOfDate,
      outOfDateText: ready.outOfDate.length ? outOfDateText(ready.outOfDate) : null,
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
        moveOutAreaId: area.moveOutPropertyAreaId
          ? (areaIdFor.get(area.moveOutPropertyAreaId) ?? null)
          : null,
        ...this.itemDetail(
          areaDetail(area.metadata),
          area.moveOutPropertyAreaId
            ? findings.filter((finding) => finding.propertyAreaId === area.moveOutPropertyAreaId)
            : [],
        ),
      })),
    };
  }

  /**
   * An area's items as the console shows them, each with the move-out findings
   * about it, and the findings about no item listed apart.
   */
  private itemDetail(
    detail: AreaDetail | null,
    findings: Array<{
      id: string;
      title: string;
      category: string;
      severity: string;
      findingType: string;
      reviewStatus: string;
      source: string;
    }>,
  ) {
    const strip = (finding: (typeof findings)[number]) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      findingType: finding.findingType,
      reviewStatus: finding.reviewStatus,
      source: finding.source,
    });
    if (!detail) return { items: [], otherFindings: findings.map(strip), aiNote: null };
    const placed = new Set<(typeof findings)[number]>();
    const items = detail.items.map(({ keywords, ...item }) => {
      const about = findings.filter(
        (finding) =>
          !placed.has(finding) &&
          findingMatchesChecklistItem(finding, { label: item.label, keywords: keywords ?? [] }),
      );
      for (const finding of about) placed.add(finding);
      return { ...item, findings: about.map(strip) };
    });
    return {
      items,
      otherFindings: findings.filter((finding) => !placed.has(finding)).map(strip),
      aiNote: detail.aiNote,
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
