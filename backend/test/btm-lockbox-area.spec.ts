import 'reflect-metadata';

import { AreaChecklistItemKind, InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import {
  type InspectionCreationClient,
  type InspectionPlan,
  insertInspection,
} from '../src/admin/inspection-creation';
import type { AuthenticatedUser } from '../src/common/auth';
import { checklistItemAsked, checklistSectionWhere } from '../src/common/checklist-kind';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * Every back-to-market visit ends at the sign, supra and lockbox (Moses,
 * 2026-10-08): "Installed?", "Key functioning?" and a box for notes. Built in,
 * rather than added by hand on each job as he had been doing.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const LOCKBOX = 'Sign, supra and lockbox';

function client({ named = [] as { name: string }[], existing = null as { id: string } | null } = {}) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const create = jest.fn().mockResolvedValue({ id: 'inspection-1' });
  const propertyArea = {
    findMany: jest.fn().mockResolvedValue(named),
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockResolvedValue({ id: 'area-lockbox' }),
  };
  return {
    tx: {
      areaChecklistItem: { createMany },
      inspection: { create },
      property: { upsert: jest.fn().mockResolvedValue({}) },
      propertyArea,
    } as unknown as InspectionCreationClient,
    createMany,
    create,
    propertyArea,
  };
}

function plan(inspectionType: InspectionType): InspectionPlan {
  return {
    organizationId: ORGANIZATION,
    inspectionType,
    property: { id: 'building-1', name: 'Building 1' },
    unit: null,
    lease: null,
    baselineInspectionId: null,
    scheduledAt: new Date('2026-10-08'),
    scheduledStartAt: null,
    scheduledEndAt: null,
    technicianWillCapture: false,
    scopedAreas: [{ id: 'area-kitchen' }, { id: 'area-bed-2' }],
  } as unknown as InspectionPlan;
}

const details = { createdById: 'user-1' } as Parameters<typeof insertInspection>[2];

describe('a back-to-market inspection is created', () => {
  it('with the sign, supra and lockbox after its rooms', async () => {
    const { tx, create, propertyArea } = client({ named: [{ name: 'Kitchen' }, { name: 'Bedroom 2' }] });
    await insertInspection(tx, plan(InspectionType.BACK_TO_MARKET), details);

    expect(create.mock.calls[0][0].data.areas.create).toEqual([
      { propertyAreaId: 'area-kitchen' },
      { propertyAreaId: 'area-bed-2' },
      { propertyAreaId: 'area-lockbox' },
    ]);
    // A system area: nobody drew it, and no other visit to the property lists it.
    expect(propertyArea.create.mock.calls[0][0].data).toMatchObject({
      propertyId: 'building-1',
      unitId: null,
      floorId: null,
      name: LOCKBOX,
      source: 'SYSTEM',
      status: 'APPROVED',
      isRequired: true,
      inspectionOrder: 10_000,
    });
  });

  it('reusing the property’s area from an earlier visit', async () => {
    const { tx, create, propertyArea } = client({ existing: { id: 'area-from-last-time' } });
    await insertInspection(tx, plan(InspectionType.BACK_TO_MARKET), details);
    expect(propertyArea.create).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.areas.create).toContainEqual({ propertyAreaId: 'area-from-last-time' });
  });

  it('without a second one when the office picked one a technician added by hand', async () => {
    const { tx, create, propertyArea } = client({ named: [{ name: 'Kitchen' }, { name: 'Sign, Supra, and Lockbox' }] });
    await insertInspection(tx, plan(InspectionType.BACK_TO_MARKET), details);
    expect(propertyArea.create).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.areas.create).toHaveLength(2);
  });

  it('with the questions, in their own section of the occupied list', async () => {
    const { tx, createMany } = client();
    await insertInspection(tx, plan(InspectionType.BACK_TO_MARKET), details);
    const rows = createMany.mock.calls.flatMap(([call]) => call.data) as {
      label: string;
      section: string | null;
      kind: AreaChecklistItemKind;
      responseType: string;
      choices: string[];
      keywords: string[];
      sortOrder: number;
    }[];
    const lockbox = rows.filter((row) => row.section === LOCKBOX);
    expect(lockbox.map((row) => [row.label, row.responseType, row.choices])).toEqual([
      ['Installed?', 'CHOICE', ['Yes', 'No']],
      ['Key functioning?', 'CHOICE', ['Yes', 'No']],
      ['Notes on installation or the key', 'TEXT', []],
    ]);
    expect(lockbox.every((row) => row.kind === AreaChecklistItemKind.OCCUPIED && !row.keywords.length)).toBe(true);
    expect(createMany.mock.calls.every(([call]) => call.skipDuplicates)).toBe(true);
  });

  it.each([InspectionType.OCCUPIED, InspectionType.MOVE_OUT, InspectionType.MOVE_IN])(
    'but a %s inspection is not given it',
    async (type) => {
      const { tx, create, propertyArea } = client();
      await insertInspection(tx, plan(type), details);
      expect(propertyArea.create).not.toHaveBeenCalled();
      expect(create.mock.calls[0][0].data.areas.create).toHaveLength(2);
    },
  );
});

