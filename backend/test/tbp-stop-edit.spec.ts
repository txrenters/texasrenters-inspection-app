import { InspectionStatus, InspectionType, TbpPlanStatus, TbpStopStatus, TbpUnitResolution } from '@prisma/client';
import { withInspectionLink, withoutInspectionLink } from '@texasrenters/shared';

import type { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import type { QuarterPlannerService } from '../src/planning/quarter-planner.service';
import type { TbpPlanService } from '../src/planning/tbp-plan.service';
import type { TbpPublishService } from '../src/planning/tbp-publish.service';
import { TbpStopEditService, dayInQuarter, detailsProblem } from '../src/planning/tbp-stop-edit.service';

/** Whether this server sends the console's edits to Jobber, per test. */
const jobber = { pushEditsEnabled: true };
jest.mock('../src/integrations/jobber/jobber.config', () => ({
  ...jest.requireActual('../src/integrations/jobber/jobber.config'),
  getJobberConfig: () => jobber,
}));
// Monday 5 October 2026 in Texas: a booked visit may move to that day or later.
jest.mock('../src/common/business-day', () => ({
  ...jest.requireActual('../src/common/business-day'),
  businessDate: () => '2026-10-05',
}));

const USER = {
  id: 'user-1',
  authUserId: 'auth-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const OCCUPIED_DETAILS = 'Filter Change: 20x20x1 + Pest Control + Occupied Inspection\n\nInstruction for completion\n1.Change filters';
const HVAC_DETAILS = 'Filter Change: 20x20x1 + Pest Control + HVAC Inspection\n\nInstruction for completion\n3.HVAC / Occupied Inspection';

/** 4815 N Fictional St: one building, three units, and filter sizes the office labels by unit. */
const UNITS = [
  { id: 'unit-half', name: '1/2', addressLine1: '4815 1/2 N Fictional St' },
  { id: 'unit-quarter', name: '1/4', addressLine1: '4815 1/4 N Fictional St' },
  { id: 'unit-house', name: 'House', addressLine1: '4815 N Fictional St' },
];

const build = (
  overrides: Record<string, unknown> = {},
  options: { technicianActive?: boolean; plan?: Record<string, unknown>; assignedTo?: string } = {},
) => {
  const stop = {
    id: 's1',
    planId: 'plan-1',
    status: TbpStopStatus.PLANNED,
    blockedCode: null,
    inspectionId: null,
    inspectionType: InspectionType.OCCUPIED,
    scheduledOn: new Date('2026-10-06T00:00:00.000Z'),
    assignedTechnicianId: 'tech-1',
    propertywareBuildingId: 'building-1',
    propertywareUnitId: null,
    officeDetails: null,
    visitTitle: '4815 N Fictional St - Zone 1 - Q4 2026 Tenant Benefit Package',
    visitTitleOverriddenAt: null,
    visitDetails: OCCUPIED_DETAILS,
    visitDetailsOverriddenAt: null,
    onSiteMinutes: 30,
    hvacFilterSizes: ['20x20x1'],
    plan: {
      status: TbpPlanStatus.DRAFT,
      quarterYear: 2026,
      quarterNumber: 4,
      maxOnSiteMinutes: 360,
      startsOn: null,
      jobberUnassigned: false,
      ...options.plan,
    },
    inspection: null,
    tenant: {
      addressLine1: '4815 N Fictional St',
      zone: '1',
      hvacFilterSizes: [
        '20x20x1 (N Fictional)',
        '16x20x1 (1/2 N Fictional)',
        '14x18x1 (1/2 N Fictional)',
        'reusable window AC unit (no need to change - 1/4 N Fictional)',
      ],
      hvacFilterLocation: null,
      managementPlan: 'Basic',
      hvacPlan: 'On our AC Plan',
    },
    ...overrides,
  };

  const stopUpdate = jest.fn().mockResolvedValue({});
  const auditCreate = jest.fn().mockResolvedValue({});
  const planUpdate = jest.fn().mockResolvedValue({});
  const prisma = {
    tbpQuarterPlanStop: {
      findFirst: jest.fn().mockResolvedValue(stop),
      update: stopUpdate,
      count: jest.fn().mockResolvedValue(2),
    },
    tbpQuarterPlan: { update: planUpdate },
    userProfile: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(options.technicianActive === false ? null : { id: where.id }),
      ),
    },
    propertywareUnit: { findMany: jest.fn().mockResolvedValue(UNITS) },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(options.assignedTo ? { technicianId: options.assignedTo } : null) },
    auditLog: { create: auditCreate },
  } as unknown as PrismaService;
  const plans = {
    setInspectionType: jest.fn().mockResolvedValue({
      id: 's1',
      inspectionType: 'HVAC',
      inspectionTypeReason: 'SET_BY_COORDINATOR',
      onSiteMinutes: 45,
      visitDetails: HVAC_DETAILS,
    }),
  } as unknown as TbpPlanService;
  const planner = {
    measureDays: jest.fn().mockResolvedValue(undefined),
    optimizeDays: jest.fn().mockResolvedValue([]),
  } as unknown as QuarterPlannerService;
  // A booked visit's day, technician and Jobber text change the way the inspection's own page changes them.
  const admin = {
    updateInspection: jest.fn().mockResolvedValue({}),
    assign: jest.fn().mockResolvedValue({}),
    reassign: jest.fn().mockResolvedValue({}),
    updateJobberVisit: jest.fn().mockResolvedValue({}),
  } as unknown as AdminService;

  // A draft plan never reaches the publisher; a published one does.
  const publisher = { placeOne: jest.fn().mockResolvedValue(null) } as unknown as TbpPublishService;

  return {
    service: new TbpStopEditService(prisma, plans, planner, publisher, admin),
    admin,
    stopUpdate,
    auditCreate,
    planUpdate,
    plans,
    planner,
    publisher,
  };
};

