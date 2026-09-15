import { UserRole, parseVisitDetails, type JobberBookingInput } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { AdminService } from '../src/admin/admin.service';
import { PresenceService } from '../src/realtime/presence.service';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * Creating an occupied inspection in the console and booking its Jobber visit
 * in the same request. People, addresses, numbers and ids invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-coordinator',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Coordinator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const property = {
  id: '20000000-0000-4000-8000-000000000001',
  organizationId: user.organizationId,
  externalId: 'pw-building-1',
  name: 'Sample House',
  addressLine1: '100 Main Street',
  addressLine2: null,
  city: 'Houston',
  state: 'TX',
  postalCode: '77001',
  portfolio: { id: 'portfolio-1', name: 'Active Portfolio', isActive: true },
  isActive: true,
};

const booking = (overrides: Partial<JobberBookingInput> = {}): JobberBookingInput => ({
  zone: 'Zone 3',
  benefitPackage: true,
  services: { filterChange: true, pestControl: true, fleaTreatment: false },
  filters: [{ size: '20x25x1', quantity: 2 }],
  planTier: 'Basic',
  hvacOptedOut: false,
  contactTenantsBeforeArrival: true,
  tenants: [{ name: 'Jane Q Sample', phones: ['(832) 555-0101'] }],
  accessNotes: ['Gate Code: 4321'],
  notes: [],
  ...overrides,
});

function build({
  connection = { status: 'CONNECTED' },
  links = [{ jobberPropertyId: 'jobber-property-1', jobberAddress: '100 Main Street', propertywareUnitId: null }],
}: {
  connection?: { status: string } | null;
  links?: { jobberPropertyId: string; jobberAddress: string | null; propertywareUnitId: string | null }[];
} = {}) {
  const tx = {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
    propertywareUnit: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    propertywareLease: { findFirst: jest.fn() },
    propertyArea: { findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }]) },
    areaChecklistItem: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'occupied-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue(connection) },
    jobberPropertyLink: { findMany: jest.fn().mockResolvedValue(links) },
    jobberOutboundTask: { create: jest.fn().mockResolvedValue({ id: 'task-1' }) },
  };
  const prisma = {
    ...ZERO_EVIDENCE,
    inspection: { findFirst: jest.fn().mockResolvedValue({ id: 'occupied-1', assignments: [] }) },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  return { service: new AdminService(prisma as never, new PresenceService()), tx, prisma };
}

const create = (service: AdminService, overrides: Record<string, unknown> = {}) =>
  service.createInspection(user, {
    propertyId: property.id,
    scheduledAt: '2026-10-06T00:00:00.000Z',
    inspectionType: 'OCCUPIED',
    priority: 'STANDARD',
    jobberBooking: booking(),
    ...overrides,
  } as never);

