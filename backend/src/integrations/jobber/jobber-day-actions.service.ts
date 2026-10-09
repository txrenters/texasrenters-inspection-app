import { Inject, Injectable } from '@nestjs/common';
import {
  InspectionSource,
  InspectionStatus,
  JobberConnectionStatus,
  JobberOutboundKind,
  JobberOutboundStatus,
  JobberVisitImportStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { withTenant } from '../../database/tenant-context';
import { JobberSyncWorker } from '../../workers/jobber-sync/jobber-sync.worker';
import { getJobberConfig } from './jobber.config';
import { enqueueJobberCompletion, requestVisitPush, type VisitEditKind } from './jobber.outbound';

/**
 * What the office can do about a difference on the day's comparison
 * (console-development, 2026-10-09). Every action reuses a mechanism the
 * integration already has; none writes to Jobber directly:
 *
 *   push           our time (and, if asked, our technician) -> the edit queue
 *   takeJobber     withdraw our queued edit, then re-read the one visit
 *   createFromVisit re-read a Jobber-only visit through the sync's own rules
 *   cancelInJobber the cancel task, for an inspection already cancelled here
 *   completeInJobber the completion task, queued or re-armed
 *
 * The queue is drained by the outbound worker on its own schedule, so every
 * push is gated on the same switch the rest of the console obeys, and every
 * action is audited with who asked.
 */
@Injectable()
export class JobberDayActionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberSyncWorker) private readonly sync: JobberSyncWorker,
  ) {}

  /** Our time, and our technician if asked, sent to the visit Jobber has. */
  async push(user: AuthenticatedUser, inspectionId: string, withTechnician = false) {
    this.requirePushes();
    if (withTechnician && !user.permissions.includes('inspections:assign'))
      throw new ApplicationError(403, 'PERMISSION_DENIED', 'Sending the technician to Jobber needs the Assign permission.');
    const inspection = await this.linkedInspection(user, inspectionId);
    if (!OPEN.has(inspection.status))
      throw new ApplicationError(409, 'INSPECTION_NOT_OPEN', 'Only a visit still to happen can be sent to Jobber.');

    const kinds: VisitEditKind[] = [JobberOutboundKind.VISIT_RESCHEDULE];
    if (withTechnician) kinds.push(JobberOutboundKind.VISIT_ASSIGN);
    await this.prisma.$transaction(async (tx) => {
      for (const kind of kinds)
        await requestVisitPush(tx, { organizationId: user.organizationId, inspectionId, kind, requestedById: user.id });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'JOBBER_PUSH_REQUESTED',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: { kinds, jobberVisitId: inspection.jobberVisitId, from: 'DAY_COMPARISON' },
        },
      });
    });
    return { queued: kinds };
  }

  /**
   * Jobber's version wins: our queued edit is withdrawn (the same audit the
   * sync writes when Jobber overrules one), then the one visit is read again
   * through the sync, which applies it under its usual rules -- including
   * refusing to move work that has started.
   *
   * A queued CANCEL is never withdrawn here: cancelling is the office's call,
   * and the sync holds it for the same reason.
   */
  async takeJobber(user: AuthenticatedUser, inspectionId: string) {
    const inspection = await this.linkedInspection(user, inspectionId);
    // Before anything is withdrawn: without a connection the re-read cannot
    // happen, and our edit would be gone with nothing put in its place.
    await this.requireConnected(user);
    const withdrawn = await this.prisma.$transaction(async (tx) => {
      const waiting = await tx.jobberOutboundTask.findMany({
        where: {
          organizationId: user.organizationId,
          inspectionId,
          kind: { in: [JobberOutboundKind.VISIT_RESCHEDULE, JobberOutboundKind.VISIT_ASSIGN, JobberOutboundKind.VISIT_EDIT] },
          status: { in: [JobberOutboundStatus.PENDING, JobberOutboundStatus.FAILED] },
        },
        select: { id: true, kind: true },
      });
      if (!waiting.length) return [];
      await tx.jobberOutboundTask.deleteMany({ where: { id: { in: waiting.map((task) => task.id) } } });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'JOBBER_CONSOLE_EDIT_WITHDRAWN',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: {
            jobberVisitId: inspection.jobberVisitId,
            kinds: waiting.map((task) => task.kind),
            reason: 'TAKEN_FROM_JOBBER_BY_OFFICE',
          },
        },
      });
      return waiting.map((task) => task.kind);
    });
    const result = await withTenant(user.organizationId, () =>
      this.sync.syncVisit(user.organizationId, inspection.jobberVisitId),
    );
    return { withdrawn, ...(await this.importOutcome(user, inspection.jobberVisitId)), result };
  }

  /**
   * A visit that is in Jobber but not here, read again through the sync. It
   * becomes an inspection only if it passes every rule the sync applies --
   * named as an inspection, its property linked, a plan to build -- so this
   * can never create what the sync would have refused.
   */
  async createFromVisit(user: AuthenticatedUser, jobberVisitId: string) {
    const row = await this.prisma.jobberVisitImport.findFirst({
      where: { organizationId: user.organizationId, jobberVisitId },
      select: { status: true, inspectionId: true },
    });
    if (!row) throw new ApplicationError(404, 'JOBBER_VISIT_NOT_FOUND', 'The sync has not seen this Jobber visit.');
    if (row.status === JobberVisitImportStatus.IMPORTED && row.inspectionId)
      return { inspectionId: row.inspectionId, status: row.status, failureMessage: null };
    await this.requireConnected(user);
    if (!RETRYABLE_IMPORT.has(row.status))
      throw new ApplicationError(
        409,
        'JOBBER_VISIT_NOT_AN_INSPECTION',
        'This Jobber visit is not an inspection (or the office chose to ignore it).',
      );

    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'JOBBER_IMPORT_REQUESTED',
        entityType: 'JobberVisitImport',
        entityId: jobberVisitId,
        metadata: { previousStatus: row.status, from: 'DAY_COMPARISON' },
      },
    });
    const result = await withTenant(user.organizationId, () =>
      this.sync.syncVisit(user.organizationId, jobberVisitId),
    );
    return { ...(await this.importOutcome(user, jobberVisitId)), result };
  }

  /** Tell Jobber about a cancellation made here. The inspection must already be cancelled. */
  async cancelInJobber(user: AuthenticatedUser, inspectionId: string) {
    this.requirePushes();
    const inspection = await this.linkedInspection(user, inspectionId);
    if (inspection.status !== InspectionStatus.CANCELLED)
      throw new ApplicationError(409, 'INSPECTION_NOT_CANCELLED', 'Cancel the inspection here first.');
    // Deliberately no cancellationReason is written: a reason starting with one
    // of the sync's Jobber prefixes is what makes its sweep delete inspections.
    await this.prisma.$transaction(async (tx) => {
      await requestVisitPush(tx, {
        organizationId: user.organizationId,
        inspectionId,
        kind: JobberOutboundKind.VISIT_CANCEL,
        requestedById: user.id,
      });
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'JOBBER_CANCEL_REQUESTED',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: { jobberVisitId: inspection.jobberVisitId, from: 'DAY_COMPARISON' },
        },
      });
    });
    return { queued: [JobberOutboundKind.VISIT_CANCEL] };
  }

  /**
   * Tell Jobber a visit finished here is done. Queued if it never was;
   * re-armed if the worker gave up on it. One already sent is not resent:
   * the visit is then closed in Jobber by hand.
   */
  async completeInJobber(user: AuthenticatedUser, inspectionId: string) {
    const inspection = await this.linkedInspection(user, inspectionId);
    if (OPEN.has(inspection.status) || inspection.status === InspectionStatus.CANCELLED)
      throw new ApplicationError(409, 'INSPECTION_NOT_DONE', 'Only a visit finished here can be completed in Jobber.');
    if (inspection.source !== InspectionSource.JOBBER)
      throw new ApplicationError(409, 'NOT_BOOKED_FROM_JOBBER', 'Only a visit that came from Jobber is completed there.');

    const outcome = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.jobberOutboundTask.findFirst({
        where: { organizationId: user.organizationId, inspectionId, kind: JobberOutboundKind.VISIT_COMPLETED },
        select: { id: true, status: true, sentAt: true },
      });
      if (existing?.status === JobberOutboundStatus.SENT)
        throw new ApplicationError(
          409,
          'JOBBER_ALREADY_TOLD',
          'Jobber was already told this visit is done. If it still shows open, complete it in Jobber.',
        );
      let action: 'queued' | 'retried' | 'already-queued';
      if (!existing) {
        await enqueueJobberCompletion(tx, { organizationId: user.organizationId, inspectionId, reportOwnerId: user.id });
        action = 'queued';
      } else if (existing.status === JobberOutboundStatus.PENDING) {
        action = 'already-queued';
      } else {
        await tx.jobberOutboundTask.update({
          where: { id: existing.id },
          data: { status: JobberOutboundStatus.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null },
        });
        action = 'retried';
      }
      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'JOBBER_COMPLETION_REQUESTED',
          entityType: 'Inspection',
          entityId: inspectionId,
          metadata: { jobberVisitId: inspection.jobberVisitId, outcome: action, from: 'DAY_COMPARISON' },
        },
      });
      return action;
    });
    return { outcome };
  }

  private async requireConnected(user: AuthenticatedUser) {
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId: user.organizationId },
      select: { status: true },
    });
    if (connection?.status !== JobberConnectionStatus.CONNECTED)
      throw new ApplicationError(409, 'JOBBER_NOT_CONNECTED', 'Jobber is not connected, so the visit cannot be read again.');
  }

  private requirePushes() {
    if (!getJobberConfig().pushEditsEnabled)
      throw new ApplicationError(
        409,
        'JOBBER_PUSHES_OFF',
        'Sending changes to Jobber is switched off. Make the change in Jobber instead.',
      );
  }

  private async linkedInspection(user: AuthenticatedUser, inspectionId: string) {
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId: user.organizationId },
      select: { status: true, source: true, jobberVisitId: true },
    });
    if (!inspection) throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
    if (!inspection.jobberVisitId)
      throw new ApplicationError(409, 'NOT_IN_JOBBER', 'This inspection has no Jobber visit.');
    return { ...inspection, jobberVisitId: inspection.jobberVisitId };
  }

  private async importOutcome(user: AuthenticatedUser, jobberVisitId: string) {
    const row = await this.prisma.jobberVisitImport.findFirst({
      where: { organizationId: user.organizationId, jobberVisitId },
      select: { status: true, inspectionId: true, failureCode: true, failureMessage: true },
    });
    return {
      inspectionId: row?.inspectionId ?? null,
      status: row?.status ?? null,
      failureCode: row?.failureCode ?? null,
      failureMessage: row?.failureMessage ?? null,
    };
  }
}

const OPEN = new Set<InspectionStatus>([InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS]);

/** Import outcomes another read can change: not yet tried, waiting on a link, or refused by a rule. */
const RETRYABLE_IMPORT = new Set<JobberVisitImportStatus>([
  JobberVisitImportStatus.PENDING,
  JobberVisitImportStatus.UNMATCHED_PROPERTY,
  JobberVisitImportStatus.REJECTED,
]);
