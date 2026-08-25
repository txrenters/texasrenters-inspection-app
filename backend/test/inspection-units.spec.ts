import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { AdminService } from '../src/admin/admin.service';
import { TechnicianService } from '../src/technician/technician.service';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'System Admin',
  roles: [UserRole.SYSTEM_ADMIN],
  permissions: [],
  mustChangePassword: false,
};

function mediaProcessingDouble() {
  return { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never;
}

const building = {
  id: 'building-1',
  externalId: 'ext-building',
  name: '4-Plex on Oak',
  addressLine1: '100 Oak St',
  addressLine2: null,
  city: 'Austin',
  state: 'TX',
  postalCode: '78701',
  portfolio: { name: 'Core' },
};

const unitB = {
  id: 'unit-b',
  externalId: 'ext-unit-b',
  name: 'B',
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
};

function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(building) },
    propertywareUnit: {
      findFirst: jest.fn().mockResolvedValue(unitB),
      count: jest.fn().mockResolvedValue(0),
    },
    propertywareLease: { findFirst: jest.fn().mockResolvedValue(null) },
    propertyArea: { findMany: jest.fn().mockResolvedValue([]) },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'inspection-1' }),
    },
    inspectionAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
}

function buildService(tx: ReturnType<typeof buildTx>) {
  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue({ id: 'inspection-1', assignments: [] }),
    },
    $transaction: jest.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return new AdminService(prisma as never);
}

describe('multi-unit inspection creation', () => {
  it('rejects unit-less inspections for buildings that have active units', async () => {
    const tx = buildTx({
      propertywareUnit: {
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'MOVE_IN',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 422, code: 'UNIT_REQUIRED' });
    expect(tx.propertyArea.findMany).not.toHaveBeenCalled();
  });

  it('still allows entire-property inspections for buildings without units', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }, { id: 'area-2' }]),
      },
    });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(tx.propertywareUnit.count).toHaveBeenCalled();
    // Unit-less inspections seed from the building-level (unitId null) areas.
    expect(tx.propertyArea.findMany).toHaveBeenCalledTimes(1);
    expect(tx.propertyArea.findMany.mock.calls[0][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: null,
    });
  });

  it("seeds a unit inspection from the unit's own approved areas when they exist", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'unit-b-area-1' }, { id: 'unit-b-area-2' }]);
    const tx = buildTx({ propertyArea: { findMany } });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      unitId: 'unit-b',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: 'unit-b',
    });
    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([
      { propertyAreaId: 'unit-b-area-1' },
      { propertyAreaId: 'unit-b-area-2' },
    ]);
  });

  it('falls back to building-level areas when the unit has no plan of its own', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([]) // unit-scoped query: nothing approved for unit B
      .mockResolvedValueOnce([{ id: 'shared-area-1' }]); // building-level fallback
    const tx = buildTx({ propertyArea: { findMany } });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      unitId: 'unit-b',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'MOVE_IN',
      priority: 'STANDARD',
    } as never);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where).toMatchObject({
      propertyId: 'building-1',
      unitId: null,
    });
    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([{ propertyAreaId: 'shared-area-1' }]);
    expect(createData.propertywareUnitId).toBe('unit-b');
  });

  /**
   * HVAC is scoped by equipment, not by an operator ticking areas.
   *
   * The office's rule: an HVAC visit covers every area that has an air
   * conditioner. It was previously lumped in with occupied and back-to-market
   * as a chosen subset, which meant somebody had to remember which rooms have
   * units in them and tick them by hand.
   */
  it('attaches only the areas that have air conditioning', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'hall', hasAirConditioning: true },
          { id: 'bathroom', hasAirConditioning: false },
          { id: 'bedroom', hasAirConditioning: true },
        ]),
      },
    });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'HVAC',
      priority: 'STANDARD',
    } as never);

    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([
      { propertyAreaId: 'hall' },
      { propertyAreaId: 'bedroom' },
    ]);
  });

  it('refuses an HVAC visit when the property has a layout but no unit is marked', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'hall', hasAirConditioning: false },
          { id: 'bathroom', hasAirConditioning: false },
        ]),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'HVAC',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'NO_AIR_CONDITIONED_AREAS' });
    // Creating it anyway would look like a scheduling success and reach the
    // technician as an empty job.
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  /**
   * Roof is scoped the same way, against the area's category rather than a
   * boolean. Same reasoning: the property records where its roof is, so
   * scheduling the visit is not somebody remembering to tick something.
   */
  it('attaches only the areas categorised as a roof', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'hall', hasAirConditioning: true, category: 'INDOOR_ROOM' },
          { id: 'roof', hasAirConditioning: false, category: 'ROOF' },
        ]),
      },
    });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'ROOF',
      priority: 'STANDARD',
    } as never);

    const createData = tx.inspection.create.mock.calls[0][0].data;
    expect(createData.areas.create).toEqual([{ propertyAreaId: 'roof' }]);
  });

  it('refuses a roof visit when the property records no roof', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'hall', hasAirConditioning: false, category: 'INDOOR_ROOM' }]),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'ROOF',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'NO_ROOF_AREAS' });
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  /**
   * The trap every off-cycle type falls into. The scheduler refuses a visit
   * that reads against a move-in when the property has never had one — so a
   * type not exempted is refused on most of the portfolio, with an error
   * blaming the missing move-in rather than the missing exemption.
   *
   * `inspection.findFirst` is not stubbed to return a baseline here, so this
   * passing means the lookup was never reached.
   */
  it('schedules off-cycle work on a property that has never had a move-in', async () => {
    for (const inspectionType of [
      'ROOF',
      'AC_FILTER_DELIVERY',
      'SUPRA_LOCKBOX_PLACEMENT',
      'SUPRA_LOCKBOX_REMOVAL',
    ]) {
      const tx = buildTx({
        propertyArea: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'roof', hasAirConditioning: true, category: 'ROOF' }]),
        },
      });
      const service = buildService(tx);

      await expect(
        service.createInspection(admin, {
          propertyId: 'building-1',
          scheduledAt: '2026-08-01T15:00:00.000Z',
          inspectionType,
          priority: 'STANDARD',
        } as never),
      ).resolves.toBeDefined();
    }
  });

  it('refuses a hand-picked area list on an HVAC visit', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'hall', hasAirConditioning: true }]),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'HVAC',
        priority: 'STANDARD',
        areaIds: ['hall'],
      } as never),
    ).rejects.toMatchObject({ status: 422, code: 'AREA_SELECTION_NOT_ALLOWED' });
  });

  // The CHOSEN path (occupied, back-to-market) is unchanged code and is covered
  // by the taxonomy tests in shared/. Asserting it here would mean standing up a
  // completed move-in baseline first, since those types refuse to be scheduled
  // without one — scaffolding for behaviour this change never touched.

  /**
   * The clash rule, which had two faults that only showed together.
   *
   * An office tried to book an HVAC visit on a unit whose move-in had already
   * been completed that morning and was told an inspection already existed. The
   * check keyed on property, unit and time but not on the *type*, and it counted
   * finished work as a live booking, so one completed inspection made a unit
   * unbookable for anything else for the rest of the day.
   */
  it('books an HVAC visit on a day a completed move-in already used', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'area-1', hasAirConditioning: true }]),
      },
    });
    const service = buildService(tx);

    await service.createInspection(admin, {
      propertyId: 'building-1',
      scheduledAt: '2026-08-01T15:00:00.000Z',
      inspectionType: 'HVAC',
      priority: 'STANDARD',
    } as never);

    const { where } = tx.inspection.findFirst.mock.calls[0][0];
    // The type is what makes two bookings the same job...
    expect(where.inspectionType).toBe('HVAC');
    // ...and finished work is a record, not a booking.
    expect(where.status).toEqual({ notIn: ['COMPLETED', 'CANCELLED'] });
    expect(tx.inspection.create).toHaveBeenCalled();
  });

  it('still refuses a second live inspection of the same type at the same time', async () => {
    const tx = buildTx({
      propertyArea: {
        findMany: jest.fn().mockResolvedValue([{ id: 'area-1', hasAirConditioning: true }]),
      },
      inspection: {
        findFirst: jest.fn().mockResolvedValue({ id: 'already-booked' }),
        create: jest.fn(),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'HVAC',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_INSPECTION' });
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  // Not "when the unique index catches a race", as this was named: there is no
  // unique index on Inspection beyond the primary key. What is covered is that a
  // P2002 from anywhere in the create (the nested area rows can raise one) still
  // surfaces as a 409 rather than a 500.
  it('reports a friendly conflict when the create raises a unique violation', async () => {
    const { Prisma } = jest.requireActual('@prisma/client');
    const raceError = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const tx = buildTx({
      propertyArea: { findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }]) },
      inspection: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(raceError),
      },
    });
    const service = buildService(tx);

    await expect(
      service.createInspection(admin, {
        propertyId: 'building-1',
        scheduledAt: '2026-08-01T15:00:00.000Z',
        inspectionType: 'MOVE_IN',
        priority: 'STANDARD',
      } as never),
    ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_INSPECTION' });
  });
});