describe('creating an occupied inspection booked in Jobber', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_BOOKING_ENABLED = 'true';
    process.env.WEB_APP_ORIGIN = 'https://console.example.com/';
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('writes the visit onto the inspection and queues the booking in the same transaction', async () => {
    const { service, tx } = build();
    await create(service);

    const written = tx.inspection.update.mock.calls[0][0];
    expect(written.where).toEqual({ id: 'occupied-1' });
    expect(written.data.jobberVisitTitle).toBe('100 Main Street - Zone 3 - Q4 2026 Tenant Benefit Package');
    // The technician reads this on the phone before Jobber has answered.
    expect(parseVisitDetails(written.data.jobberVisitDetails).tenants).toEqual([
      { unit: null, name: 'Jane Q Sample', phones: ['(832) 555-0101'] },
    ]);
    expect(written.data.jobberVisitDetails).toContain(
      'Texas Renters inspection: https://console.example.com/inspections/occupied-1',
    );

    expect(tx.jobberOutboundTask.create).toHaveBeenCalledWith({
      data: {
        organizationId: user.organizationId,
        inspectionId: 'occupied-1',
        kind: 'VISIT_CREATE',
        status: 'PENDING',
        jobTitle: 'Zone 3 - Q4 2026 Tenant Benefit Package',
        createdById: user.id,
      },
    });
  });

  it('audits which property and services, never the Details', async () => {
    const { service, tx } = build();
    await create(service);

    const queued = tx.auditLog.create.mock.calls
      .map((call) => call[0].data)
      .find((entry) => entry.action === 'JOBBER_VISIT_BOOKING_QUEUED');
    expect(queued.metadata).toEqual({
      jobberPropertyId: 'jobber-property-1',
      inspectionType: 'OCCUPIED',
      benefitPackage: true,
      services: ['filterChange', 'pestControl'],
    });
    expect(JSON.stringify(queued.metadata)).not.toMatch(/555|4321|Sample/);
  });

  it('creates nothing when the property is not linked to Jobber', async () => {
    const { service, tx } = build({ links: [] });
    await expect(create(service)).rejects.toMatchObject({ status: 422, code: 'JOBBER_PROPERTY_NOT_LINKED' });
    expect(tx.jobberOutboundTask.create).not.toHaveBeenCalled();
  });

  it('refuses when Jobber is not connected', async () => {
    const { service } = build({ connection: { status: 'REAUTHORIZATION_REQUIRED' } });
    await expect(create(service)).rejects.toMatchObject({ status: 409, code: 'JOBBER_NOT_CONNECTED' });
  });

  it('refuses before the transaction when booking is switched off', async () => {
    delete process.env.JOBBER_BOOKING_ENABLED;
    const { service, prisma } = build();
    await expect(create(service)).rejects.toMatchObject({ status: 409, code: 'JOBBER_BOOKING_DISABLED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a booking for a kind of visit it has no Details format for', async () => {
    const { service, prisma } = build();
    await expect(create(service, { inspectionType: 'SUPRA_LOCKBOX_PLACEMENT' })).rejects.toMatchObject({
      status: 422,
      code: 'JOBBER_BOOKING_TYPE_UNSUPPORTED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("books a move-out in the office's move-out format, with no benefit-package services", async () => {
    const { service, tx } = build();
    // Sizes that would be refused on a benefit-package visit are not written here at all.
    await create(service, { inspectionType: 'MOVE_OUT', jobberBooking: booking({ filters: [{ size: 'UPDATE' }] }) });

    const written = tx.inspection.update.mock.calls[0][0].data;
    expect(written.jobberVisitTitle).toBe('100 Main Street - Zone 3 - Move out inspection');
    expect(written.jobberVisitDetails).toContain('• Conduct Move out inspection');
    expect(written.jobberVisitDetails).not.toMatch(/occupied\s+insp|Filter Change|UPDATE/i);
    expect(tx.jobberOutboundTask.create.mock.calls[0][0].data.jobTitle).toBe('Zone 3 - Move out inspection');

    const queued = tx.auditLog.create.mock.calls
      .map((call) => call[0].data)
      .find((entry) => entry.action === 'JOBBER_VISIT_BOOKING_QUEUED');
    expect(queued.metadata).toMatchObject({ inspectionType: 'MOVE_OUT', benefitPackage: false, services: [] });
  });

  it('says what is wrong with a filter size rather than booking it', async () => {
    const { service } = build();
    await expect(
      create(service, { jobberBooking: booking({ filters: [{ size: 'UPDATE' }] }) }),
    ).rejects.toMatchObject({ status: 422, code: 'JOBBER_BOOKING_INVALID', message: expect.stringContaining('UPDATE') });
  });

  it('creates an inspection without a booking exactly as before', async () => {
    const { service, tx } = build();
    await create(service, { jobberBooking: undefined });
    expect(tx.jobberConnection.findUnique).not.toHaveBeenCalled();
    expect(tx.jobberOutboundTask.create).not.toHaveBeenCalled();
  });
});

describe('what the console is told before booking', () => {
  const previous = { ...process.env };
  afterEach(() => {
    process.env = { ...previous };
  });

  function contextPrisma() {
    return {
      ...ZERO_EVIDENCE,
      propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
      propertywareUnit: {
        findFirst: jest.fn().mockResolvedValue({ id: 'unit-1', addressLine1: '100 Main Street' }),
        count: jest.fn().mockResolvedValue(1),
      },
      jobberConnection: { findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }) },
      jobberPropertyLink: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ jobberPropertyId: 'jobber-property-1', jobberAddress: '100 Main St', propertywareUnitId: null }]),
      },
      propertywareLease: {
        findMany: jest.fn().mockResolvedValue([{ leaseName: 'Sample, Jane', tenantDisplayNames: ['Jane Q Sample'] }]),
      },
      propertywareTenant: {
        findMany: jest.fn().mockResolvedValue([
          {
            leaseName: 'Sample, Jane',
            zone: '3',
            managementPlan: 'Basic',
            hvacPlan: 'Opted out HVAC Plan',
            hvacFilterLocation: 'Hallway',
            hvacFilterSizes: ['20x25x1'],
            tbpEnrollment: 'Yes',
          },
        ]),
      },
      userProfile: { findFirst: jest.fn().mockResolvedValue({ email: 'tech@example.com' }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'jobber-user-1' }]),
    };
  }

  it('says where the visit would go and starts the form from the tenant report and the lease', async () => {
    process.env.JOBBER_BOOKING_ENABLED = 'true';
    const prisma = contextPrisma();
    const service = new AdminService(prisma as never, new PresenceService());

    await expect(
      service.jobberBookingContext(user, {
        propertyId: property.id,
        unitId: '30000000-0000-4000-8000-000000000001',
        technicianId: '40000000-0000-4000-8000-000000000001',
      }),
    ).resolves.toEqual({
      enabled: true,
      connected: true,
      jobberProperty: { status: 'LINKED', address: '100 Main St' },
      address: '100 Main Street',
      prefill: {
        zone: 'Zone 3',
        benefitPackage: true,
        planTier: 'Basic',
        hvacOptedOut: true,
        filters: [{ size: '20x25x1', media: false, location: 'Hallway' }],
        tenants: [{ name: 'Jane Q Sample', phones: [] }],
      },
      technicianInJobber: true,
    });
  });

  it('prefills nothing it cannot pin to this tenancy', async () => {
    const prisma = contextPrisma();
    prisma.propertywareLease.findMany.mockResolvedValue([]);
    prisma.propertywareUnit.count.mockResolvedValue(2);
    prisma.propertywareTenant.findMany.mockResolvedValue([
      { leaseName: 'One', zone: '1', managementPlan: null, hvacPlan: null, hvacFilterLocation: null, hvacFilterSizes: [], tbpEnrollment: 'Yes' },
    ]);
    const service = new AdminService(prisma as never, new PresenceService());

    const context = await service.jobberBookingContext(user, {
      propertyId: property.id,
      unitId: '30000000-0000-4000-8000-000000000001',
    });
    // Two units and one tenancy on the report: which unit it is, nobody said.
    expect(context.prefill).toBeNull();
    expect(context.enabled).toBe(false);
    expect(context.technicianInJobber).toBeNull();
  });
});
