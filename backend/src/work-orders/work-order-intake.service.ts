import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionSource,
  InspectionStatus,
  InspectionType,
  WorkOrderImportStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { insertInspection, resolveInspectionPlan } from '../admin/inspection-creation';
import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { workOrderHandoffSchema, type WorkOrderHandoff } from './work-order-handoff.schema';

/**
 * The receiving window for work orders the maintenance app hands over.
 *
 * The maintenance app owns the work order. It sends the whole thing the moment
 * one of the in-house crews is put on it, and again whenever it changes, with
 * the same idempotency key each time. This side stages every hand-off in
 * `WorkOrderImport` first (the way the Jobber sync stages visits, so a refusal
 * has somewhere to be recorded), then files it: a new key becomes a visit for
 * the crew to be scheduled on, a known key updates the visit it already made,
 * and a work order closed in Propertyware cancels a visit nobody has started.
 *
 * Filed inside the request rather than from a worker, so the maintenance app
 * gets a definitive answer: 201 with the visit's id, or a 4xx with a stable
 * code and words it shows its staff verbatim. A 5xx is this side's fault and
 * the maintenance app retries it.
 *
 * Nothing here touches Jobber. The work order already has its Jobber job; the
 * visit carries that job's id so whoever books the technician can book on it.
 */
export type WorkOrderIntakeOutcome =
  'created' | 'updated' | 'cancelled' | 'unchanged' | 'ignored_closed';

const CLOSED_STATUSES = new Set(['closed', 'canceled by tenant', 'cancelled', 'canceled']);