describe('technician payloads for unit inspections', () => {
  const technician: AuthenticatedUser = {
    id: '10000000-0000-4000-8000-000000000004',
    authUserId: 'auth-technician',
    organizationId: admin.organizationId,
    displayName: 'Field Technician',
    roles: [UserRole.INSPECTION_TECHNICIAN],
    permissions: [],
    mustChangePassword: false,
  };

  it("uses the inspection's own unit for identity and bed/bath counts", async () => {
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'inspection-1',
          inspectionType: 'MOVE_IN',
          baselineInspectionId: null,
          baselineInspection: null,
          scheduledAt: new Date('2026-08-01T15:00:00.000Z'),
          status: 'SCHEDULED',
          priority: 'STANDARD',
          internalNotes: null,
          propertywareUnit: { id: 'unit-b', name: 'B', bedrooms: 1, bathrooms: 1 },
          propertywareBuilding: {
            id: 'building-1',
            externalId: 'ext-building',
            externalPortfolioId: 'ext-portfolio',
            name: '4-Plex on Oak',
            addressLine1: '100 Oak St',
            city: 'Austin',
            state: 'TX',
            postalCode: '78701',
          },
          areas: [],
          _count: { findings: 0 },
        }),
      },
    };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      mediaProcessingDouble(),
    );

    const context = await service.inspectionContext(technician, 'inspection-1');

    expect(context.inspection).toMatchObject({ unitId: 'unit-b', unitName: 'B' });
    expect(context.inspection.property.address).toBe('100 Oak St · Unit B');
    // Bed/bath counts come from the inspected unit, never "first unit wins".
    expect(context.property).toMatchObject({
      bedrooms: 1,
      bathrooms: 1,
      unitName: 'B',
      address: '100 Oak St · Unit B',
    });
  });
});