const written = (stopUpdate: jest.Mock) => stopUpdate.mock.calls[0]![0].data as Record<string, unknown>;

describe('a coordinator editing a visit in a draft', () => {
  it('moves a visit to another day and technician, kept through a rebuild, and measures both days', async () => {
    const { service, stopUpdate, planner, auditCreate } = build();

    const result = await service.edit(USER, 's1', { scheduledOn: '2026-10-08', assignedTechnicianId: 'tech-2' });

    expect(result.changed).toEqual(['scheduledOn', 'assignedTechnicianId']);
    const data = written(stopUpdate);
    expect(data).toMatchObject({ scheduledOn: new Date('2026-10-08T00:00:00.000Z'), assignedTechnicianId: 'tech-2' });
    expect(data.scheduleOverriddenAt).toBeInstanceOf(Date);
    expect(data.technicianOverriddenAt).toBeInstanceOf(Date);
    expect(planner.measureDays).toHaveBeenCalledWith('org-1', 'plan-1', [
      { date: '2026-10-06', technicianId: 'tech-1' },
      { date: '2026-10-08', technicianId: 'tech-2' },
    ]);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_PLAN_STOP_EDITED',
      entityId: 's1',
      metadata: {
        fields: ['scheduledOn', 'assignedTechnicianId'],
        from: { date: '2026-10-06', technicianId: 'tech-1' },
        to: { date: '2026-10-08', technicianId: 'tech-2' },
      },
    });
  });

  /** A new day keeps its technician with it through a rebuild: the visit was placed by a person. */
  it('keeps the technician with a visit whose day alone was changed', async () => {
    const { service, stopUpdate } = build();

    await service.edit(USER, 's1', { scheduledOn: '2026-10-08' });

    const data = written(stopUpdate);
    expect(data).not.toHaveProperty('assignedTechnicianId');
    expect(data.technicianOverriddenAt).toBeInstanceOf(Date);
  });

  it('places a visit routing could not place, once it has a day and a technician', async () => {
    const { service, stopUpdate, planUpdate, planner } = build({
      status: TbpStopStatus.BLOCKED,
      blockedCode: 'NOT_PLACED',
      scheduledOn: null,
      assignedTechnicianId: null,
    });

    await service.edit(USER, 's1', { scheduledOn: '2026-10-08', assignedTechnicianId: 'tech-2' });

    expect(written(stopUpdate)).toMatchObject({ status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null });
    expect(planner.measureDays).toHaveBeenCalledWith('org-1', 'plan-1', [{ date: '2026-10-08', technicianId: 'tech-2' }]);
    expect(planUpdate).toHaveBeenCalledWith({ where: { id: 'plan-1' }, data: { blockedCount: 2 } });
  });

  it('leaves it needing attention while it has a day but nobody to take it', async () => {
    const { service, stopUpdate, planner } = build({
      status: TbpStopStatus.BLOCKED,
      blockedCode: 'NOT_PLACED',
      scheduledOn: null,
      assignedTechnicianId: null,
    });

    await service.edit(USER, 's1', { scheduledOn: '2026-10-08' });

    expect(written(stopUpdate)).not.toHaveProperty('status');
    expect(planner.measureDays).not.toHaveBeenCalled();
  });

  it('refuses a day outside the quarter and someone who is not an active technician, writing nothing', async () => {
    const { service, stopUpdate } = build();
    await expect(service.edit(USER, 's1', { scheduledOn: '2027-01-04' })).rejects.toMatchObject({ code: 'DATE_OUTSIDE_QUARTER' });
    await expect(service.edit(USER, 's1', { scheduledOn: '2026-11-31' })).rejects.toMatchObject({ code: 'INVALID_DATE' });

    const inactive = build({}, { technicianActive: false });
    await expect(inactive.service.edit(USER, 's1', { assignedTechnicianId: 'tech-9', visitTitle: 'x' })).rejects.toMatchObject({
      code: 'NOT_A_TECHNICIAN',
    });

    expect(stopUpdate).not.toHaveBeenCalled();
    expect(inactive.stopUpdate).not.toHaveBeenCalled();
  });

  /** Any day of the quarter is the office's to choose for one visit -- a Monday kept for reschedules included. */
  it('takes any day of the quarter', () => {
    expect(dayInQuarter('2026-10-05', { year: 2026, quarter: 4 })).toBe('2026-10-05');
    expect(dayInQuarter('2026-12-31', { year: 2026, quarter: 4 })).toBe('2026-12-31');
    expect(() => dayInQuarter('2026-09-30', { year: 2026, quarter: 4 })).toThrow();
  });

  /** A plan may start up to fifteen days either side of its quarter's first day (the office, 2026-09-19). */
  it('takes any day from a plan’s own start', () => {
    expect(dayInQuarter('2026-09-21', { year: 2026, quarter: 4 }, '2026-09-21')).toBe('2026-09-21');
    expect(() => dayInQuarter('2026-09-18', { year: 2026, quarter: 4 }, '2026-09-21')).toThrow('from 2026-09-21');
    expect(() => dayInQuarter('2026-10-02', { year: 2026, quarter: 4 }, '2026-10-05')).toThrow();
  });

  it('keeps “Tenant Benefit Package” in a title a coordinator writes', async () => {
    const { service, stopUpdate, planner } = build();
    await expect(service.edit(USER, 's1', { visitTitle: '4815 N Fictional St - Zone 1' })).rejects.toMatchObject({
      code: 'VISIT_TITLE_NOT_TBP',
    });

    await service.edit(USER, 's1', { visitTitle: '  4815 N Fictional St -  Zone 1 - Q4 2026 Tenant Benefit Package - gate ' });

    const data = written(stopUpdate);
    expect(data.visitTitle).toBe('4815 N Fictional St - Zone 1 - Q4 2026 Tenant Benefit Package - gate');
    expect(data.visitTitleOverriddenAt).toBeInstanceOf(Date);
    expect(planner.measureDays).not.toHaveBeenCalled();
  });

  /** The sync reads the inspection off the Details; a visit whose Details lose it stops becoming one. */
  it('sends Details as a coordinator wrote them, when they still name the visit’s inspection', async () => {
    const { service, stopUpdate, auditCreate } = build();
    await expect(service.edit(USER, 's1', { visitDetails: 'Filter Change: 20x20x1 + Pest Control' })).rejects.toMatchObject({
      code: 'VISIT_DETAILS_INSPECTION',
    });

    await service.edit(USER, 's1', {
      visitDetails: 'Filter Change: 20x20x1 + Pest Control + Occupied Inspection\r\nGate code is at the office\r\n',
    });

    const data = written(stopUpdate);
    expect(data.visitDetails).toBe('Filter Change: 20x20x1 + Pest Control + Occupied Inspection\nGate code is at the office');
    expect(data.visitDetailsOverriddenAt).toBeInstanceOf(Date);
    expect(JSON.stringify(auditCreate.mock.calls[0][0].data.metadata)).not.toContain('Gate code');
  });

  it('says what Details are missing for each kind of visit', () => {
    expect(detailsProblem(OCCUPIED_DETAILS, 'OCCUPIED')).toBeNull();
    expect(detailsProblem(HVAC_DETAILS, 'HVAC')).toBeNull();
    expect(detailsProblem(OCCUPIED_DETAILS, 'HVAC')).toMatch(/Keep “HVAC Inspection” on the services line/);
    expect(detailsProblem(HVAC_DETAILS, 'OCCUPIED')).toMatch(/Change the kind of visit instead/);
    expect(detailsProblem('Pest Control only', 'OCCUPIED')).toMatch(/Keep “Occupied Inspection”/);
  });

  it('changes the kind of visit and its Details together, checking the Details against the new kind', async () => {
    const { service, stopUpdate, plans, planner } = build();

    const result = await service.edit(USER, 's1', {
      inspectionType: 'HVAC',
      visitDetails: 'Filter Change: 20x20x1 + HVAC Inspection\nCall first',
    });

    expect(plans.setInspectionType).toHaveBeenCalledWith(USER, 's1', 'HVAC');
    expect(result.changed).toEqual(['inspectionType', 'visitDetails']);
    expect(written(stopUpdate).visitDetails).toBe('Filter Change: 20x20x1 + HVAC Inspection\nCall first');
    // Forty-five minutes now, so its day is measured again.
    expect(planner.measureDays).toHaveBeenCalledWith('org-1', 'plan-1', [{ date: '2026-10-06', technicianId: 'tech-1' }]);
  });

  it('counts a visit at the length a coordinator sets, and measures its day again', async () => {
    const { service, stopUpdate, planner } = build();
    await expect(service.edit(USER, 's1', { onSiteMinutes: 400 })).rejects.toMatchObject({ code: 'INVALID_VISIT_LENGTH' });

    await service.edit(USER, 's1', { onSiteMinutes: 60 });

    const data = written(stopUpdate);
    expect(data.onSiteMinutes).toBe(60);
    expect(data.onSiteMinutesOverriddenAt).toBeInstanceOf(Date);
    expect(planner.measureDays).toHaveBeenCalledWith('org-1', 'plan-1', [{ date: '2026-10-06', technicianId: 'tech-1' }]);
  });

  /**
   * The tenant and lease reports hold only the building, so which of its units
   * a tenancy is behind is a person's to say -- and the filter sizes the office
   * labels by unit follow the unit chosen.
   */
  it('settles the unit of a building of several, with that unit’s filter sizes and door', async () => {
    const { service, stopUpdate, planner, auditCreate } = build({
      status: TbpStopStatus.BLOCKED,
      blockedCode: 'UNIT_REQUIRED',
      scheduledOn: null,
      assignedTechnicianId: null,
      inspectionType: InspectionType.HVAC,
      visitDetails: HVAC_DETAILS,
    });

    await service.edit(USER, 's1', { propertywareUnitId: 'unit-half' });

    const data = written(stopUpdate);
    expect(data).toMatchObject({
      propertywareUnitId: 'unit-half',
      unitResolution: TbpUnitResolution.MANUAL,
      hvacFilterSizes: ['16x20x1', '14x18x1'],
      visitTitle: '4815 1/2 N Fictional St - Zone 1 - Q4 2026 Tenant Benefit Package',
      // Settled, but still without a day: routing's block says what is left.
      blockedCode: 'NOT_PLACED',
    });
    expect(String(data.visitDetails).split('\n')[0]).toBe('Filter Change: 16x20x1; 14x18x1 + Pest Control + HVAC Inspection');
    expect(data.unitOverriddenAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty('status');
    expect(planner.measureDays).not.toHaveBeenCalled();
    expect(auditCreate.mock.calls[0][0].data.metadata).toMatchObject({ unit: { from: null, to: 'unit-half' } });
  });

  it('leaves a coordinator’s own title and Details alone when the unit is chosen', async () => {
    const { service, stopUpdate } = build({
      visitTitleOverriddenAt: new Date('2026-09-16'),
      visitDetailsOverriddenAt: new Date('2026-09-16'),
    });

    await service.edit(USER, 's1', { propertywareUnitId: 'unit-house' });

    const data = written(stopUpdate);
    expect(data.hvacFilterSizes).toEqual(['20x20x1']);
    expect(data).not.toHaveProperty('visitTitle');
    expect(data).not.toHaveProperty('visitDetails');
  });

  it('refuses a unit that is not one of the property’s', async () => {
    const { service, stopUpdate } = build();

    await expect(service.edit(USER, 's1', { propertywareUnitId: 'unit-elsewhere' })).rejects.toMatchObject({
      code: 'NOT_A_UNIT_OF_THE_BUILDING',
    });
    expect(stopUpdate).not.toHaveBeenCalled();
  });

  it('refuses a visit published but not yet given its inspection, and one left out', async () => {
    const publishing = build({ status: TbpStopStatus.PUBLISHED });
    await expect(publishing.service.edit(USER, 's1', { onSiteMinutes: 60 })).rejects.toMatchObject({ code: 'STOP_NOT_EDITABLE' });
    const excluded = build({ status: TbpStopStatus.EXCLUDED });
    await expect(excluded.service.edit(USER, 's1', { onSiteMinutes: 60 })).rejects.toMatchObject({ code: 'STOP_NOT_EDITABLE' });
    expect(publishing.stopUpdate).not.toHaveBeenCalled();
    expect(excluded.stopUpdate).not.toHaveBeenCalled();
  });

  /**
   * The office (2026-09-20), on a quarter whose publish had failed: "opening
   * this dialougue wont let me edit it". A visit the quarter could not place
   * has no inspection, and giving it a day is the whole way out of that state.
   */
  it('lets a visit with no inspection be changed after the quarter is published', async () => {
    const { service, stopUpdate } = build({}, { plan: { status: TbpPlanStatus.PUBLISHED } });

    const result = await service.edit(USER, 's1', { onSiteMinutes: 60 });

    expect(result.changed).toEqual(['onSiteMinutes']);
    expect(stopUpdate).toHaveBeenCalled();
  });

  /** A visit given its day on a published quarter becomes its inspection at once. */
  it('creates the inspection for a visit placed after the quarter is published', async () => {
    const { service, publisher } = build(
      { scheduledOn: null, assignedTechnicianId: null, status: TbpStopStatus.UNSCHEDULED },
      { plan: { status: TbpPlanStatus.PUBLISHED } },
    );
    (publisher.placeOne as jest.Mock).mockResolvedValue('PUBLISHED');

    const result = await service.edit(USER, 's1', { scheduledOn: '2026-10-06', assignedTechnicianId: 'tech-1' });

    expect(publisher.placeOne).toHaveBeenCalledWith(USER, 's1');
    expect(result.placed).toBe(true);
  });

  /** A draft's visits are published by the quarter, not one at a time. */
  it('leaves a draft’s visit to the quarter’s own publish', async () => {
    const { service, publisher } = build();

    await service.edit(USER, 's1', { scheduledOn: '2026-10-07' });

    expect(publisher.placeOne).not.toHaveBeenCalled();
  });

  it('writes nothing for an edit that changes nothing', async () => {
    const { service, stopUpdate, auditCreate, planner } = build();

    const result = await service.edit(USER, 's1', { scheduledOn: '2026-10-06', assignedTechnicianId: 'tech-1', onSiteMinutes: 30 });

    expect(result.changed).toEqual([]);
    expect(stopUpdate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(planner.measureDays).not.toHaveBeenCalled();
  });
});

