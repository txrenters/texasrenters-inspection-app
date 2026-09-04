import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberLinkMethod, JobberLinkStatus, JobberVisitImportStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { PORTFOLIO_VISIBLE } from '../../admin/inspection-creation';
import {
  addressKeyCandidates,
  buildAddressIndex,
  buildLooseAddressIndex,
  type AddressMatch,
  looseAddressKey,
  matchBuildingWithFallback,
  normalizeAddressKey,
} from './jobber.address';

/**
 * The two tiers, kept together so they cannot be passed separately.
 *
 * `strict` decides. `loose` is consulted only when `strict` had nothing at
 * all, and only when it names exactly one building.
 */
export interface BuildingIndex {
  strict: Map<string, string[]>;
  loose: Map<string, string[]>;
}

export interface JobberPropertyDescriptor {
  jobberPropertyId: string;
  jobberClientId?: string | null;
  jobberClientName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}

const formatAddress = (property: JobberPropertyDescriptor) =>
  [
    property.addressLine1,
    property.addressLine2,
    [property.city, property.state].filter(Boolean).join(', '),
    property.postalCode,
  ]
    .filter(Boolean)
    .join(' • ') || null;

/**
 * Turns Jobber properties into the Propertyware records an inspection needs.
 *
 * Every unresolved property becomes a row rather than a silent skip. That is
 * the whole design: the office finds out a property needs mapping when the
 * first visit is *seen*, not when a technician is due at a door nobody can
 * name.
 */
/**
 * The visit states that are actually waiting on somebody mapping a property.
 *
 * PENDING is unscheduled in Jobber and becomes importable the moment it gets a
 * date; UNMATCHED_PROPERTY is blocked on the mapping itself. Every other state
 * is finished with: IMPORTED succeeded, SKIPPED_COMPLETE happened before we saw
 * it, SKIPPED_NOT_SYNCED is not an inspection, REJECTED and IGNORED were
 * decided.
 */
const AWAITING_MAPPING = [
  JobberVisitImportStatus.PENDING,
  JobberVisitImportStatus.UNMATCHED_PROPERTY,
];

