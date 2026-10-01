import { InspectionStatus } from '@prisma/client';

import type { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { PlanDayMoveService } from '../src/planning/plan-day-move.service';
import type { QuarterPlannerService } from '../src/planning/quarter-planner.service';
import type { TbpStopEditService } from '../src/planning/tbp-stop-edit.service';

/**
 * A visit clicked on the Days map joins the day picked in the list (the office,
 * 2026-10-02), moved the way the console already moves that kind of visit.
 */

const COORDINATOR = {
  id: 'user-1',
  organizationId: 'org-1',
  principalType: 'USER',
  permissions: ['planning:read', 'planning:publish', 'inspections:manage'],
} as unknown as AuthenticatedUser;

/** A day far enough ahead never to have passed. */
const TO_DAY = { date: new Date('2099-01-06T00:00:00.000Z'), technicianId: 'tech-1' };

function build(
  stop: {
    scheduledOn?: string | null;
    assignedTechnicianId?: string | null;
    inspectionId?: string | null;
    inspectionStatus?: InspectionStatus;
  } = {},
  day: { date: Date; technicianId: string } | null = TO_DAY,
) {
  const inspectionId = stop.inspectionId === undefined ? 'insp-1' : stop.inspectionId;
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    tbpQuarterPlanDay: { findFirst: jest.fn().mockResolvedValue(day) },
    tbpQuarterPlanStop: {
      findFirst: jest.fn().mockResolvedValue({
        scheduledOn: stop.scheduledOn === null ? null : new Date(`${stop.scheduledOn ?? '2099-01-05'}T00:00:00.000Z`),
        assignedTechnicianId: stop.assignedTechnicianId === undefined ? 'tech-1' : stop.assignedTechnicianId,
        inspectionId,
        inspection: inspectionId ? { status: stop.inspectionStatus ?? InspectionStatus.SCHEDULED, finalizedAt: null } : null,
      }),
    },
    auditLog: { create: auditCreate },
  } as unknown as PrismaService;
  const edits = { edit: jest.fn().mockResolvedValue({}) };
  const admin = { updateInspection: jest.fn().mockResolvedValue({}) };
  const planner = { optimizeDays: jest.fn().mockResolvedValue([]) };
  const service = new PlanDayMoveService(
    prisma,
    edits as unknown as TbpStopEditService,
    admin as unknown as AdminService,
    planner as unknown as QuarterPlannerService,
  );
  return { service, edits, admin, planner, auditCreate };
}

describe('a visit moved onto a day from the map', () => {
  it('reschedules a booked visit as the console does, then orders both days from home', async () => {
    const { service, admin, edits, planner, auditCreate } = build();

    const moved = await service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1');

    expect(admin.updateInspection).toHaveBeenCalledWith(COORDINATOR, 'insp-1', { scheduledAt: '2099-01-06' });
    expect(edits.edit).not.toHaveBeenCalled();
    expect(planner.optimizeDays).toHaveBeenCalledWith('org-1', 'plan-1', [
      { date: '2099-01-05', technicianId: 'tech-1' },
      { date: '2099-01-06', technicianId: 'tech-1' },
    ]);
    expect(moved).toMatchObject({ from: { date: '2099-01-05' }, to: { date: '2099-01-06', technicianId: 'tech-1' } });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_VISIT_MOVED_TO_DAY',
      actorUserId: 'user-1',
      metadata: { booked: true },
    });
  });

  it('places a visit not booked yet through the plan’s own edit, day and technician together', async () => {
    const { service, admin, edits, planner } = build({ inspectionId: null, scheduledOn: null, assignedTechnicianId: null });

    await service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1');

    expect(edits.edit).toHaveBeenCalledWith(COORDINATOR, 'stop-1', { scheduledOn: '2099-01-06', assignedTechnicianId: 'tech-1' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
    // It had no day, so only the day it joined is ordered again.
    expect(planner.optimizeDays).toHaveBeenCalledWith('org-1', 'plan-1', [{ date: '2099-01-06', technicianId: 'tech-1' }]);
  });

  it('moves a booking only to another day of the same technician', async () => {
    const { service, admin } = build({ assignedTechnicianId: 'tech-2' });

    await expect(service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'BOOKED_FOR_SOMEONE_ELSE' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
  });

  it('leaves a visit somebody has started where it is', async () => {
    const { service, admin } = build({ inspectionStatus: InspectionStatus.IN_PROGRESS });

    await expect(service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'VISIT_STARTED' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
  });

  it('needs the permission to manage inspections to move a booking', async () => {
    const planner = { ...COORDINATOR, permissions: ['planning:read', 'planning:publish'] } as unknown as AuthenticatedUser;
    const { service, admin } = build();

    await expect(service.move(planner, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
  });

  it('refuses a day that has passed', async () => {
    const { service, admin, edits } = build({}, { date: new Date('2020-01-06T00:00:00.000Z'), technicianId: 'tech-1' });

    await expect(service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'PLAN_DAY_PASSED' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
    expect(edits.edit).not.toHaveBeenCalled();
  });

  it('refuses a visit already on that day', async () => {
    const { service } = build({ scheduledOn: '2099-01-06' });

    await expect(service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'ALREADY_ON_THAT_DAY' });
  });

  it('refuses a day of another plan or organization', async () => {
    const { service } = build({}, null);

    await expect(service.move(COORDINATOR, 'plan-1', 'day-2', 'stop-1')).rejects.toMatchObject({ code: 'PLAN_DAY_NOT_FOUND' });
  });
});