/**
 * A visit already booked, changed from the plan's window as a draft's is (the
 * office, 2026-10-06): "if we want to reschedule it from October sixth to
 * October seventh we should be able to do so by clicking the field just like
 * the unpublished one" -- and Jobber told.
 */
describe('a coordinator changing a booked visit from the plan', () => {
  const MANAGER = { ...USER, permissions: ['planning:publish', 'inspections:manage', 'inspections:assign'] } as unknown as AuthenticatedUser;
  const LINK = 'https://inspection.example/inspections/insp-1';
  const booked = (
    inspection: Record<string, unknown> = {},
    plan: Record<string, unknown> = {},
    options: { assignedTo?: string } = {},
  ) =>
    build(
      {
        status: TbpStopStatus.PUBLISHED,
        inspectionId: 'insp-1',
        inspection: {
          status: InspectionStatus.SCHEDULED,
          finalizedAt: null,
          jobberVisitId: 'jobber-visit-1',
          jobberVisitTitle: '4815 N Fictional St - Zone 1 - Q4 2026 Tenant Benefit Package',
          jobberVisitDetails: withInspectionLink(OCCUPIED_DETAILS, LINK),
          ...inspection,
        },
      },
      { plan: { status: TbpPlanStatus.PUBLISHED, ...plan }, assignedTo: options.assignedTo ?? 'tech-1' },
    );

  beforeEach(() => {
    jobber.pushEditsEnabled = true;
  });

  it('reschedules it through its inspection, which tells Jobber, and orders both days again', async () => {
    const { service, admin, planner, stopUpdate } = booked();

    const result = await service.edit(MANAGER, 's1', { scheduledOn: '2026-10-07' });

    expect(admin.updateInspection).toHaveBeenCalledWith(MANAGER, 'insp-1', { scheduledAt: '2026-10-07' });
    expect(planner.optimizeDays).toHaveBeenCalledWith('org-1', 'plan-1', [
      { date: '2026-10-06', technicianId: 'tech-1' },
      { date: '2026-10-07', technicianId: 'tech-1' },
    ]);
    // Never measured as a draft's day: that counts only unpublished visits.
    expect(planner.measureDays).not.toHaveBeenCalled();
    // The reschedule moved the stop with the inspection; nothing else to write.
    expect(stopUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 's1', changed: ['scheduledOn'], sentToJobber: true });
  });

  it('gives it to someone else through its assignment, which tells Jobber, and the plan follows', async () => {
    const { service, admin, stopUpdate } = booked();

    await service.edit(MANAGER, 's1', { assignedTechnicianId: 'tech-2' });

    expect(admin.reassign).toHaveBeenCalledWith(MANAGER, 'insp-1', expect.objectContaining({ technicianId: 'tech-2' }));
    expect(stopUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({ assignedTechnicianId: 'tech-2', technicianOverriddenAt: expect.any(Date) }),
    });
  });

  it('assigns one nobody holds', async () => {
    const { service, admin } = booked({}, {}, { assignedTo: '' });

    await service.edit(MANAGER, 's1', { assignedTechnicianId: 'tech-2' });

    expect(admin.assign).toHaveBeenCalledWith(MANAGER, 'insp-1', expect.objectContaining({ technicianId: 'tech-2' }));
    expect(admin.reassign).not.toHaveBeenCalled();
  });

  it('moves it between day groups on a quarter sent out to nobody, telling Jobber nothing', async () => {
    const { service, admin, stopUpdate } = booked({}, { jobberUnassigned: true });

    const result = await service.edit(MANAGER, 's1', { assignedTechnicianId: 'tech-2' });

    expect(admin.assign).not.toHaveBeenCalled();
    expect(admin.reassign).not.toHaveBeenCalled();
    expect(stopUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ assignedTechnicianId: 'tech-2' }) });
    expect(result.sentToJobber).toBe(false);
  });

  it('sends a new title and Details to its Jobber visit with the link back to the inspection, and keeps them on the plan', async () => {
    const { service, admin, stopUpdate } = booked();
    const details = OCCUPIED_DETAILS.replace('Change filters', 'Change both filters');

    const result = await service.edit(MANAGER, 's1', {
      visitTitle: '4815 N Fictional St - Back gate - Q4 2026 Tenant Benefit Package',
      visitDetails: details,
    });

    expect(admin.updateJobberVisit).toHaveBeenCalledWith(MANAGER, 'insp-1', {
      title: '4815 N Fictional St - Back gate - Q4 2026 Tenant Benefit Package',
      details: expect.stringContaining('Texas Renters inspection: '),
    });
    const sent = (admin.updateJobberVisit as jest.Mock).mock.calls[0][2].details as string;
    expect(withoutInspectionLink(sent)).toBe(details);
    expect(stopUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({ visitDetails: details, visitDetailsOverriddenAt: expect.any(Date) }),
    });
    expect(result.changed).toEqual(['visitTitle', 'visitDetails']);
  });

  it('changes the Details the Jobber visit holds now, which the console may have edited since publishing', async () => {
    const edited = OCCUPIED_DETAILS.replace('Change filters', 'Ring the side bell');
    const { service, admin } = booked({ jobberVisitDetails: withInspectionLink(edited, LINK) });

    // The same words sent back are no change, although the plan's own copy differs.
    const result = await service.edit(MANAGER, 's1', { visitDetails: edited });

    expect(admin.updateJobberVisit).not.toHaveBeenCalled();
    expect(result.changed).toEqual([]);
  });

  it('keeps the Details as they are when only the title changes', async () => {
    const { service, admin } = booked();

    await service.edit(MANAGER, 's1', { visitTitle: '4815 N Fictional St - Q4 2026 Tenant Benefit Package' });

    expect((admin.updateJobberVisit as jest.Mock).mock.calls[0][2].details).toBe(withInspectionLink(OCCUPIED_DETAILS, LINK));
  });

  it('changes its time on site on the plan alone, and orders its day again', async () => {
    const { service, admin, planner, stopUpdate } = booked();

    const result = await service.edit(MANAGER, 's1', { onSiteMinutes: 45 });

    expect(stopUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: expect.objectContaining({ onSiteMinutes: 45 }) });
    expect(planner.optimizeDays).toHaveBeenCalled();
    expect(admin.updateInspection).not.toHaveBeenCalled();
    expect(result.sentToJobber).toBe(false);
  });

  it('keeps the kind of visit and the unit it was booked for', async () => {
    const { service, stopUpdate } = booked();

    await expect(service.edit(MANAGER, 's1', { inspectionType: 'HVAC' })).rejects.toMatchObject({ code: 'BOOKED_KIND_FIXED' });
    await expect(service.edit(MANAGER, 's1', { propertywareUnitId: 'unit-half' })).rejects.toMatchObject({ code: 'BOOKED_UNIT_FIXED' });
    expect(stopUpdate).not.toHaveBeenCalled();
  });

  it('leaves a visit somebody has started, finished or called off as it is', async () => {
    for (const status of [InspectionStatus.IN_PROGRESS, InspectionStatus.TECHNICIAN_SUBMITTED, InspectionStatus.CANCELLED]) {
      const { service, admin } = booked({ status });
      await expect(service.edit(MANAGER, 's1', { scheduledOn: '2026-10-07' })).rejects.toMatchObject({ code: 'VISIT_STARTED' });
      expect(admin.updateInspection).not.toHaveBeenCalled();
    }
  });

  it('does not move it into the past', async () => {
    const { service, admin } = booked();

    await expect(service.edit(MANAGER, 's1', { scheduledOn: '2026-10-02' })).rejects.toMatchObject({ code: 'DATE_PASSED' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
  });

  it('asks for the grants the inspection’s own page asks for', async () => {
    const planner = { ...USER, permissions: ['planning:publish'] } as unknown as AuthenticatedUser;
    const { service, admin } = booked();

    await expect(service.edit(planner, 's1', { scheduledOn: '2026-10-07' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.edit(planner, 's1', { assignedTechnicianId: 'tech-2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
    expect(admin.reassign).not.toHaveBeenCalled();
  });

  it('changes nothing Jobber holds where the console’s edits are not sent there', async () => {
    jobber.pushEditsEnabled = false;
    const { service, admin, stopUpdate } = booked();

    await expect(service.edit(MANAGER, 's1', { scheduledOn: '2026-10-07' })).rejects.toMatchObject({ code: 'JOBBER_EDITS_OFF' });
    await expect(service.edit(MANAGER, 's1', { assignedTechnicianId: 'tech-2' })).rejects.toMatchObject({ code: 'JOBBER_EDITS_OFF' });
    expect(admin.updateInspection).not.toHaveBeenCalled();
    expect(stopUpdate).not.toHaveBeenCalled();
    // The plan's own figure is still the office's to change.
    await expect(service.edit(MANAGER, 's1', { onSiteMinutes: 45 })).resolves.toMatchObject({ changed: ['onSiteMinutes'] });
  });
});

describe('the link back to the inspection in a booked visit’s Details', () => {
  it('comes out for editing and goes back in the same place', () => {
    const linked = withInspectionLink(OCCUPIED_DETAILS, 'https://inspection.example/inspections/insp-1');
    expect(linked).toContain('Texas Renters inspection: https://inspection.example/inspections/insp-1');
    expect(withoutInspectionLink(linked)).toBe(OCCUPIED_DETAILS);
    expect(withInspectionLink(withoutInspectionLink(linked), 'https://inspection.example/inspections/insp-1')).toBe(linked);
  });
});

describe('the technicians a visit can be given to', () => {
  it('lists the crew first in its order, then everyone else by name, with whether a home is on file', async () => {
    const prisma = {
      userProfile: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'amy', displayName: 'Amy Wilson' },
          { id: 'emanuel', displayName: 'Emanuel Hall' },
          { id: 'kevin', displayName: 'Kevin Granados' },
          { id: 'moses', displayName: 'Moses Rodriguez' },
          { id: 'thomas', displayName: 'Thomas Allen' },
        ]),
      },
      technicianPlanningProfile: {
        findMany: jest.fn().mockResolvedValue([
          { technicianId: 'moses', isPlannable: true, tbpZoneOrder: 1, homeLatitude: 29.8, homeLongitude: -95.4 },
          { technicianId: 'kevin', isPlannable: true, tbpZoneOrder: 2, homeLatitude: 29.7, homeLongitude: -95.5 },
          { technicianId: 'emanuel', isPlannable: true, tbpZoneOrder: 3, homeLatitude: null, homeLongitude: null },
          { technicianId: 'amy', isPlannable: true, tbpZoneOrder: null, homeLatitude: 29.9, homeLongitude: -95.3 },
          // On leave keeps a place in the rotation, and is not on the crew meanwhile.
          { technicianId: 'thomas', isPlannable: false, tbpZoneOrder: 4, homeLatitude: null, homeLongitude: null },
        ]),
      },
    } as unknown as PrismaService;
    const service = new TbpStopEditService(
      prisma,
      {} as TbpPlanService,
      {} as QuarterPlannerService,
      {} as TbpPublishService,
      {} as AdminService,
    );

    const technicians = await service.technicians('org-1');

    expect(technicians.map((technician) => [technician.displayName, technician.crewOrder, technician.hasHome])).toEqual([
      ['Moses Rodriguez', 1, true],
      ['Kevin Granados', 2, true],
      ['Emanuel Hall', 3, false],
      ['Amy Wilson', null, true],
      ['Thomas Allen', null, false],
    ]);
  });
});