@Injectable()
export class JobberMappingService {
  private readonly logger = new Logger(JobberMappingService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The address index for one organization's inspectable buildings.
   *
   * Built once and passed into `resolveProperty` for each property, so a sync
   * run over hundreds of visits reads the building set once rather than per
   * visit.
   */
  async buildingIndex(organizationId: string) {
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId, isActive: true, ...PORTFOLIO_VISIBLE },
      select: { id: true, addressLine1: true, postalCode: true },
    });
    return { strict: buildAddressIndex(buildings), loose: buildLooseAddressIndex(buildings) };
  }

  /**
   * Records what we know about a Jobber property and resolves it if it can be
   * resolved unambiguously.
   *
   * A previously LINKED or IGNORED row is never re-decided: a human's answer
   * outranks the matcher, and re-running address matching over a corrected link
   * would quietly undo the correction on the next sync.
   */
  async resolveProperty(
    organizationId: string,
    property: JobberPropertyDescriptor,
    index: BuildingIndex,
  ) {
    const existing = await this.prisma.jobberPropertyLink.findUnique({
      where: {
        organizationId_jobberPropertyId: {
          organizationId,
          jobberPropertyId: property.jobberPropertyId,
        },
      },
    });
    if (
      existing &&
      (existing.status === JobberLinkStatus.LINKED || existing.status === JobberLinkStatus.IGNORED)
    )
      return existing;

    /**
     * Two keys are tried, not one: Jobber puts a unit on its own line and
     * Propertyware writes it inline, so the folded form is the only one that
     * can match a unit-bearing address. The street-only key is recorded as the
     * link's own, because that is the address a person reads in the queue.
     */
    const candidates = addressKeyCandidates(
      property.addressLine1,
      property.addressLine2,
      property.postalCode,
    );
    const normalizedAddressKey = normalizeAddressKey(property.addressLine1, property.postalCode);
    const match = matchBuildingWithFallback(
      index.strict,
      index.loose,
      candidates,
      looseAddressKey(property.addressLine1, property.postalCode),
    );
    const resolution = await this.resolutionFor(organizationId, match, normalizedAddressKey);

    const data = {
      jobberClientId: property.jobberClientId ?? null,
      jobberClientName: property.jobberClientName ?? null,
      jobberAddress: formatAddress(property),
      normalizedAddressKey: normalizedAddressKey || null,
      ...resolution,
    };
    return this.prisma.jobberPropertyLink.upsert({
      where: {
        organizationId_jobberPropertyId: {
          organizationId,
          jobberPropertyId: property.jobberPropertyId,
        },
      },
      create: { organizationId, jobberPropertyId: property.jobberPropertyId, ...data },
      update: data,
    });
  }

  /**
   * What a match means once the building's unit structure is taken into account.
   *
   * A confident address match is not on its own enough to book an inspection:
   * a building with active units needs to know *which* unit, and nothing in a
   * street address answers that. Rather than link the building and let the
   * visit fail later with UNIT_REQUIRED — which would put the failure on the
   * visit instead of on the mapping that caused it — the link itself is held
   * as ambiguous, where a person can resolve it once for every future visit.
   */
  private async resolutionFor(
    organizationId: string,
    match: AddressMatch,
    normalizedAddressKey: string,
  ) {
    if (match.outcome === 'NONE')
      return {
        status: JobberLinkStatus.UNMATCHED,
        method: null,
        propertywareBuildingId: null,
        unresolvedReason: normalizedAddressKey
          ? 'No active property matches this address.'
          : 'Jobber holds no street address and postal code for this property.',
      };
    if (match.outcome === 'AMBIGUOUS')
      return {
        status: JobberLinkStatus.AMBIGUOUS,
        method: null,
        propertywareBuildingId: null,
        unresolvedReason: `${match.buildingIds.length} properties share this address. Choose which one this is.`,
      };
    const activeUnits = await this.prisma.propertywareUnit.count({
      where: { buildingId: match.buildingId, organizationId, isActive: true },
    });
    if (activeUnits > 0)
      return {
        status: JobberLinkStatus.AMBIGUOUS,
        method: null,
        // Kept, even though the link is unresolved: it is a correct and useful
        // partial answer, and it lets the console offer that building's units
        // instead of making somebody search for the property again.
        propertywareBuildingId: match.buildingId,
        unresolvedReason: 'This property has units. Choose which unit Jobber means.',
      };
    return {
      status: JobberLinkStatus.LINKED,
      method: JobberLinkMethod.ADDRESS_EXACT,
      propertywareBuildingId: match.buildingId,
      unresolvedReason: null,
    };
  }

  /**
   * Links waiting on a person, newest first, with what is blocked behind each.
   *
   * Only links with a visit still waiting on them. A queue is a list of work,
   * and this one was counting rows nothing would ever act on: 20 of its 26
   * entries were behind visits already completed in Jobber, which `processVisit`
   * skips before it ever re-resolves a property — so no amount of mapping would
   * have changed anything. It read as 26 blocked jobs when 1 was blocked.
   *
   * Nothing is lost by hiding them. The link rows stay, and one reappears the
   * moment a visit arrives that actually needs it.
   */
  async queue(user: AuthenticatedUser, limit = 50) {
    return this.prisma.jobberPropertyLink.findMany({
      where: {
        organizationId: user.organizationId,
        status: { in: [JobberLinkStatus.UNMATCHED, JobberLinkStatus.AMBIGUOUS] },
        visitImports: { some: { status: { in: AWAITING_MAPPING } } },
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(limit, 200),
      select: {
        id: true,
        jobberPropertyId: true,
        jobberClientName: true,
        jobberAddress: true,
        status: true,
        unresolvedReason: true,
        propertywareBuildingId: true,
        propertywareBuilding: { select: { id: true, name: true } },
        updatedAt: true,
        /**
         * Counted the same way the queue is filtered.
         *
         * An unfiltered count says "12 visits held" about a property whose
         * twelve visits all happened months ago, which is the same overstatement
         * one level down.
         */
        _count: { select: { visitImports: { where: { status: { in: AWAITING_MAPPING } } } } },
      },
    });
  }

  /**
   * Visits that did not become inspections, and why.
   *
   * Separate from the property queue because the two need different actions: a
   * queue row is fixed by naming a property, a rejected visit is fixed in
   * Jobber — renaming it, giving it a date — or by approving a floor plan. Both
   * are lists of work, but not the same work.
   */
  async visitImports(
    user: AuthenticatedUser,
    query: { status?: JobberVisitImportStatus; limit?: number },
  ) {
    return this.prisma.jobberVisitImport.findMany({
      where: {
        organizationId: user.organizationId,
        status: query.status ?? {
          in: [JobberVisitImportStatus.REJECTED, JobberVisitImportStatus.UNMATCHED_PROPERTY],
        },
      },
      orderBy: { lastAttemptAt: 'desc' },
      take: Math.min(query.limit ?? 50, 200),
      select: {
        id: true,
        jobberVisitId: true,
        jobberJobId: true,
        status: true,
        failureCode: true,
        failureMessage: true,
        attempts: true,
        lastAttemptAt: true,
        inspectionId: true,
        link: {
          select: { id: true, jobberAddress: true, jobberClientName: true, status: true },
        },
      },
    });
  }

  /**
   * An administrator's answer, which outranks anything the matcher decided.
   *
   * Validates the whole chain — building, then unit within it, then lease
   * within that — rather than trusting the ids sent, because this is the point
   * where a mistyped id becomes "inspections filed against the wrong property"
   * for every future visit rather than for one.
   */
  async link(
    user: AuthenticatedUser,
    linkId: string,
    input: { buildingId: string; unitId?: string | null; leaseId?: string | null },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.jobberPropertyLink.findFirst({
        where: { id: linkId, organizationId: user.organizationId },
        select: { id: true, jobberPropertyId: true },
      });
      if (!existing)
        throw new ApplicationError(404, 'JOBBER_LINK_NOT_FOUND', 'That Jobber property link was not found.');

      const building = await tx.propertywareBuilding.findFirst({
        where: {
          id: input.buildingId,
          organizationId: user.organizationId,
          isActive: true,
          ...PORTFOLIO_VISIBLE,
        },
        select: { id: true },
      });
      if (!building)
        throw new ApplicationError(
          422,
          'INVALID_ACTIVE_PROPERTY',
          'Select an active synchronized property.',
        );

      const unit = input.unitId
        ? await tx.propertywareUnit.findFirst({
            where: {
              id: input.unitId,
              organizationId: user.organizationId,
              buildingId: building.id,
              isActive: true,
            },
            select: { id: true },
          })
        : null;
      if (input.unitId && !unit)
        throw new ApplicationError(
          422,
          'INVALID_ACTIVE_UNIT',
          'Select an active unit belonging to this property.',
        );
      // The same rule the inspection rules enforce, applied here so it fails
      // against the mapping rather than against every visit that uses it.
      if (!unit) {
        const activeUnits = await tx.propertywareUnit.count({
          where: { buildingId: building.id, organizationId: user.organizationId, isActive: true },
        });
        if (activeUnits > 0)
          throw new ApplicationError(
            422,
            'UNIT_REQUIRED',
            'This property has units. Select which unit this Jobber property is.',
          );
      }
      if (input.leaseId && !unit)
        throw new ApplicationError(
          422,
          'LEASE_REQUIRES_UNIT',
          'Select the lease unit before selecting a lease.',
        );
      const lease = input.leaseId
        ? await tx.propertywareLease.findFirst({
            where: {
              id: input.leaseId,
              organizationId: user.organizationId,
              unitId: unit!.id,
              isActive: true,
            },
            select: { id: true },
          })
        : null;
      if (input.leaseId && !lease)
        throw new ApplicationError(
          422,
          'INVALID_LEASE_RELATIONSHIP',
          'The selected lease is not valid for this unit.',
        );

      const link = await tx.jobberPropertyLink.update({
        where: { id: linkId },
        data: {
          status: JobberLinkStatus.LINKED,
          method: JobberLinkMethod.MANUAL,
          propertywareBuildingId: building.id,
          propertywareUnitId: unit?.id ?? null,
          propertywareLeaseId: lease?.id ?? null,
          unresolvedReason: null,
          linkedByUserId: user.id,
          linkedAt: new Date(),
        },
      });
      // Everything that was waiting on this mapping becomes eligible again.
      // Without this the queue would clear while the visits behind it stayed
      // stuck, which reads as "resolved" and inspects nothing.
      const released = await tx.jobberVisitImport.updateMany({
        where: { linkId, status: JobberVisitImportStatus.UNMATCHED_PROPERTY },
        data: { status: JobberVisitImportStatus.PENDING, failureCode: null, failureMessage: null },
      });
      await this.audit(tx, user, 'JOBBER_PROPERTY_LINKED', link.id, {
        jobberPropertyId: link.jobberPropertyId,
        propertywareBuildingId: building.id,
        propertywareUnitId: unit?.id ?? null,
        propertywareLeaseId: lease?.id ?? null,
        releasedVisits: released.count,
      });
      return { id: link.id, status: link.status, releasedVisits: released.count };
    });
  }

  /**
   * Marks a Jobber property as not ours to inspect.
   *
   * Kept as a row rather than deleted so the next sync does not re-offer it,
   * and so the decision has an owner if it later turns out to be wrong.
   */
  async ignore(user: AuthenticatedUser, linkId: string, reason?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.jobberPropertyLink.findFirst({
        where: { id: linkId, organizationId: user.organizationId },
        select: { id: true, jobberPropertyId: true },
      });
      if (!existing)
        throw new ApplicationError(404, 'JOBBER_LINK_NOT_FOUND', 'That Jobber property link was not found.');
      const link = await tx.jobberPropertyLink.update({
        where: { id: linkId },
        data: {
          status: JobberLinkStatus.IGNORED,
          method: JobberLinkMethod.MANUAL,
          unresolvedReason: reason?.trim() || 'Marked as not inspectable.',
          linkedByUserId: user.id,
          linkedAt: new Date(),
        },
      });
      await tx.jobberVisitImport.updateMany({
        where: { linkId, status: JobberVisitImportStatus.UNMATCHED_PROPERTY },
        data: { status: JobberVisitImportStatus.IGNORED },
      });
      await this.audit(tx, user, 'JOBBER_PROPERTY_IGNORED', link.id, {
        jobberPropertyId: link.jobberPropertyId,
        reason: link.unresolvedReason,
      });
      return { id: link.id, status: link.status };
    });
  }

  private audit(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    action: string,
    entityId: string,
    metadata: object,
  ) {
    return tx.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType: 'JobberPropertyLink',
        entityId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}
