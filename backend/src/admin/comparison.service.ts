import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ComparisonClassification,
  ComparisonMatchMethod,
  ComparisonResult,
  ComparisonStatus,
  FindingReviewStatus,
  FindingType,
  InspectionStatus,
  InspectionType,
  MediaProcessingStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { findingMatchesChecklistItem } from '../common/checklist-item-match';
import { ApplicationError } from '../common/errors';
import { inspectedAreaWhere } from '../common/inspected-areas';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/room-summary';
import { sortAreasBySequence } from '@texasrenters/shared';
import { askAi } from '../technician/ai-text';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import {
  acceptedPairs,
  pairingKey,
  pairingPrompt,
  readStoredPairing,
  type AreaPair,
  type StoredPairing,
} from './area-pairing';
import {
  compareItems,
  confirmedNewDamage,
  itemVerdict,
  waitingNote,
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

/**
 * The rules a comparison was drawn under, stored with it. A comparison drawn
 * under older rules is out of date however little its evidence has moved: the
 * ones made before 2026-10-07 still hold "Requires review" rooms, which no
 * rule produces any more, and they are redrawn the next time they are read.
 */
export const COMPARISON_RULES = 3;
// 3 (2026-10-08): rooms in the office's order, the entrance first; "Gameroom"
// pairs with "Game Room"; and the AI pairs what the names cannot (area-pairing).

/** Why a comparison no longer describes its two inspections; see `staleness`. */
export type ComparisonOutOfDate =
  | 'NEWER_MOVE_IN'
  | 'CHECKLIST_CHANGED'
  | 'ROOMS_CHANGED'
  | 'FINDINGS_CHANGED'
  | 'EVIDENCE_ADDED'
  | 'RULES_CHANGED';

function rulesOf(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rules = (metadata as { rules?: unknown }).rules;
  return typeof rules === 'number' ? rules : null;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Letters and digits only: "Gameroom" and "Game Room", "Office." and "Office". */
function compactName(name: string) {
  return normalizeName(name).replace(/[^a-z0-9]/g, '');
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
  summary: string;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Move-in vs move-out comparison engine (spec §12). Matching is deterministic
 * (local area id → approved alias → normalized name → category+floor).
 *
 * **Nobody approves it** (the office, 2026-10-07). It used to be a draft a
 * reviewer decided room by room -- Override, with a reason -- and then
 * approved, and only then could it be shared; the office found itself marking
 * reviewed what the technician had already recorded. What a person reviews is
 * the recordings: the office confirms or rejects the AI's findings on the
 * inspection page. The comparison is drawn from that and from the technician's
 * checklist, and keeps itself current (`current`), so it is ready to send
 * minutes after the evidence is. Nothing unconfirmed reaches it: an AI finding
 * moves a verdict, and appears on the report, only once the office confirmed
 * it. Sending it is the person's decision, and is audited (`ReportShareService`).
 */
@Injectable()
export class ComparisonService {
  private readonly logger = new Logger(ComparisonService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    // For pairing the rooms the names cannot (area-pairing). Optional so the
    // suites building this with `new` keep their shape; without it the
    // comparison pairs by the rules alone, as it always has.
    @Optional()
    @Inject(AiProviderSettingsService)
    private readonly aiSettings?: AiProviderSettingsService,
  ) {}

  /** The comparison for a move-out inspection, current, or null if there can be none yet. */
  async get(user: AuthenticatedUser, moveOutInspectionId: string) {
    await this.current(user.organizationId, moveOutInspectionId);
    return this.load(user.organizationId, moveOutInspectionId);
  }

  /**
   * Brings a move-out's comparison up to date with its evidence, drawing it
   * for the first time if the move-out has been submitted and has none.
   *
   * Called wherever the comparison is read -- the console, the report, a share
   * link -- so nobody has to press anything for it to follow a confirmed
   * finding or a corrected checklist answer. Redrawing is a few reads, and
   * happens only when something under it moved (`staleness`).
   *
   * Best-effort: a comparison that cannot be drawn (no move-in on record) is
   * left as it is, and the reader is told what there is.
   */
  async current(organizationId: string, moveOutInspectionId: string) {
    const record = await this.prisma.inspectionComparison.findFirst({
      where: { moveOutInspectionId, organizationId },
      select: {
        id: true,
        moveOutInspectionId: true,
        moveInInspectionId: true,
        generatedAt: true,
        metadata: true,
      },
    });
    if (record) {
      const outOfDate = await this.staleness(record);
      if (!outOfDate.length) return;
    } else {
      const moveOut = await this.prisma.inspection.findFirst({
        where: { id: moveOutInspectionId, organizationId },
        select: { inspectionType: true, status: true },
      });
      // Drawn once the technician has submitted: before that the checklist is
      // still being filled in, and a comparison of half a walkthrough is not one.
      if (
        moveOut?.inspectionType !== InspectionType.MOVE_OUT ||
        !BASELINE_READY_STATUSES.includes(moveOut.status)
      )
        return;
    }
    await this.generate(moveOutInspectionId).catch((error) => {
      // A move-out with no move-in on record is asked on every read; that is
      // the answer, not a fault worth a line in the log each time.
      if (error instanceof ApplicationError && error.code === 'MOVE_IN_BASELINE_NOT_FOUND') return;
      this.logger.warn(
        `Comparison for ${moveOutInspectionId} not redrawn: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    });
  }

  /**
   * Draw (or redraw) the comparison for a move-out inspection: when its
   * recordings finish processing, when findings change under it, and whenever
   * it is read out of date (`current`). Always the system's doing -- nobody
   * presses anything for it -- so the audit row carries no actor.
   */
  async generate(moveOutInspectionId: string) {
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

    // Read before the evidence: `generatedAt` is stamped below, and anything
    // that changes while this runs must still count as newer than it.
    const generatedAt = new Date();
    const [moveOutAreas, moveInAreas, moveOutCondition, moveInCondition, moveOutEvidence] =
      await Promise.all([
        this.loadAreas(moveOut.id, InspectionType.MOVE_OUT),
        this.loadAreas(moveIn.id, InspectionType.MOVE_IN),
        this.loadConditionSignals(moveOut.id),
        this.loadConditionSignals(moveIn.id),
        this.loadAreaEvidenceCounts(moveOut.id),
      ]);

    // The rooms the rules leave unpaired, paired by the AI where it is sure --
    // asked once for each set of leftovers, and kept with the comparison.
    const aiPairing = await this.aiPairing(
      moveOut.organizationId,
      moveOut.id,
      moveOutAreas,
      moveInAreas,
    );
    const areaResults = this.buildAreaComparisons(
      moveOutAreas,
      moveInAreas,
      moveOutCondition,
      moveInCondition,
      moveOutEvidence,
      aiPairing?.pairs ?? [],
    );
    const overallCondition = this.overallCondition(areaResults);
    const summary = this.summaryText(overallCondition, areaResults.length);
    const metadata = {
      rules: COMPARISON_RULES,
      moveInInspectionId: moveIn.id,
      moveOutAreaCount: moveOutAreas.length,
      moveInAreaCount: moveInAreas.length,
      matchedAreas: areaResults.filter((a) => a.matchMethod !== ComparisonMatchMethod.UNMATCHED)
        .length,
      ...(aiPairing ? { aiPairing } : {}),
    } satisfies Prisma.InputJsonValue;

    await this.prisma.$transaction(async (tx) => {
      // One redraw at a time per move-out. Two readers can find the same
      // comparison out of date together; without this the second's delete
      // cannot see the first's uncommitted rows, and both sets survive.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`comparison:${moveOut.id}`}))`;
      // Read under the lock, so the second of two first draws updates the
      // first's record rather than failing on the unique move-out.
      const existing = await tx.inspectionComparison.findUnique({
        where: { moveOutInspectionId },
        select: { id: true, version: true },
      });
      const version = (existing?.version ?? 0) + 1;
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
            requiresReviewCount: 0,
            summary,
            reviewedById: null,
            reviewedAt: null,
            reviewNote: null,
            metadata,
            generatedAt,
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
            requiresReviewCount: 0,
            summary,
            metadata,
            generatedAt,
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
      await this.audit(tx, moveOut.organizationId, null, 'INSPECTION_COMPARISON_GENERATED', comparisonId, {
        moveOutInspectionId: moveOut.id,
        moveInInspectionId: moveIn.id,
        version,
        overallCondition,
        rules: COMPARISON_RULES,
        system: true,
      });
    });

    return this.load(moveOut.organizationId, moveOutInspectionId);
  }

  /**
   * Why the comparison no longer describes its two inspections, if it does not.
   *
   * The verdicts are worked out when it is drawn, so anything under them that
   * moves afterwards makes it out of date: a checklist answer corrected, a room
   * added to either inspection, a later move-in than the one compared, a
   * finding confirmed or rejected (or a new one from a re-run of the AI), a
   * photograph or recording added to the move-out -- or the rules themselves
   * having changed (`COMPARISON_RULES`). `current` redraws on any of them.
   */
  async staleness(comparison: {
    id: string;
    moveOutInspectionId: string;
    moveInInspectionId: string;
    generatedAt: Date;
    metadata: Prisma.JsonValue | null;
  }): Promise<ComparisonOutOfDate[]> {
    const inspectionIds = [comparison.moveOutInspectionId, comparison.moveInInspectionId];
    const after = { gt: comparison.generatedAt };
    const [checklistChange, roomAdded, findingChange, photoAdded, recordingAdded, moveOut] =
      await Promise.all([
        this.prisma.inspectionAreaChecklistResponse.findFirst({
          where: { inspectionArea: { inspectionId: { in: inspectionIds } }, updatedAt: after },
          select: { id: true },
        }),
        // Rooms only, as `loadAreas` reads them: a job's photo area added later
        // is not a room the comparison is missing. Move-ins and move-outs both
        // walk rooms, so the one rule covers both sides.
        this.prisma.inspectionArea.findFirst({
          where: {
            inspectionId: { in: inspectionIds },
            createdAt: after,
            ...inspectedAreaWhere(InspectionType.MOVE_OUT),
          },
          select: { id: true },
        }),
        // Created or decided since: `updatedAt` moves on both.
        this.prisma.inspectionFinding.findFirst({
          where: { inspectionId: { in: inspectionIds }, updatedAt: after },
          select: { id: true },
        }),
        // Evidence is what separates "not inspected at move-out" from a room.
        this.prisma.inspectionPhoto.findFirst({
          where: { inspectionArea: { inspectionId: comparison.moveOutInspectionId }, createdAt: after },
          select: { id: true },
        }),
        this.prisma.inspectionMedia.findFirst({
          where: { inspectionId: comparison.moveOutInspectionId, createdAt: after },
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
    if (rulesOf(comparison.metadata) !== COMPARISON_RULES) outOfDate.push('RULES_CHANGED');
    if (latest && latest.id !== comparison.moveInInspectionId) outOfDate.push('NEWER_MOVE_IN');
    if (checklistChange) outOfDate.push('CHECKLIST_CHANGED');
    if (roomAdded) outOfDate.push('ROOMS_CHANGED');
    if (findingChange) outOfDate.push('FINDINGS_CHANGED');
    if (photoAdded || recordingAdded) outOfDate.push('EVIDENCE_ADDED');
    return outOfDate;
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
          reviewStatus: true,
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
      const confirmed = row.reviewStatus === FindingReviewStatus.APPROVED;
      findingsByArea.set(row.propertyAreaId, [
        ...(findingsByArea.get(row.propertyAreaId) ?? []),
        {
          title: row.title,
          category: row.category,
          findingType: row.findingType,
          comparisonResult: row.comparisonResult,
          confirmed,
        },
      ]);
      // Damage only once the office confirmed it from the recording: an AI
      // finding nobody has looked at is not on the report, so it cannot be
      // what makes a room "new damage" there either.
      if (
        confirmed &&
        (row.findingType === FindingType.POSSIBLE_NEW_DAMAGE ||
          row.comparisonResult === ComparisonResult.POSSIBLE_NEW_DAMAGE)
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
  private pairAreas(moveOutAreas: AreaRow[], moveInAreas: AreaRow[], aiPairs: readonly AreaPair[] = []) {
    const used = new Set<string>();
    const pairs: Array<{ mo: AreaRow; match: AreaMatch | null }> = moveOutAreas.map((mo) => {
      const match = this.matchArea(mo, moveInAreas, used);
      if (match) used.add(match.area.propertyAreaId);
      return { mo, match };
    });
    // Then the AI's, for what the rules left: never over a rule's match, and
    // only to a move-in room still free.
    for (const pair of pairs) {
      if (pair.match) continue;
      const ai = aiPairs.find((entry) => entry.moveOut === pair.mo.propertyAreaId);
      const area = ai && !used.has(ai.moveIn) ? moveInAreas.find((mi) => mi.propertyAreaId === ai.moveIn) : undefined;
      if (!ai || !area) continue;
      used.add(area.propertyAreaId);
      pair.match = { area, method: ComparisonMatchMethod.AI_SUGGESTED, confidence: ai.confidence };
    }
    return { pairs, used };
  }

  /** The AI's pairs the comparison keeps, if it has any. */
  private async storedPairing(moveOutInspectionId: string) {
    const comparison = await this.prisma.inspectionComparison.findUnique({
      where: { moveOutInspectionId },
      select: { metadata: true },
    });
    return readStoredPairing(comparison?.metadata ?? null);
  }

  /**
   * The AI's pairing of the rooms the rules left unpaired (area-pairing), or
   * null when there is nothing to pair or no AI to ask.
   *
   * Asked once per set of leftovers: the answer is kept in the comparison's
   * metadata under the leftovers' key, and a redraw with the same leftovers
   * reuses it. A failure is not kept, so the next redraw asks again.
   */
  private async aiPairing(
    organizationId: string,
    moveOutInspectionId: string,
    moveOutAreas: AreaRow[],
    moveInAreas: AreaRow[],
  ): Promise<StoredPairing | null> {
    const { pairs, used } = this.pairAreas(moveOutAreas, moveInAreas);
    const leftOut = pairs.filter((pair) => !pair.match).map((pair) => pair.mo);
    const leftIn = moveInAreas.filter((mi) => !used.has(mi.propertyAreaId));
    if (!leftOut.length || !leftIn.length) return null;
    // Without an AI there are no pairs to keep or to ask for.
    if (!this.aiSettings) return null;
    const key = pairingKey(leftOut, leftIn);
    const stored = await this.storedPairing(moveOutInspectionId);
    if (stored?.key === key) return stored;
    try {
      const configuration = await this.aiSettings.resolve(organizationId);
      const { text, usage } = await askAi(configuration, pairingPrompt(leftOut, leftIn), {
        maxTokens: 1_500,
        timeoutMs: 60_000,
        failureCode: 'AI_AREA_PAIRING_FAILED',
        onRejected: (status, message) =>
          this.logger.warn(`Room pairing rejected (HTTP ${status}): ${message}`),
      });
      await this.aiSettings
        .recordUsage(organizationId, configuration, 'AREA_PAIRING', usage, moveOutInspectionId)
        .catch(() => undefined);
      return { key, pairs: acceptedPairs(text, leftOut, leftIn) };
    } catch (error) {
      this.logger.warn(
        `Room pairing skipped for ${moveOutInspectionId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
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
    // The rules' pairing, and where they leave this room unpaired, the AI's
    // pairs the comparison keeps -- so this reads the room the comparison does.
    const byRules = this.pairAreas(moveOutAreas, moveInAreas).pairs.find(
      (pair) => pair.mo.propertyAreaId === propertyAreaId,
    );
    const aiPairs =
      this.aiSettings && byRules && !byRules.match
        ? ((await this.storedPairing(moveOutInspectionId))?.pairs ?? [])
        : [];
    const paired = this.pairAreas(moveOutAreas, moveInAreas, aiPairs).pairs.find(
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
    aiPairs: readonly AreaPair[] = [],
  ): AreaResult[] {
    const { pairs, used: usedMoveIn } = this.pairAreas(moveOutAreas, moveInAreas, aiPairs);
    const results: AreaResult[] = [];

    for (const { mo, match } of pairs) {
      const moDamage = moveOutCondition.damage.get(mo.propertyAreaId) ?? 0;
      const miDamage = match ? (moveInCondition.damage.get(match.area.propertyAreaId) ?? 0) : 0;
      const moEvidence = moveOutEvidence.get(mo.propertyAreaId) ?? 0;
      const baselineGraded = match ? moveInCondition.graded.has(match.area.propertyAreaId) : false;
      let { classification, summary } = this.classify(
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
      const findings = moveOutCondition.findings.get(mo.propertyAreaId) ?? [];
      const verdict = match && moEvidence > 0 ? itemVerdict(items, findings) : null;
      // What the office confirmed as new, for the report to list by name.
      let fromRecording =
        classification === ComparisonClassification.NEW_DAMAGE ? confirmedNewDamage(findings) : [];
      if (verdict) {
        classification = ComparisonClassification[verdict.classification];
        summary = verdict.summary;
        fromRecording = verdict.fromRecording;
      }
      const aiNote = verdict?.aiNote ?? waitingNote(findings);
      results.push({
        moveInPropertyAreaId: match?.area.propertyAreaId ?? null,
        moveOutPropertyAreaId: mo.propertyAreaId,
        areaName: mo.name,
        floorName: mo.floorName,
        classification,
        matchMethod: match?.method ?? ComparisonMatchMethod.UNMATCHED,
        matchConfidence: match?.confidence ?? 0,
        summary,
        ...(items.length || aiNote || fromRecording.length
          ? { metadata: { items, aiNote, fromRecording } as unknown as Prisma.InputJsonValue }
          : {}),
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
        summary: 'Recorded at move-in; this room was not part of the move-out inspection.',
      });
    }
    // In the office's order, the entrance first (2026-10-08) -- a room seen only
    // at move-in in its place among the rest, not trailing after them. Pairing
    // above still walks the move-out's own order, which it depends on.
    return sortAreasBySequence(results, (result) => result.areaName);
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
    // 3. Normalized name equality -- spaces and punctuation aside, so
    // "Gameroom" is "Game Room" and "Office." is "Office".
    const moCompact = compactName(mo.name);
    const nameHit =
      candidates.find((mi) => normalizeName(mi.name) === moNorm) ??
      (moCompact ? candidates.find((mi) => compactName(mi.name) === moCompact) : undefined);
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
      // Numbered rooms are told apart by their numbers: the only bedroom left
      // on a floor is not "Bedroom 3" when it is called "Bedroom 2".
      const numbers = (name: string) => (name.match(/\d+/g) ?? []).join(',');
      const moNumbers = numbers(mo.name);
      const sameCategory = candidates.filter(
        (mi) =>
          mi.category === mo.category &&
          (mi.floorName ?? '') === (mo.floorName ?? '') &&
          !(moNumbers && numbers(mi.name) && numbers(mi.name) !== moNumbers),
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

  /**
   * A room's verdict by counting defects, where the two inspections graded no
   * item in common. Every sentence here can be printed: it says what the record
   * shows, and where that cannot settle whether damage is new, it says so
   * (NOT_COMPARABLE) instead of waiting on a reviewer to.
   */
  private classify(
    match: AreaMatch | null,
    moDamage: number,
    miDamage: number,
    moEvidence: number,
    baselineGraded: boolean,
  ): { classification: ComparisonClassification; summary: string } {
    const verdict = (classification: ComparisonClassification) => ({
      classification,
      summary: this.areaSummary(classification),
    });

    if (!match) return verdict(ComparisonClassification.MISSING_BASELINE);
    if (moEvidence === 0) return verdict(ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE);
    if (moDamage > 0 && miDamage === 0) {
      // A baseline that graded nothing here scores zero for the same reason a
      // spotless one does, and the two mean opposite things. Calling the defect
      // *new* on that basis invents a baseline nobody recorded, and it is the
      // tenant's deposit that pays for the guess -- so say what is known.
      if (!baselineGraded)
        return {
          classification: ComparisonClassification.NOT_COMPARABLE,
          summary:
            'Damage was recorded at move-out, but the move-in recorded no condition for this room, so whether it is new cannot be told from the record.',
        };
      return verdict(ComparisonClassification.NEW_DAMAGE);
    }
    if (moDamage > 0 && miDamage > 0)
      return {
        classification: ComparisonClassification.NOT_COMPARABLE,
        summary:
          'Damage was recorded at both inspections, and the two did not grade the same items, so whether any of it is new cannot be told from the record.',
      };
    if (moDamage === 0 && miDamage > 0) return verdict(ComparisonClassification.RESOLVED);
    // No damage either side: whichever room a category-only pairing found, it
    // has nothing new in it.
    return verdict(ComparisonClassification.UNCHANGED);
  }

  /**
   * The comparison's headline: new damage anywhere, else whether anything
   * could be compared at all, else better or the same.
   */
  private overallCondition(
    areas: Array<{ classification: ComparisonClassification }>,
  ): ComparisonClassification {
    const has = (...classes: ComparisonClassification[]) =>
      areas.some((a) => classes.includes(a.classification));
    if (has(ComparisonClassification.NEW_DAMAGE, ComparisonClassification.WORSENED))
      return ComparisonClassification.NEW_DAMAGE;
    if (
      !has(
        ComparisonClassification.UNCHANGED,
        ComparisonClassification.RESOLVED,
        ComparisonClassification.IMPROVED,
      )
    )
      return ComparisonClassification.NOT_COMPARABLE;
    if (has(ComparisonClassification.RESOLVED, ComparisonClassification.IMPROVED))
      return ComparisonClassification.IMPROVED;
    return ComparisonClassification.UNCHANGED;
  }

  private areaSummary(classification: ComparisonClassification): string {
    switch (classification) {
      case ComparisonClassification.NEW_DAMAGE:
        return 'Damage was recorded at move-out that the move-in did not record.';
      case ComparisonClassification.RESOLVED:
        return 'A condition recorded at move-in was not recorded at move-out.';
      case ComparisonClassification.MISSING_BASELINE:
        return 'The move-in inspection has no matching room, so there is nothing to compare it with.';
      case ComparisonClassification.MISSING_MOVE_OUT_EVIDENCE:
        return 'No photographs or recording of this room were taken at move-out.';
      default:
        return 'No new damage was recorded at move-out.';
    }
  }

  private summaryText(overall: ComparisonClassification, areaCount: number): string {
    return `Compared ${areaCount} area${areaCount === 1 ? '' : 's'}. Overall: ${overall}.`;
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
    const [moveOutAreas, findings, recordingsProcessing] = await Promise.all([
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
      // Recordings still with the AI: their findings are yet to come.
      this.prisma.inspectionMedia.count({
        where: {
          inspectionId: record.moveOutInspectionId,
          processingStatus: { in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING] },
        },
      }),
    ]);
    const areaIdFor = new Map(moveOutAreas.map((area) => [area.propertyAreaId, area.id]));
    return {
      id: record.id,
      moveOutInspectionId: record.moveOutInspectionId,
      moveInInspectionId: record.moveInInspectionId,
      overallCondition: record.overallCondition,
      version: record.version,
      generator: record.generator,
      summary: record.summary,
      generatedAt: record.generatedAt,
      /**
       * What the report is still waiting on, said and never enforced: it can
       * be sent now, and follows by itself as these arrive (`current`).
       * A finding waiting to be confirmed is not on it until it is.
       */
      recordingsProcessing,
      findingsToConfirm: findings.filter(
        (finding) => finding.reviewStatus === FindingReviewStatus.PENDING_REVIEW,
      ).length,
      areas: record.areaComparisons.map((area) => ({
        id: area.id,
        areaName: area.areaName,
        floorName: area.floorName,
        classification: area.classification,
        matchMethod: area.matchMethod,
        matchConfidence: area.matchConfidence,
        summary: area.summary,
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
