import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  ChargeSource,
  ChargeStatus,
  InspectionType,
  PetAuthorizationStatus,
  PetReviewStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ROOM_SUMMARY_WHERE } from '../technician/media-processing.service';
import type {
  ChargeReviewDto,
  ChargeRuleDto,
  CreateChargeDto,
  PetCandidateReviewDto,
  PetObservationDto,
} from './admin.dto';

const UNAUTHORIZED_PET = 'UNAUTHORIZED_PET';

function normalizeLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function money(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const DECISION_STATUS: Record<string, ChargeStatus> = {
  APPROVE: ChargeStatus.APPROVED,
  REJECT: ChargeStatus.REJECTED,
  ADJUST: ChargeStatus.ADJUSTED,
  WAIVE: ChargeStatus.WAIVED,
};

/**
 * Pet violations and configurable charges (spec §13/§14). The technician records
 * evidence only. Uniqueness, authorization, and every charge decision are made by
 * a human — the generator drafts recommendations (status PENDING_REVIEW), but no
 * code path ever sets a charge APPROVED without a reviewer. AI never finalizes
 * financial responsibility.
 */
@Injectable()
export class ChargeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // --- charge rules ------------------------------------------------------

  async listRules(user: AuthenticatedUser) {
    const rules = await this.prisma.chargeRule.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { code: 'asc' },
    });
    return rules.map((rule) => this.mapRule(rule));
  }

  /** Configure a charge rule (upsert by code). The $25 pet amount lives here. */
  async upsertRule(user: AuthenticatedUser, input: ChargeRuleDto) {
    const code = (input.code ?? UNAUTHORIZED_PET).trim().toUpperCase();
    const data = {
      amount: input.amount,
      currency: (input.currency ?? 'USD').toUpperCase(),
      calculationType: (input.calculationType ?? 'PER_UNIQUE_ENTITY') as Prisma.ChargeRuleCreateInput['calculationType'],
      description: input.description ?? null,
      isActive: input.isActive ?? true,
    };
    const rule = await this.prisma.$transaction(async (tx) => {
      const record = await tx.chargeRule.upsert({
        where: { organizationId_code: { organizationId: user.organizationId, code } },
        create: { organizationId: user.organizationId, code, createdById: user.id, ...data },
        update: data,
      });
      await this.audit(tx, user, 'CHARGE_RULE_UPDATED', record.id, {
        code,
        amount: input.amount,
        isActive: data.isActive,
      });
      return record;
    });
    return this.mapRule(rule);
  }

  // --- pet observations (technician records evidence only) ---------------

  async recordObservation(
    actor: { organizationId: string; userId: string },
    inspectionId: string,
    input: PetObservationDto,
  ) {
    const inspection = await this.prisma.inspection.findFirst({
      where: {
        id: inspectionId,
        organizationId: actor.organizationId,
        assignments: { some: { technicianId: actor.userId, isCurrent: true } },
      },
      select: { id: true, inspectionType: true },
    });
    if (!inspection)
      throw new ApplicationError(
        404,
        'ASSIGNED_INSPECTION_NOT_FOUND',
        'Assigned inspection was not found.',
      );
    if (inspection.inspectionType !== InspectionType.OCCUPIED)
      throw new ApplicationError(
        422,
        'PET_OBSERVATION_OCCUPIED_ONLY',
        'Pet observations are recorded during occupied inspections.',
      );
    // A retry after the first attempt's response was lost must record one
    // sighting, not two. This is the only technician write that appends rather
    // than sets a value, and a duplicate pet becomes a charge somebody has to
    // argue about. Returning the original rather than erroring matches the
    // rule room-video upload already follows: a retry is not a conflict.
    if (input.idempotencyKey) {
      const existing = await this.prisma.petObservation.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true },
      });
      if (existing) return { id: existing.id };
    }
    const observation = await this.prisma.petObservation.create({
      data: {
        idempotencyKey: input.idempotencyKey ?? null,
        organizationId: actor.organizationId,
        inspectionId,
        propertyAreaId: input.propertyAreaId ?? null,
        temporaryLabel: input.temporaryLabel.trim(),
        species: input.species.trim(),
        description: input.description ?? null,
        characteristics: input.characteristics ?? null,
        notes: input.notes ?? null,
        photoIds: input.photoIds ?? [],
        mediaIds: input.mediaIds ?? [],
        possibleDuplicateOfId: input.possibleDuplicateOfId ?? null,
        recordedById: actor.userId,
      },
    });
    return { id: observation.id };
  }

  // --- pet candidates (dedup + human review) -----------------------------

  async listPets(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const [candidates, observations] = await Promise.all([
      this.prisma.petCandidate.findMany({
        where: { inspectionId, organizationId: user.organizationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.petObservation.findMany({
        where: { inspectionId, organizationId: user.organizationId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        species: candidate.species,
        label: candidate.label,
        description: candidate.description,
        reviewStatus: candidate.reviewStatus,
        authorizationStatus: candidate.authorizationStatus,
        observationCount: candidate.observationCount,
        reviewedAt: candidate.reviewedAt,
        reviewNote: candidate.reviewNote,
      })),
      observations: observations.map((observation) => ({
        id: observation.id,
        petCandidateId: observation.petCandidateId,
        temporaryLabel: observation.temporaryLabel,
        species: observation.species,
        description: observation.description,
        characteristics: observation.characteristics,
        notes: observation.notes,
        propertyAreaId: observation.propertyAreaId,
        photoIds: observation.photoIds,
        mediaIds: observation.mediaIds,
        possibleDuplicateOfId: observation.possibleDuplicateOfId,
      })),
    };
  }

  /**
   * Draft unique-animal candidates by grouping ungrouped observations by species
   * and normalized label. Only a draft — a reviewer confirms uniqueness and
   * authorization; a dog seen in three rooms groups to one candidate.
   */
  async generateCandidates(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const ungrouped = await this.prisma.petObservation.findMany({
      where: { inspectionId, organizationId: user.organizationId, petCandidateId: null },
      orderBy: { createdAt: 'asc' },
    });
    const groups = new Map<string, typeof ungrouped>();
    for (const observation of ungrouped) {
      const key = `${observation.species.trim().toLowerCase()}|${normalizeLabel(observation.temporaryLabel)}`;
      const group = groups.get(key) ?? [];
      group.push(observation);
      groups.set(key, group);
    }
    // Ids are assigned here instead of read back from each insert, which is
    // what lets every candidate be written in a single statement below.
    const drafts = [...groups.values()].map((group) => ({ id: randomUUID(), group }));

    // Nothing to group is the common case — most calls find no new
    // observations — and an empty transaction is still a round trip.
    if (drafts.length)
      await this.prisma.$transaction(async (tx) => {
        // Every candidate in one statement.
        //
        // This used to insert them one at a time so it could read each id back
        // and link that group's observations to it, which made the transaction
        // grow two statements per group. Against a remote pooler each is a few
        // hundred milliseconds, so an inspection with enough distinct animals
        // could exhaust the transaction budget partway through and roll back
        // work a reviewer had already waited for.
        await tx.petCandidate.createMany({
          data: drafts.map(({ id, group }) => {
            const first = group[0];
            return {
              id,
              organizationId: user.organizationId,
              inspectionId,
              species: first.species,
              label: first.temporaryLabel,
              description: first.description,
              observationCount: group.length,
            };
          }),
        });
        // Still one per candidate: each group points at a different id, and
        // updateMany sets a single value. Prisma maintains `updatedAt` here,
        // which a hand-written bulk UPDATE would silently leave stale on
        // records that go on to justify a charge.
        for (const { id, group } of drafts)
          await tx.petObservation.updateMany({
            where: { id: { in: group.map((observation) => observation.id) } },
            data: { petCandidateId: id },
          });
        await this.audit(tx, user, 'PET_CANDIDATES_GENERATED', inspectionId, {
          created: drafts.length,
          observations: ungrouped.length,
        });
      });
    return this.listPets(user, inspectionId);
  }

  /** A reviewer's uniqueness + authorization determination for a candidate. */
  async reviewCandidate(user: AuthenticatedUser, candidateId: string, input: PetCandidateReviewDto) {
    const candidate = await this.prisma.petCandidate.findFirst({
      where: { id: candidateId, organizationId: user.organizationId },
      select: { id: true, inspectionId: true },
    });
    if (!candidate)
      throw new ApplicationError(404, 'PET_CANDIDATE_NOT_FOUND', 'Pet candidate was not found.');
    await this.prisma.$transaction(async (tx) => {
      await tx.petCandidate.update({
        where: { id: candidateId },
        data: {
          reviewStatus: input.reviewStatus as PetReviewStatus,
          authorizationStatus: (input.authorizationStatus ?? undefined) as
            | PetAuthorizationStatus
            | undefined,
          reviewedById: user.id,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
        },
      });
      await this.audit(tx, user, 'PET_CANDIDATE_REVIEWED', candidateId, {
        reviewStatus: input.reviewStatus,
        authorizationStatus: input.authorizationStatus ?? null,
      });
    });
    return this.listPets(user, candidate.inspectionId);
  }

  // --- charges (draft recommendations + human finalization) --------------

  async listCharges(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const charges = await this.prisma.charge.findMany({
      where: { inspectionId, organizationId: user.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return charges.map((charge) => this.mapCharge(charge));
  }

  /**
   * Draft charges for confirmed unique + unauthorized pets, at the configured
   * rule amount. Drafts land as PENDING_REVIEW — never APPROVED. Requires an
   * active rule (the amount is configured, never hard-coded).
   */
  async generateCharges(user: AuthenticatedUser, inspectionId: string) {
    await this.requireInspection(user.organizationId, inspectionId);
    const rule = await this.prisma.chargeRule.findFirst({
      where: { organizationId: user.organizationId, code: UNAUTHORIZED_PET, isActive: true },
    });
    if (!rule)
      throw new ApplicationError(
        409,
        'CHARGE_RULE_NOT_CONFIGURED',
        'Configure and activate the UNAUTHORIZED_PET charge rule before generating charges.',
      );
    const [candidates, existing] = await Promise.all([
      this.prisma.petCandidate.findMany({
        where: {
          inspectionId,
          organizationId: user.organizationId,
          reviewStatus: PetReviewStatus.UNIQUE_PET,
          authorizationStatus: PetAuthorizationStatus.UNAUTHORIZED,
        },
        select: { id: true, label: true },
      }),
      this.prisma.charge.findMany({
        where: { inspectionId, chargeCode: UNAUTHORIZED_PET, petCandidateId: { not: null } },
        select: { petCandidateId: true },
      }),
    ]);
    const charged = new Set(existing.map((charge) => charge.petCandidateId));
    const pending = candidates.filter((candidate) => !charged.has(candidate.id));
    if (pending.length)
      await this.prisma.$transaction(async (tx) => {
        await tx.charge.createMany({
          data: pending.map((candidate) => ({
            organizationId: user.organizationId,
            inspectionId,
            chargeCode: UNAUTHORIZED_PET,
            description: `Unauthorized pet: ${candidate.label}`,
            petCandidateId: candidate.id,
            quantity: 1,
            unitAmount: rule.amount,
            proposedAmount: rule.amount,
            currency: rule.currency,
            status: ChargeStatus.PENDING_REVIEW,
            source: ChargeSource.SYSTEM,
          })),
        });
        await this.audit(tx, user, 'CHARGES_GENERATED', inspectionId, {
          code: UNAUTHORIZED_PET,
          created: pending.length,
        });
      });
    return this.listCharges(user, inspectionId);
  }

  /** An administrator manually adds a charge (e.g. damage tied to a finding). */
  async createCharge(user: AuthenticatedUser, inspectionId: string, input: CreateChargeDto) {
    await this.requireInspection(user.organizationId, inspectionId);
    const quantity = input.quantity ?? 1;
    const proposedAmount = Number((input.unitAmount * quantity).toFixed(2));
    const charge = await this.prisma.$transaction(async (tx) => {
      const record = await tx.charge.create({
        data: {
          organizationId: user.organizationId,
          inspectionId,
          chargeCode: (input.chargeCode ?? 'MANUAL').trim().toUpperCase(),
          description: input.description.trim(),
          propertyAreaId: input.propertyAreaId ?? null,
          findingId: input.findingId ?? null,
          quantity,
          unitAmount: input.unitAmount,
          proposedAmount,
          status: ChargeStatus.PENDING_REVIEW,
          source: ChargeSource.ADMINISTRATOR,
          reason: input.reason ?? null,
          createdById: user.id,
        },
      });
      await this.audit(tx, user, 'CHARGE_CREATED', record.id, {
        chargeCode: record.chargeCode,
        proposedAmount,
      });
      return record;
    });
    return this.mapCharge(charge);
  }

  /**
   * Finalize a charge — the human decision (spec §14). Approve/adjust set the
   * approved amount; reject/waive zero it. This is the only path that leaves the
   * PENDING_REVIEW/DRAFT state, and it is reached only with `charges:review`.
   */
  async reviewCharge(user: AuthenticatedUser, chargeId: string, input: ChargeReviewDto) {
    const charge = await this.prisma.charge.findFirst({
      where: { id: chargeId, organizationId: user.organizationId },
    });
    if (!charge) throw new ApplicationError(404, 'CHARGE_NOT_FOUND', 'Charge was not found.');
    const status = DECISION_STATUS[input.decision];
    let approvedAmount: number | null;
    if (input.decision === 'APPROVE') approvedAmount = money(input.approvedAmount) ?? money(charge.proposedAmount);
    else if (input.decision === 'ADJUST') {
      if (input.approvedAmount === undefined)
        throw new ApplicationError(
          422,
          'ADJUSTED_AMOUNT_REQUIRED',
          'Provide the adjusted amount when adjusting a charge.',
        );
      approvedAmount = money(input.approvedAmount);
    } else if (input.decision === 'WAIVE') approvedAmount = 0;
    else approvedAmount = null; // REJECT

    const updated = await this.prisma.$transaction(async (tx) => {
      const record = await tx.charge.update({
        where: { id: chargeId },
        data: {
          status,
          approvedAmount,
          reason: input.reason ?? charge.reason,
          reviewedById: user.id,
          reviewedAt: new Date(),
        },
      });
      await this.audit(tx, user, `CHARGE_${status}`, chargeId, {
        decision: input.decision,
        approvedAmount,
        reason: input.reason ?? null,
      });
      return record;
    });
    return this.mapCharge(updated);
  }

  // --- charge comparison report (spec §14) -------------------------------

  async report(user: AuthenticatedUser, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: {
        id: true,
        status: true,
        inspectionType: true,
        scheduledAt: true,
        propertywareBuilding: { select: { name: true, addressLine1: true, city: true, state: true } },
        propertywareUnit: { select: { name: true } },
        propertywareLease: { select: { leaseName: true, scheduledMoveOutDate: true } },
      },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');

    const [comparison, findings, candidates, charges, rule] = await Promise.all([
      this.prisma.inspectionComparison.findFirst({
        where: { moveOutInspectionId: inspectionId, organizationId: user.organizationId },
        include: { areaComparisons: { orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.inspectionFinding.findMany({
        where: { inspectionId, NOT: { ...ROOM_SUMMARY_WHERE } },
        select: {
          id: true,
          title: true,
          description: true,
          findingType: true,
          comparisonResult: true,
          severity: true,
          reviewStatus: true,
          propertyArea: { select: { name: true } },
        },
      }),
      this.prisma.petCandidate.findMany({
        where: { inspectionId, organizationId: user.organizationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.charge.findMany({
        where: { inspectionId, organizationId: user.organizationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.chargeRule.findFirst({
        where: { organizationId: user.organizationId, code: UNAUTHORIZED_PET, isActive: true },
      }),
    ]);

    const isDamage = (finding: (typeof findings)[number]) =>
      finding.findingType === 'POSSIBLE_NEW_DAMAGE' ||
      finding.comparisonResult === 'POSSIBLE_NEW_DAMAGE';
    const isExisting = (finding: (typeof findings)[number]) =>
      finding.findingType === 'EXISTING_CONDITION' ||
      finding.comparisonResult === 'EXISTING_CONDITION';

    const mapped = charges.map((charge) => this.mapCharge(charge));
    const proposed = mapped.filter((c) => c.status === 'DRAFT' || c.status === 'PENDING_REVIEW');
    const approved = mapped.filter((c) => c.status === 'APPROVED' || c.status === 'ADJUSTED');
    const rejected = mapped.filter((c) => c.status === 'REJECTED' || c.status === 'WAIVED');
    const proposedTotal = mapped
      .filter((c) => c.status !== 'REJECTED' && c.status !== 'WAIVED')
      .reduce((sum, c) => sum + (c.proposedAmount ?? 0), 0);
    const approvedTotal = approved.reduce((sum, c) => sum + (c.approvedAmount ?? 0), 0);

    return {
      property: {
        name: inspection.propertywareBuilding?.name ?? 'Property',
        address: inspection.propertywareBuilding?.addressLine1 ?? null,
        cityState: inspection.propertywareBuilding
          ? `${inspection.propertywareBuilding.city ?? ''} ${inspection.propertywareBuilding.state ?? ''}`.trim()
          : null,
        unit: inspection.propertywareUnit?.name ?? null,
        lease: inspection.propertywareLease?.leaseName ?? null,
        scheduledMoveOut: inspection.propertywareLease?.scheduledMoveOutDate ?? null,
      },
      inspection: {
        id: inspection.id,
        status: inspection.status,
        type: inspection.inspectionType,
        scheduledAt: inspection.scheduledAt,
      },
      comparison: comparison
        ? {
            status: comparison.status,
            overallCondition: comparison.overallCondition,
            areas: comparison.areaComparisons.map((area) => ({
              areaName: area.areaName,
              classification: area.classification,
              requiresReview: area.requiresReview,
            })),
          }
        : null,
      newOrWorsenedFindings: findings.filter(isDamage).map((finding) => ({
        id: finding.id,
        area: finding.propertyArea.name,
        title: finding.title,
        severity: finding.severity,
        reviewStatus: finding.reviewStatus,
      })),
      existingConditionExclusions: findings.filter(isExisting).map((finding) => ({
        id: finding.id,
        area: finding.propertyArea.name,
        title: finding.title,
      })),
      petReview: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        species: candidate.species,
        reviewStatus: candidate.reviewStatus,
        authorizationStatus: candidate.authorizationStatus,
        observationCount: candidate.observationCount,
      })),
      charges: { proposed, approved, rejected },
      rule: rule ? this.mapRule(rule) : null,
      totals: {
        currency: rule?.currency ?? 'USD',
        proposedTotal: Number(proposedTotal.toFixed(2)),
        approvedTotal: Number(approvedTotal.toFixed(2)),
      },
    };
  }

  // --- helpers -----------------------------------------------------------

  private mapRule(rule: {
    id: string;
    code: string;
    description: string | null;
    amount: unknown;
    currency: string;
    calculationType: string;
    isActive: boolean;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }) {
    return {
      id: rule.id,
      code: rule.code,
      description: rule.description,
      amount: money(rule.amount) ?? 0,
      currency: rule.currency,
      calculationType: rule.calculationType,
      isActive: rule.isActive,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
    };
  }

  private mapCharge(charge: {
    id: string;
    inspectionId: string;
    chargeCode: string;
    description: string;
    propertyAreaId: string | null;
    findingId: string | null;
    petCandidateId: string | null;
    quantity: number;
    unitAmount: unknown;
    proposedAmount: unknown;
    approvedAmount: unknown;
    currency: string;
    status: ChargeStatus;
    source: ChargeSource;
    reason: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: charge.id,
      inspectionId: charge.inspectionId,
      chargeCode: charge.chargeCode,
      description: charge.description,
      propertyAreaId: charge.propertyAreaId,
      findingId: charge.findingId,
      petCandidateId: charge.petCandidateId,
      quantity: charge.quantity,
      unitAmount: money(charge.unitAmount) ?? 0,
      proposedAmount: money(charge.proposedAmount) ?? 0,
      approvedAmount: money(charge.approvedAmount),
      currency: charge.currency,
      status: charge.status,
      source: charge.source,
      reason: charge.reason,
      reviewedAt: charge.reviewedAt,
      createdAt: charge.createdAt,
    };
  }

  private async requireInspection(organizationId: string, id: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }

  private audit(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    return tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType: 'Charge',
        entityId,
        metadata,
      },
    });
  }
}
