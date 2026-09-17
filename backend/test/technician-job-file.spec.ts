import { InspectionStatus, InspectionType } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * What a technician is told about a job before walking up to the door.
 *
 * Until now the handset had the coordinator's Details and nothing else: the
 * filter sizes the office holds on file, the plan the tenant is on, and
 * whatever the last visit flagged all lived in the console. The office asked
 * for them on the phone (2026-09-18).
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const JOB = {
  id: 'job-1',
  inspectionType: InspectionType.OCCUPIED,
  baselineInspectionId: null,
  baselineInspection: null,
  scheduledAt: new Date('2026-09-18T00:00:00.000Z'),
  scheduledStartAt: new Date('2026-09-18T14:00:00.000Z'),
  scheduledEndAt: null,
  status: InspectionStatus.IN_PROGRESS,
  priority: 'STANDARD',
  internalNotes: 'Dog in the back yard.',
  startedAt: new Date('2026-09-18T14:06:00.000Z'),
  submittedAt: null,
  propertywareLeaseId: 'lease-1',
  jobberVisitTitle: 'Tenant Benefit Package',
  jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
  allowTechnicianAreaCapture: false,
  reopenReason: null,
  propertywareUnit: { id: 'unit-1', name: 'Unit B', bedrooms: 3, bathrooms: 2 },
  propertywareBuilding: {
    id: 'building-1',
    name: '9 Example St',
    addressLine1: '9 Example St',
    city: 'Katy',
    state: 'TX',
    postalCode: '77494',
  },
  areas: [],
};

interface LeaseRow {
  leaseName: string;
  tenantDisplayNames: string[];
  moveInDate: Date | null;
  endDate: Date | null;
  scheduledMoveOutDate: Date | null;
}

interface TenancyRow {
  leaseName: string;
  zone: string | null;
  managementPlan: string | null;
  hvacPlan: string | null;
  hvacFilterLocation: string | null;
  hvacFilterSizes: string[];
  tbpEnrollment: string | null;
  lastFilterDelivery: string | null;
  lastHvacInspection: Date | null;
  lastOccupiedInspection: string | null;
}

interface LastVisitRow {
  scheduledAt: Date;
  inspectionType: InspectionType;
  nextInspectionAlert: string | null;
  maintenanceComments: string | null;
}

const LEASE: LeaseRow = {
  leaseName: 'Alvarez, Rosa',
  tenantDisplayNames: ['Rosa Alvarez', 'Luis Alvarez'],
  moveInDate: new Date('2024-03-01T00:00:00.000Z'),
  endDate: new Date('2027-02-28T00:00:00.000Z'),
  scheduledMoveOutDate: null,
};

const TENANCY: TenancyRow = {
  leaseName: 'Alvarez, Rosa',
  zone: '2',
  managementPlan: 'Basic',
  hvacPlan: 'Opted out',
  hvacFilterLocation: 'Upstairs hallway',
  hvacFilterSizes: ['20x25x1', '12x12x1'],
  tbpEnrollment: 'Enrolled',
  lastFilterDelivery: 'June 2026',
  lastHvacInspection: new Date('2026-03-12T00:00:00.000Z'),
  lastOccupiedInspection: '2026-06-18',
};

const LAST_VISIT: LastVisitRow = {
  scheduledAt: new Date('2026-06-18T00:00:00.000Z'),
  inspectionType: InspectionType.OCCUPIED,
  nextInspectionAlert: 'Check the water heater pan.  ',
  maintenanceComments: '',
};

