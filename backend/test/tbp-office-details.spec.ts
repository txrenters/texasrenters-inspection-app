import { InspectionType, TbpPlanStatus, TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import {
  TbpPlanService,
  matchOfficeDetails,
  previousTechnicians,
  rankBootstrapVisits,
} from '../src/planning/tbp-plan.service';

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

const tenancy = (id: string, addressLine1: string, postalCode = '77433-8797') => ({
  id,
  externalId: `ext-${id}`,
  leaseName: `Lease ${id}`,
  startDate: null,
  zone: '1',
  addressLine1,
  postalCode,
  hvacFilterSizes: ['16x25x1'],
  hvacFilterLocation: null,
  managementPlan: 'Standard',
  hvacPlan: 'On our AC Plan',
  propertywareBuildingId: `building-${id}`,
});

describe('matching the office’s sheet to the quarter’s tenancies', () => {
  const tenancies = [
    tenancy('t1', '19803 Bolton Bridge Ln'),
    tenancy('t2', '2455 Morgan Ridge Ln', '77469'),
    tenancy('t3', '5009 N Main St', '77009'),
    tenancy('t4', '5009 N Main St', '77009'),
  ];

  it('matches by address the way the Jobber sync does, ZIP+4 or not', () => {
    const { byTenantId, unmatched } = matchOfficeDetails(
      [{ address: '19803 Bolton Bridge Lane', postalCode: '77433', details: 'Filter Change: 20x25x1 + Occupied Inspection' }],
      tenancies,
    );

    expect(byTenantId.get('t1')).toBe('Filter Change: 20x25x1 + Occupied Inspection');
    expect(unmatched).toEqual([]);
  });

  it('matches an address one side wrote without its street type', () => {
    const { byTenantId } = matchOfficeDetails(
      [{ address: '2455 Morgan Ridge', postalCode: '77469-1234', details: 'Filter Change + Occupied Inspection' }],
      tenancies,
    );

    expect(byTenantId.get('t2')).toBe('Filter Change + Occupied Inspection');
  });

  /** A building with two enrolled units: the sheet row cannot say which, so neither gets it. */
  it('gives a row matching two tenancies to neither, and says so', () => {
    const { byTenantId, ambiguous } = matchOfficeDetails(
      [{ address: '5009 N Main St', postalCode: '77009', details: 'Filter Change + Occupied Inspection' }],
      tenancies,
    );

    expect(byTenantId.size).toBe(0);
    expect(ambiguous.map((row) => row.address)).toEqual(['5009 N Main St']);
  });

  it('keeps the first row for a tenancy and reports the second', () => {
    const { byTenantId, duplicates } = matchOfficeDetails(
      [
        { address: '19803 Bolton Bridge Ln', postalCode: '77433', details: 'first' },
        { address: '19803 Bolton Bridge Ln', postalCode: '77433', details: 'second' },
      ],
      tenancies,
    );

    expect(byTenantId.get('t1')).toBe('first');
    expect(duplicates).toHaveLength(1);
  });

  it('reports an address it cannot find', () => {
    const { unmatched } = matchOfficeDetails([{ address: '1 Nowhere Rd', postalCode: '77001', details: 'x' }], tenancies);

    expect(unmatched.map((row) => row.address)).toEqual(['1 Nowhere Rd']);
  });
});

describe('importing the office’s sheet into a draft', () => {
  type SheetStop = {
    id: string;
    status: TbpStopStatus;
    inspectionId: string | null;
    inspectionType: InspectionType;
    tenant: ReturnType<typeof tenancy>;
    visitDetailsOverriddenAt?: Date | null;
  };
  const build = (options: { planStatus?: TbpPlanStatus; stops?: SheetStop[] } = {}) => {
    const planUpdate = jest.fn().mockResolvedValue({});
    const stopUpdate = jest.fn().mockResolvedValue({});
    const auditCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      tbpQuarterPlan: {
        findFirst: jest.fn().mockResolvedValue({ id: 'plan-1', status: options.planStatus ?? TbpPlanStatus.DRAFT }),
        update: planUpdate,
      },
      tbpQuarterPlanStop: {
        findMany: jest.fn().mockResolvedValue(
          (
            options.stops ?? [
              { id: 's1', status: TbpStopStatus.PLANNED, inspectionId: null, inspectionType: InspectionType.HVAC, tenant: tenancy('t1', '19803 Bolton Bridge Ln') },
              { id: 's2', status: TbpStopStatus.PLANNED, inspectionId: null, inspectionType: InspectionType.OCCUPIED, tenant: tenancy('t2', '7 Elm St') },
              { id: 's3', status: TbpStopStatus.PUBLISHED, inspectionId: 'insp-3', inspectionType: InspectionType.OCCUPIED, tenant: tenancy('t3', '9 Oak St') },
            ]
          ).map((stop) => ({
            visitDetailsOverriddenAt: null,
            // Frozen at generation, from the tenancy.
            hvacFilterSizes: stop.tenant.hvacFilterSizes,
            ...stop,
          })),
        ),
        update: stopUpdate,
      },
      auditLog: { create: auditCreate },
    } as unknown as PrismaService;
    return { service: new TbpPlanService(prisma), planUpdate, stopUpdate, auditCreate };
  };

  const ROWS = [
    { address: '19803 Bolton Bridge Ln', city: 'Katy', postalCode: '77433-8797', details: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection' },
    { address: '9 Oak St', city: 'Katy', postalCode: '77433-8797', details: 'Filter Change: 14x20x1 + Pest Control + Occupied Inspection' },
    { address: '1 Nowhere Rd', city: 'Katy', postalCode: '77001', details: 'Filter Change + Occupied Inspection' },
    { address: '3 Blank St', city: 'Katy', postalCode: '77001', details: '   ' },
  ];

  it('gives each matched stop the office’s line, as an HVAC inspection where the stop is one', async () => {
    const { service, stopUpdate } = build();

    await service.importOfficeDetails(USER, 'plan-1', ROWS);

    const s1 = stopUpdate.mock.calls.find((call) => call[0].where.id === 's1')![0].data;
    expect(s1.officeDetails).toBe('Filter Change: 20x25x1 + Pest Control + Occupied Inspection');
    expect(s1.visitDetails.split('\n')[0]).toBe('Filter Change: 20x25x1 + Pest Control + HVAC Inspection');
  });

  it('writes a tenancy the sheet does not cover from the tenant report instead', async () => {
    const { service, stopUpdate } = build();

    const summary = await service.importOfficeDetails(USER, 'plan-1', ROWS);

    const s2 = stopUpdate.mock.calls.find((call) => call[0].where.id === 's2')![0].data;
    expect(s2.officeDetails).toBeNull();
    expect(s2.visitDetails.split('\n')[0]).toBe('Filter Change: 16x25x1 + Pest Control + Occupied Inspection');
    expect(summary.stopsWithoutOfficeDetails).toBe(1);
  });

  /** A published stop's Details are what Jobber was sent. */
  it('leaves a published stop alone, and does not call its row unmatched', async () => {
    const { service, stopUpdate } = build();

    const summary = await service.importOfficeDetails(USER, 'plan-1', ROWS);

    expect(stopUpdate.mock.calls.some((call) => call[0].where.id === 's3')).toBe(false);
    expect(summary.unmatched.map((row) => row.address)).toEqual(['1 Nowhere Rd']);
    expect(summary).toMatchObject({ rows: 3, matched: 2 });
  });

  it('keeps the rows on the plan, without the blank ones', async () => {
    const { service, planUpdate } = build();

    await service.importOfficeDetails(USER, 'plan-1', ROWS);

    expect(planUpdate.mock.calls[0][0].data.officeDetailsRows).toHaveLength(3);
    expect(planUpdate.mock.calls[0][0].data.officeDetailsImportedAt).toBeInstanceOf(Date);
  });

  /** The sheet carries addresses and whatever the office typed; the audit row counts, and quotes nothing. */
  it('audits the import in counts only', async () => {
    const { service, auditCreate } = build();

    await service.importOfficeDetails(USER, 'plan-1', ROWS);

    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('TBP_PLAN_OFFICE_DETAILS_IMPORTED');
    expect(JSON.stringify(audit.metadata)).not.toContain('Bolton');
    expect(audit.metadata).toMatchObject({ rows: 3, matched: 2, unmatched: 1 });
  });

  it('refuses a plan that is no longer a draft', async () => {
    const { service, planUpdate } = build({ planStatus: TbpPlanStatus.PUBLISHED });

    await expect(service.importOfficeDetails(USER, 'plan-1', ROWS)).rejects.toMatchObject({ code: 'PLAN_NOT_DRAFT' });
    expect(planUpdate).not.toHaveBeenCalled();
  });

  /** A coordinator wrote those Details in the visit's window; the sheet's line is kept beside them. */
  it('keeps Details a coordinator wrote, and still records the sheet’s line', async () => {
    const { service, stopUpdate } = build({
      stops: [
        {
          id: 's1',
          status: TbpStopStatus.PLANNED,
          inspectionId: null,
          inspectionType: InspectionType.HVAC,
          tenant: tenancy('t1', '19803 Bolton Bridge Ln'),
          visitDetailsOverriddenAt: new Date('2026-09-16'),
        },
      ],
    });

    await service.importOfficeDetails(USER, 'plan-1', ROWS);

    expect(stopUpdate.mock.calls[0][0].data).toEqual({
      officeDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
    });
  });
});

describe('a coordinator choosing a stop’s kind of visit', () => {
  const build = (
    stop: Partial<{
      status: TbpStopStatus;
      inspectionId: string | null;
      planStatus: TbpPlanStatus;
      officeDetails: string | null;
      visitDetails: string | null;
      visitDetailsOverriddenAt: Date | null;
      onSiteMinutesOverriddenAt: Date | null;
    }> = {},
  ) => {
    const stopUpdate = jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 's1', ...args.data }));
    const auditCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      tbpQuarterPlanStop: {
        findFirst: jest.fn().mockResolvedValue({
          id: 's1',
          planId: 'plan-1',
          status: stop.status ?? TbpStopStatus.PLANNED,
          inspectionId: stop.inspectionId ?? null,
          inspectionType: InspectionType.OCCUPIED,
          officeDetails: stop.officeDetails ?? 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection (BX Plan)',
          visitDetails: stop.visitDetails ?? null,
          visitDetailsOverriddenAt: stop.visitDetailsOverriddenAt ?? null,
          onSiteMinutesOverriddenAt: stop.onSiteMinutesOverriddenAt ?? null,
          hvacFilterSizes: ['16x25x1'],
          plan: { status: stop.planStatus ?? TbpPlanStatus.DRAFT, occupiedVisitMinutes: 30, hvacVisitMinutes: 45 },
          tenant: { ...tenancy('t1', '19803 Bolton Bridge Ln'), managementPlan: 'BX' },
        }),
        update: stopUpdate,
      },
      auditLog: { create: auditCreate },
    } as unknown as PrismaService;
    return { service: new TbpPlanService(prisma), stopUpdate, auditCreate };
  };

  it('makes it that kind, with the Details and the visit length to match, and keeps it through regeneration', async () => {
    const { service, stopUpdate, auditCreate } = build();

    await service.setInspectionType(USER, 's1', 'HVAC');

    const data = stopUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      inspectionType: 'HVAC',
      inspectionTypeReason: 'SET_BY_COORDINATOR',
      inspectionTypeNeedsReview: false,
      onSiteMinutes: 45,
    });
    expect(data.inspectionTypeOverriddenAt).toBeInstanceOf(Date);
    expect(String(data.visitDetails).split('\n')[0]).toBe('Filter Change: 20x25x1 + Pest Control + HVAC Inspection (BX Plan)');
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_PLAN_STOP_TYPE_SET',
      metadata: { planId: 'plan-1', from: 'OCCUPIED', to: 'HVAC' },
    });
  });

  /** Their words stay; only the inspection their services line names follows the new kind. */
  it('renames the inspection in Details a coordinator wrote, and keeps a length they set', async () => {
    const { service, stopUpdate } = build({
      visitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\nCall the tenant first',
      visitDetailsOverriddenAt: new Date('2026-09-16'),
      onSiteMinutesOverriddenAt: new Date('2026-09-16'),
    });

    await service.setInspectionType(USER, 's1', 'HVAC');

    const data = stopUpdate.mock.calls[0][0].data;
    expect(data.visitDetails).toBe('Filter Change: 20x25x1 + Pest Control + HVAC Inspection\nCall the tenant first');
    expect(data).not.toHaveProperty('onSiteMinutes');
  });

  it('refuses a stop that is already an inspection', async () => {
    const { service, stopUpdate } = build({ status: TbpStopStatus.PUBLISHED, inspectionId: 'insp-1' });

    await expect(service.setInspectionType(USER, 's1', 'HVAC')).rejects.toMatchObject({ code: 'STOP_NOT_EDITABLE' });
    expect(stopUpdate).not.toHaveBeenCalled();
  });
});

