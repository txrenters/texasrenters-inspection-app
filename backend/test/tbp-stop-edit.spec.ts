import { InspectionType, TbpPlanStatus, TbpStopStatus, TbpUnitResolution } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import type { QuarterPlannerService } from '../src/planning/quarter-planner.service';
import type { TbpPlanService } from '../src/planning/tbp-plan.service';
import { TbpStopEditService, dayInQuarter, detailsProblem } from '../src/planning/tbp-stop-edit.service';

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

/** 5009 N Main St: one building, three units, and filter sizes the office labels by unit. */
const UNITS = [
  { id: 'unit-half', name: '1/2', addressLine1: '5009 1/2 N Main St' },
  { id: 'unit-quarter', name: '1/4', addressLine1: '5009 1/4 N Main St' },
  { id: 'unit-house', name: 'House', addressLine1: '5009 N Main St' },
];

const build = (
  overrides: Record<string, unknown> = {},
  options: { technicianActive?: boolean; plan?: Record<string, unknown> } = {},
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
    visitTitle: '5009 N Main St - Zone 1 - Q4 2026 Tenant Benefit Package',
    visitTitleOverriddenAt: null,
    visitDetails: OCCUPIED_DETAILS,
    visitDetailsOverriddenAt: null,
    onSiteMinutes: 30,
    hvacFilterSizes: ['20x20x1'],
    plan: { status: TbpPlanStatus.DRAFT, quarterYear: 2026, quarterNumber: 4, maxOnSiteMinutes: 360, ...options.plan },
    tenant: {
      addressLine1: '5009 N Main St',
      zone: '1',
      hvacFilterSizes: [
        '20x20x1 (N Main)',
        '16x20x1 (1/2 N Main)',
        '14x18x1 (1/2 N Main)',
        'reusable window AC unit (no need to change - 1/4 N Main)',
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
  const planner = { measureDays: jest.fn().mockResolvedValue(undefined) } as unknown as QuarterPlannerService;

  return { service: new TbpStopEditService(prisma, plans, planner), stopUpdate, auditCreate, planUpdate, plans, planner };
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
    await expect(service.edit(USER, 's1', { visitTitle: '5009 N Main St - Zone 1' })).rejects.toMatchObject({
      code: 'VISIT_TITLE_NOT_TBP',
    });

    await service.edit(USER, 's1', { visitTitle: '  5009 N Main St -  Zone 1 - Q4 2026 Tenant Benefit Package - gate ' });

    const data = written(stopUpdate);
    expect(data.visitTitle).toBe('5009 N Main St - Zone 1 - Q4 2026 Tenant Benefit Package - gate');
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
      visitTitle: '5009 1/2 N Main St - Zone 1 - Q4 2026 Tenant Benefit Package',
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

  it('refuses a visit already published, and any visit in a plan that is no longer a draft', async () => {
    const published = build({ status: TbpStopStatus.PUBLISHED, inspectionId: 'insp-1' });
    await expect(published.service.edit(USER, 's1', { onSiteMinutes: 60 })).rejects.toMatchObject({ code: 'STOP_NOT_EDITABLE' });

    const publishedPlan = build({}, { plan: { status: TbpPlanStatus.PUBLISHED } });
    await expect(publishedPlan.service.edit(USER, 's1', { onSiteMinutes: 60 })).rejects.toMatchObject({
      code: 'STOP_NOT_EDITABLE',
    });
    expect(published.stopUpdate).not.toHaveBeenCalled();
    expect(publishedPlan.stopUpdate).not.toHaveBeenCalled();
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
    const service = new TbpStopEditService(prisma, {} as TbpPlanService, {} as QuarterPlannerService);

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