function build({
  leases = [LEASE],
  tenancies = [TENANCY],
  units = 2,
  lastVisit = LAST_VISIT as LastVisitRow | null,
  job = JOB,
}: {
  leases?: LeaseRow[];
  tenancies?: TenancyRow[];
  units?: number;
  lastVisit?: LastVisitRow | null;
  job?: typeof JOB;
} = {}) {
  const prisma = {
    inspection: {
      // The assigned job first, then the last visit that left a note.
      findFirst: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(lastVisit),
      findMany: jest.fn().mockResolvedValue([job]),
      count: jest.fn().mockResolvedValue(1),
    },
    propertywareLease: { findMany: jest.fn().mockResolvedValue(leases) },
    propertywareTenant: { findMany: jest.fn().mockResolvedValue(tenancies) },
    propertywareUnit: { count: jest.fn().mockResolvedValue(units) },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
  return { service, prisma };
}

describe('the file the office holds on a job', () => {
  it('comes with the job: the filters, the plan and who lives there', async () => {
    const { service } = build();

    const job = await service.inspection(user, 'job-1');

    expect(job.onFile).toEqual({
      tenantNames: ['Rosa Alvarez', 'Luis Alvarez'],
      plan: 'Basic',
      hvacPlan: 'Opted out',
      benefitPackage: 'Enrolled',
      filterSizes: ['20x25x1', '12x12x1'],
      filterLocation: 'Upstairs hallway',
      lastFilterDelivery: 'June 2026',
      lastHvacInspection: '2026-03-12',
      lastOccupiedInspection: '2026-06-18',
      movedIn: '2024-03-01',
      leaseEnds: '2027-02-28',
    });
  });

  it('carries the job clock, so the app can count from Start', async () => {
    const { service } = build();

    const job = await service.inspection(user, 'job-1');

    expect(job.startedAt).toBe('2026-09-18T14:06:00.000Z');
    expect(job.submittedAt).toBeUndefined();
  });

  it('reads a lease date as the day it is, not the evening before in Texas', async () => {
    // A `@db.Date` column is UTC midnight. Sent as an instant, a lease ending on
    // the 28th would show as the 27th on a handset in Texas.
    const { service } = build();

    const job = await service.inspection(user, 'job-1');

    expect(job.onFile?.leaseEnds).toBe('2027-02-28');
    expect(job.onFile?.movedIn).toBe('2024-03-01');
  });

  it('falls back to the scheduled move-out when the lease has no end date', async () => {
    const { service } = build({
      leases: [{ ...LEASE, endDate: null, scheduledMoveOutDate: new Date('2026-11-30T00:00:00.000Z') }],
    });

    const job = await service.inspection(user, 'job-1');

    expect(job.onFile?.leaseEnds).toBe('2026-11-30');
  });

  it('refuses to guess the tenancy when no line on the report names this lease', async () => {
    // The tenant report knows a building, not a unit, so a duplex's two
    // tenancies are told apart by the lease's name alone. Neither matches here,
    // and the filters of the neighbours are worse than no filters at all.
    const { service } = build({
      tenancies: [
        { ...TENANCY, leaseName: 'Someone, Else' },
        { ...TENANCY, leaseName: 'Another, One' },
      ],
    });

    const job = await service.inspection(user, 'job-1');

    // The lease still names who lives there...
    expect(job.onFile?.tenantNames).toEqual(['Rosa Alvarez', 'Luis Alvarez']);
    // ...and nothing from the report is claimed for them.
    expect(job.onFile?.plan).toBeNull();
    expect(job.onFile?.filterSizes).toEqual([]);
    expect(job.onFile?.filterLocation).toBeNull();
  });

  it('sends nothing at all when the office holds no file', async () => {
    const { service } = build({ leases: [], tenancies: [] });

    const job = await service.inspection(user, 'job-1');

    expect(job.onFile).toBeNull();
  });

  it('shows what the last visit flagged, and drops the part nobody wrote', async () => {
    const { service } = build();

    const job = await service.inspection(user, 'job-1');

    expect(job.lastVisit).toEqual({
      scheduledAt: '2026-06-18T00:00:00.000Z',
      type: 'OCCUPIED',
      nextInspectionAlert: 'Check the water heater pan.',
      maintenanceComments: null,
    });
  });

  it('looks for the last visit at this unit, completed, before this one', async () => {
    const { service, prisma } = build();

    await service.inspection(user, 'job-1');

    const where = prisma.inspection.findFirst.mock.calls[1]![0].where;
    expect(where).toMatchObject({
      organizationId: user.organizationId,
      id: { not: 'job-1' },
      status: InspectionStatus.COMPLETED,
      // A note about the upstairs unit is not about this one.
      propertywareUnitId: 'unit-1',
    });
    expect(where.scheduledAt).toEqual({ lte: JOB.scheduledAt });
    expect(where.propertywareBuildingId).toBeUndefined();
  });

  it('falls back to the building for a job booked on the whole property', async () => {
    const { service, prisma } = build({ job: { ...JOB, propertywareUnit: null } as never });

    await service.inspection(user, 'job-1');

    const where = prisma.inspection.findFirst.mock.calls[1]![0].where;
    expect(where.propertywareBuildingId).toBe('building-1');
    expect(where.propertywareUnitId).toBeUndefined();
  });

  it('says nothing when the last visit left the office no note', async () => {
    const { service } = build({ lastVisit: null });

    const job = await service.inspection(user, 'job-1');

    expect(job.lastVisit).toBeNull();
  });

  it('is never read for a list of jobs, which would pay for it once per row', async () => {
    const { service, prisma } = build();

    await service.inspections(user, { page: 1, pageSize: 20 });

    expect(prisma.propertywareTenant.findMany).not.toHaveBeenCalled();
    expect(prisma.propertywareLease.findMany).not.toHaveBeenCalled();
  });
});