/** 5009 N Main St: a building of three units, and a coordinator's choices on its visits. */
describe('rebuilding a draft keeps what a coordinator edited', () => {
  const UNITS = [
    { id: 'unit-house', name: 'House', addressLine1: '5009 N Main St' },
    { id: 'unit-half', name: '1/2', addressLine1: '5009 1/2 N Main St' },
    { id: 'unit-quarter', name: '1/4', addressLine1: '5009 1/4 N Main St' },
  ];
  const build = (existing: Record<string, unknown>) => {
    const tenant = {
      ...tenancy('t1', '5009 N Main St', '77009'),
      managementPlan: 'Basic',
      hvacPlan: 'On our AC Plan',
      hvacFilterSizes: [
        '20x20x1 (N Main)',
        '16x20x1 (1/2 N Main)',
        '14x18x1 (1/2 N Main)',
        'reusable window AC unit (no need to change - 1/4 N Main)',
      ],
    };
    const stopUpsert = jest.fn().mockResolvedValue({});
    const prisma = {
      tbpQuarterPlan: {
        findUnique: jest.fn().mockResolvedValue({ id: 'plan-1', status: TbpPlanStatus.DRAFT }),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({ id: 'plan-1', officeDetailsRows: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      propertywareTenant: { findMany: jest.fn().mockResolvedValue([{ ...tenant, tbpEnrollment: 'Yes' }]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      tbpQuarterPlanStop: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1',
          status: TbpStopStatus.PLANNED,
          sequenceOverriddenAt: null,
          inspectionId: null,
          inspectionType: InspectionType.HVAC,
          inspectionTypeOverriddenAt: null,
          visitDetails: null,
          visitTitleOverriddenAt: null,
          visitDetailsOverriddenAt: null,
          propertywareUnitId: null,
          unitOverriddenAt: null,
          ...existing,
        }),
        upsert: stopUpsert,
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(1),
      },
      propertywareUnit: { findMany: jest.fn().mockResolvedValue(UNITS) },
      // The lease report carries no unit, and nobody has inspected these units yet.
      propertywareLease: { findMany: jest.fn().mockResolvedValue([]) },
      inspection: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    return { service: new TbpPlanService(prisma), stopUpsert };
  };

  it('keeps the unit, title and Details a coordinator set, with the unit’s own filter sizes', async () => {
    const { service, stopUpsert } = build({
      visitDetails: 'Filter Change: 16x20x1 + HVAC Inspection\nCall the tenant first',
      visitTitleOverriddenAt: new Date('2026-09-16'),
      visitDetailsOverriddenAt: new Date('2026-09-16'),
      propertywareUnitId: 'unit-half',
      unitOverriddenAt: new Date('2026-09-16'),
    });

    const result = await service.generate('org-1', { year: 2026, quarter: 4 });

    expect(result.blockedCount).toBe(0);
    const update = stopUpsert.mock.calls[0][0].update;
    expect(update).toMatchObject({
      propertywareUnitId: 'unit-half',
      unitResolution: 'MANUAL',
      hvacFilterSizes: ['16x20x1', '14x18x1'],
      visitDetails: 'Filter Change: 16x20x1 + HVAC Inspection\nCall the tenant first',
      status: TbpStopStatus.PLANNED,
      blockedCode: null,
    });
    expect(update).not.toHaveProperty('visitTitle');
  });

  it('writes the title at the chosen unit’s door, and renames the inspection in a coordinator’s Details when the kind changes', async () => {
    const { service, stopUpsert } = build({
      inspectionType: InspectionType.OCCUPIED,
      visitDetails: 'Filter Change: 16x20x1 + Occupied Inspection\nCall the tenant first',
      visitDetailsOverriddenAt: new Date('2026-09-16'),
      propertywareUnitId: 'unit-half',
      unitOverriddenAt: new Date('2026-09-16'),
    });

    await service.generate('org-1', { year: 2026, quarter: 4 });

    const update = stopUpsert.mock.calls[0][0].update;
    expect(update.inspectionType).toBe('HVAC');
    expect(update.visitDetails).toBe('Filter Change: 16x20x1 + HVAC Inspection\nCall the tenant first');
    expect(update.visitTitle).toBe('5009 1/2 N Main St - Zone 1 - Q4 2026 Tenant Benefit Package');
  });

  it('still asks for the unit of a building of several when nobody has chosen it', async () => {
    const { service, stopUpsert } = build({});

    const result = await service.generate('org-1', { year: 2026, quarter: 4 });

    expect(result.blockedCount).toBe(1);
    expect(stopUpsert.mock.calls[0][0].update).toMatchObject({ status: TbpStopStatus.BLOCKED, blockedCode: 'UNIT_REQUIRED' });
  });
});

describe('who took a tenancy’s visit last', () => {
  it('reads the newest quarter that names a technician', () => {
    const technicians = previousTechnicians([
      [
        { tenantExternalId: 'a', sequence: 1, technicianId: 'tech-new' },
        { tenantExternalId: 'b', sequence: 2, technicianId: null },
      ],
      [
        { tenantExternalId: 'a', sequence: 1, technicianId: 'tech-old' },
        { tenantExternalId: 'b', sequence: 1, technicianId: 'tech-old' },
      ],
    ]);

    expect(Object.fromEntries(technicians)).toEqual({ a: 'tech-new', b: 'tech-old' });
  });

  it('carries the Jobber assignee of each visit into the order it recovers', () => {
    const { ranks } = rankBootstrapVisits(
      [
        { startAt: '2026-07-02T05:00:00Z', street1: 'first ave', street2: null, postalCode: '77001', technicianEmail: 'moses@example.com' },
        { startAt: '2026-07-03T05:00:00Z', street1: 'second st', street2: null, postalCode: '77001', technicianEmail: null },
      ],
      (visit) => (visit.street1 === 'first ave' ? 't-1' : 't-2'),
    );

    expect(ranks).toEqual([
      { tenantExternalId: 't-1', sequence: 1, technicianEmail: 'moses@example.com' },
      { tenantExternalId: 't-2', sequence: 2 },
    ]);
  });
});