describe('which questions an occupied-style area asks', () => {
  it('gives the sign, supra and lockbox its own section and every other room none', () => {
    expect(checklistSectionWhere('OCCUPIED', LOCKBOX)).toEqual({ section: LOCKBOX });
    // Strict: "the whole list" would put "Key functioning?" in every bedroom.
    expect(checklistSectionWhere('OCCUPIED', 'Kitchen')).toEqual({ section: null });
    expect(checklistItemAsked('OCCUPIED', 'Kitchen', LOCKBOX)).toBe(false);
    expect(checklistItemAsked('OCCUPIED', 'Kitchen', null)).toBe(true);
    expect(checklistItemAsked('OCCUPIED', LOCKBOX, null)).toBe(false);
    expect(checklistItemAsked('OCCUPIED', LOCKBOX, LOCKBOX)).toBe(true);
  });

  it('leaves HVAC as it was: a section area asks its own, any other area the whole list', () => {
    expect(checklistSectionWhere('AIR_CONDITIONING', 'Attic')).toEqual({ section: 'Attic' });
    expect(checklistSectionWhere('AIR_CONDITIONING', 'HVAC System')).toEqual({});
    expect(checklistItemAsked('AIR_CONDITIONING', 'HVAC System', 'Attic')).toBe(true);
  });
});

describe('a back-to-market job booked before the area was built in', () => {
  const technician: AuthenticatedUser = {
    id: '10000000-0000-4000-8000-000000000004',
    authUserId: 'auth-technician',
    organizationId: ORGANIZATION,
    displayName: 'Field Technician',
    roles: [UserRole.INSPECTION_TECHNICIAN],
    permissions: [],
    mustChangePassword: false,
    principalType: 'USER',
  };

  function job({
    inspectionType = 'BACK_TO_MARKET',
    status = 'IN_PROGRESS',
    names = ['Kitchen', 'Bedroom 2'],
  } = {}) {
    const tx = {
      areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 3 }) },
      property: { upsert: jest.fn().mockResolvedValue({}) },
      propertyArea: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'area-lockbox' }),
      },
      inspectionArea: { upsert: jest.fn().mockResolvedValue({ id: 'room-lockbox' }) },
    };
    // The names the job already has; the rooms the phone is sent are the
    // ordered query, and empty here.
    const findMany = jest.fn(async (args: { orderBy?: unknown }) =>
      args.orderBy ? [] : names.map((name) => ({ propertyArea: { name } })),
    );
    const prisma = {
      inspectionArea: { findMany },
      $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    };
    const service = new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
    jest.spyOn(service as never, 'assignedInspection').mockResolvedValue({
      id: 'inspection-1',
      inspectionType,
      status,
      propertywareBuilding: {
        id: 'building-1',
        name: 'Building 1',
        addressLine1: '1 Test St',
        city: 'Houston',
        state: 'TX',
        postalCode: '77001',
      },
      propertywareUnit: null,
    } as never);
    return { service, tx, prisma };
  }

  it('gets it the first time the phone opens it', async () => {
    const { service, tx } = job();
    await service.rooms(technician, 'inspection-1');
    expect(tx.areaChecklistItem.createMany).toHaveBeenCalled();
    expect(tx.inspectionArea.upsert).toHaveBeenCalledWith({
      where: { inspectionId_propertyAreaId: { inspectionId: 'inspection-1', propertyAreaId: 'area-lockbox' } },
      create: { inspectionId: 'inspection-1', propertyAreaId: 'area-lockbox' },
      update: {},
    });
  });

  it('is left alone once it has one, the hand-made kind included', async () => {
    const { service, prisma } = job({ names: ['Kitchen', 'Sign, supra and lockbox'] });
    await service.rooms(technician, 'inspection-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['TECHNICIAN_SUBMITTED', 'REVIEW_REQUIRED', 'COMPLETED', 'CANCELLED'])(
    'is never changed once %s',
    async (status) => {
      const { service, prisma } = job({ status });
      await service.rooms(technician, 'inspection-1');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('is not done for any other kind of visit', async () => {
    const { service, prisma } = job({ inspectionType: 'OCCUPIED' });
    await service.rooms(technician, 'inspection-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