@Injectable()
export class WorkOrderIntakeService {
  private readonly logger = new Logger(WorkOrderIntakeService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async receive(user: AuthenticatedUser, body: unknown) {
    const parsed = workOrderHandoffSchema.safeParse(body);
    if (!parsed.success)
      throw new ApplicationError(
        422,
        'WORK_ORDER_INVALID',
        'The work order does not match the hand-off contract.',
        parsed.error.issues
          .slice(0, 10)
          .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`),
      );
    const handoff = parsed.data;
    const organizationId = user.organizationId;
    const now = new Date();

    const staged = await this.prisma.workOrderImport.upsert({
      where: {
        organizationId_sourceSystem_externalKey: {
          organizationId,
          sourceSystem: handoff.source_system,
          externalKey: handoff.idempotency_key,
        },
      },
      create: {
        organizationId,
        sourceSystem: handoff.source_system,
        externalKey: handoff.idempotency_key,
        workOrderNumber: handoff.work_order.number,
        status: WorkOrderImportStatus.RECEIVED,
        payload: handoff as Prisma.InputJsonValue,
        lastReceivedAt: now,
      },
      update: {
        workOrderNumber: handoff.work_order.number,
        status: WorkOrderImportStatus.RECEIVED,
        failureCode: null,
        failureMessage: null,
        payload: handoff as Prisma.InputJsonValue,
        receivedCount: { increment: 1 },
        lastReceivedAt: now,
      },
      select: { id: true },
    });

    try {
      const filed = await this.file(user, handoff);
      await this.prisma.workOrderImport.update({
        where: { id: staged.id },
        data: {
          status: WorkOrderImportStatus.PROCESSED,
          inspectionId: filed.inspectionId,
          processedAt: new Date(),
          failureCode: null,
          failureMessage: null,
        },
      });
      return { id: filed.inspectionId, importId: staged.id, outcome: filed.outcome };
    } catch (error) {
      const refusal =
        error instanceof ApplicationError
          ? error
          : new ApplicationError(
              500,
              'WORK_ORDER_NOT_FILED',
              'The work order could not be filed; try again.',
            );
      if (!(error instanceof ApplicationError))
        this.logger.error(
          `Work order ${handoff.idempotency_key} could not be filed`,
          error instanceof Error ? error.stack : String(error),
        );
      await this.prisma.workOrderImport.update({
        where: { id: staged.id },
        data: {
          status: WorkOrderImportStatus.FAILED,
          failureCode: refusal.code,
          failureMessage: refusal.message,
          processedAt: new Date(),
        },
      });
      throw refusal;
    }
  }

  private async file(
    user: AuthenticatedUser,
    handoff: WorkOrderHandoff,
  ): Promise<{ inspectionId: string | null; outcome: WorkOrderIntakeOutcome }> {
    const organizationId = user.organizationId;
    const closed = isClosed(handoff.work_order.status);
    const existing = await this.prisma.inspection.findFirst({
      where: { organizationId, workOrderKey: handoff.idempotency_key },
      select: { id: true, status: true },
    });

    if (existing) {
      if (closed) {
        if (existing.status !== InspectionStatus.SCHEDULED)
          return { inspectionId: existing.id, outcome: 'unchanged' };
        await this.prisma.$transaction(async (tx) => {
          await tx.inspection.update({
            where: { id: existing.id },
            data: { status: InspectionStatus.CANCELLED },
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              ...auditActor(user),
              action: 'WORK_ORDER_CANCELLED',
              entityType: 'Inspection',
              entityId: existing.id,
              metadata: {
                workOrderKey: handoff.idempotency_key,
                workOrderStatus: handoff.work_order.status,
              },
            },
          });
        });
        return { inspectionId: existing.id, outcome: 'cancelled' };
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.inspection.update({
          where: { id: existing.id },
          data: {
            priority: priorityFor(handoff),
            internalNotes: notesFor(handoff),
            workOrderNumber: handoff.work_order.number,
            jobberJobId: handoff.work_order.jobber.job_gid ?? undefined,
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            ...auditActor(user),
            action: 'WORK_ORDER_UPDATED',
            entityType: 'Inspection',
            entityId: existing.id,
            metadata: {
              workOrderKey: handoff.idempotency_key,
              workOrderStatus: handoff.work_order.status,
            },
          },
        });
      });
      return { inspectionId: existing.id, outcome: 'updated' };
    }

    // Already closed before anyone here saw it: nothing to schedule.
    if (closed) return { inspectionId: null, outcome: 'ignored_closed' };

    /**
     * A Crystal Creek Air job at a home that is not a Texas Renters property.
     * Every visit here hangs off a Propertyware building, so there is nothing
     * to book it on yet. Refused with its own code so the maintenance app can
     * tell staff why, and so the count of these is visible when the office
     * decides whether outside customers belong in this app.
     */
    if (handoff.work_order.is_crystal_creek || !handoff.property)
      throw new ApplicationError(
        422,
        'WORK_ORDER_OUTSIDE_PROPERTY',
        'This work order is at a home that is not a Propertyware property; nothing here can schedule it yet.',
      );

    const building = await this.prisma.propertywareBuilding.findFirst({
      where: {
        organizationId,
        sourceSystem: 'propertyware',
        externalId: handoff.property.propertyware_building_id,
        isActive: true,
      },
      select: { id: true },
    });
    if (!building)
      throw new ApplicationError(
        422,
        'WORK_ORDER_PROPERTY_UNKNOWN',
        `No active property here has Propertyware building id ${handoff.property.propertyware_building_id}.`,
      );
    const unit = handoff.property.propertyware_unit_id
      ? await this.prisma.propertywareUnit.findFirst({
          where: {
            organizationId,
            buildingId: building.id,
            externalId: handoff.property.propertyware_unit_id,
            isActive: true,
          },
          select: { id: true },
        })
      : null;
    const lease =
      unit && handoff.property.propertyware_lease_id
        ? await this.prisma.propertywareLease.findFirst({
            where: {
              organizationId,
              unitId: unit.id,
              externalId: handoff.property.propertyware_lease_id,
              isActive: true,
            },
            select: { id: true },
          })
        : null;

    const inspectionType = inspectionTypeFor(handoff);
    const scheduledAt = scheduledDayFor(handoff);
    const inspection = await this.prisma.$transaction(async (tx) => {
      // Held to every rule an inspection is, except the same-day duplicate
      // rule: the work order's own key is what says whether two are the same.
      const plan = await resolveInspectionPlan(tx, {
        organizationId,
        buildingId: building.id,
        unitId: unit?.id ?? null,
        leaseId: lease?.id ?? null,
        inspectionType,
        scheduledAt,
        // A repair visit walks no rooms, so a property nobody has surveyed is
        // not a reason to refuse it; the technician files evidence on site.
        allowTechnicianAreaCapture: true,
        skipDuplicateCheck: true,
      });
      const created = await insertInspection(tx, plan, {
        priority: priorityFor(handoff),
        internalNotes: notesFor(handoff),
        // A machine filed it; `auditActor` below says which one.
        createdById: null,
        source: InspectionSource.WORK_ORDER,
        jobberJobId: handoff.work_order.jobber.job_gid ?? null,
        workOrderKey: handoff.idempotency_key,
        workOrderNumber: handoff.work_order.number,
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          ...auditActor(user),
          action: 'WORK_ORDER_RECEIVED',
          entityType: 'Inspection',
          entityId: created.id,
          metadata: {
            workOrderKey: handoff.idempotency_key,
            workOrderNumber: handoff.work_order.number,
            inspectionType,
            priority: priorityFor(handoff),
            scheduledAt: scheduledAt.toISOString().slice(0, 10),
            sourceSystem: handoff.source_system,
          },
        },
      });
      return created;
    });
    return { inspectionId: inspection.id, outcome: 'created' };
  }
}

export function isClosed(status: string | null | undefined): boolean {
  return CLOSED_STATUSES.has((status ?? '').trim().toLowerCase());
}

/** Pest control is Crystal Creek Pest's; everything else the crews repair is maintenance. */
export function inspectionTypeFor(handoff: WorkOrderHandoff): InspectionType {
  const category = (handoff.work_order.category ?? '').toLowerCase();
  const pestVendor = handoff.vendors.some(
    (vendor) => vendor.in_house && /pest/i.test(vendor.name ?? ''),
  );
  return category.includes('pest') || pestVendor
    ? InspectionType.PEST_CONTROL
    : InspectionType.MAINTENANCE;
}

/** HIGH for an emergency or a work order the office marked high; STANDARD otherwise. */
export function priorityFor(handoff: WorkOrderHandoff): string {
  if (handoff.work_order.is_emergency) return 'HIGH';
  return /high|urgent|emergency/i.test(handoff.work_order.priority ?? '') ? 'HIGH' : 'STANDARD';
}

/**
 * The day the visit is booked for. A work order arrives with no appointment,
 * and the column cannot be empty: the day the tenant allowed entry when the
 * office recorded one, else the day it arrived here. The office moves it when
 * it schedules the crew; until then it reads as "came in today".
 */
export function scheduledDayFor(handoff: WorkOrderHandoff, today: Date = new Date()): Date {
  for (const candidate of [
    handoff.work_order.date_to_enter,
    handoff.work_order.scheduled_end_date,
  ]) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() >= startOfUtcDay(today).getTime())
      return startOfUtcDay(parsed);
  }
  return startOfUtcDay(today);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * What the technician needs, in the visit's notes: the office keeps the same
 * things in a Jobber visit's Details. Tenant contact is context for the visit,
 * never on a shared report.
 */
export function notesFor(handoff: WorkOrderHandoff): string {
  const wo = handoff.work_order;
  const lines: string[] = [];
  const headline = [
    wo.number !== null ? `Work order #${wo.number}` : 'Work order',
    wo.propertyware_id ? `(Propertyware ${wo.propertyware_id})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  lines.push(headline);
  const kind = [wo.category, wo.type].filter(Boolean).join(' · ');
  if (kind) lines.push(kind);
  const urgency = [
    wo.priority ? `Priority ${wo.priority}` : null,
    wo.is_emergency === true ? 'EMERGENCY' : null,
    wo.zone ? `Zone ${wo.zone}` : null,
    handoff.occupied ? 'Occupied' : 'Vacant',
    wo.authorized_to_enter ? `Authorized to enter: ${wo.authorized_to_enter}` : null,
  ].filter(Boolean);
  if (urgency.length) lines.push(urgency.join(' · '));
  const status = [wo.status, wo.service_status].filter(Boolean).join(' / ');
  if (status) lines.push(`Status: ${status}`);
  for (const tenant of handoff.tenants) {
    const contact = [tenant.name, tenant.phone, tenant.email].filter(Boolean).join(' ');
    if (contact) lines.push(`Tenant: ${contact}`);
  }
  if (handoff.vendors.length)
    lines.push(
      `Vendors: ${handoff.vendors
        .map(
          (vendor) =>
            `${vendor.name ?? vendor.propertyware_id ?? '?'}${vendor.in_house ? ' (in-house)' : ''}`,
        )
        .join(', ')}`,
    );
  if (wo.description?.trim()) lines.push('', wo.description.trim());
  if (wo.specific_location) lines.push(`Specific location: ${wo.specific_location}`);
  if (typeof wo.cost_estimate === 'number') lines.push(`Estimate: $${wo.cost_estimate.toFixed(2)}`);
  // The sender's approval filter (2026-11-19): which rule let the work order
  // through, and which items the owner said yes to, in the owner's words, so
  // the technician knows what to do and what to leave alone.
  const approval = handoff.approval;
  if (approval && approval.rule) {
    const how: Record<string, string> = {
      emergency: 'emergency, no approval needed',
      under_threshold: `under the $${approval.threshold.toFixed(0)} threshold, no approval needed`,
      owner_approved_recorded: `on record${approval.recorded_by ? ` by ${approval.recorded_by}` : ''}${approval.recorded_at ? ` on ${approval.recorded_at.slice(0, 10)}` : ''}`,
      owner_approved_in_messages: `read from messages by AI${approval.ai_confidence !== null ? ` (${approval.ai_confidence}%)` : ''}`,
      manual: 'sent by hand from the maintenance app',
    };
    lines.push('', `Owner approval: ${how[approval.rule] ?? approval.rule}`);
    if (approval.summary) lines.push(approval.summary);
    for (const problem of approval.problems) {
      const decision =
        problem.decision === 'approved'
          ? 'APPROVED'
          : problem.decision === 'declined'
            ? 'declined'
            : 'not mentioned';
      lines.push(
        `- ${problem.item}: ${decision}${problem.evidence ? ` — "${problem.evidence}"` : ''}`,
      );
    }
  }
  if (handoff.notes?.length) {
    lines.push('', 'Notes:');
    for (const note of handoff.notes.slice(0, 20)) {
      const head = [note.date ? note.date.slice(0, 10) : null, note.author]
        .filter(Boolean)
        .join(' ');
      const label = [head || null, note.subject ?? null].filter(Boolean).join(', ');
      const text = note.body.length > 400 ? `${note.body.slice(0, 397)}…` : note.body;
      lines.push(`- ${note.is_private ? '(private) ' : ''}${label ? `${label}: ` : ''}${text}`);
    }
  }
  const links = [
    wo.url ? `Maintenance app: ${wo.url}` : null,
    wo.jobber.web_uri ? `Jobber: ${wo.jobber.web_uri}` : null,
  ].filter((line): line is string => line !== null);
  if (links.length) lines.push('', ...links);
  return lines.join('\n');
}
