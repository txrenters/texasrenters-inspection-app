import { InspectionSource, InspectionStatus, InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * The job's checklist, answered as the work happens.
 *
 * The office moved it from the end of the visit to the start (2026-09-18), so
 * the answers can no longer wait for the submission: a phone that dies at noon
 * would lose the morning. Each tick is saved, each filter register carries its
 * own photograph, and a job nobody could get into ends here rather than being
 * ticked task by task.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Moses',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

const DETAILS =
  'Filter Change: 20x25x1 (2 pcs) upstairs hallway; 12x12x1 downstairs + Pest Control + Occupied Inspection';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  inspectionType: InspectionType.OCCUPIED,
  baselineInspectionId: null,
  baselineInspection: null,
  scheduledAt: new Date('2026-09-18T00:00:00.000Z'),
  scheduledStartAt: null,
  scheduledEndAt: null,
  status: InspectionStatus.IN_PROGRESS,
  priority: 'STANDARD',
  internalNotes: null,
  startedAt: new Date('2026-09-18T14:06:00.000Z'),
  submittedAt: null,
  propertywareLeaseId: null,
  jobberVisitTitle: 'Tenant Benefit Package',
  jobberVisitDetails: DETAILS,
  // Read by `enqueueJobberCompletion`, which is what tells the office in
  // Jobber. A visit this app booked itself is never pushed there.
  source: InspectionSource.JOBBER,
  jobberVisitId: 'visit-1',
  jobberJobId: 'jobber-job-1',
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
  ...over,
});

function build(record = job()) {
  const prisma: Record<string, never> & {
    inspection: { findFirst: jest.Mock; update: jest.Mock };
    inspectionArea: { count: jest.Mock; upsert: jest.Mock };
    inspectionPhoto: { findMany: jest.Mock };
    propertyArea: { findFirst: jest.Mock; create: jest.Mock };
    property: { upsert: jest.Mock };
    jobberOutboundTask: { create: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  } = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue(record),
      update: jest.fn().mockImplementation(({ data }) => ({ ...record, ...data })),
    },
    inspectionArea: {
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn().mockResolvedValue({ id: 'inspection-area-1' }),
    },
    propertyArea: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'property-area-1' }),
    },
    property: { upsert: jest.fn().mockResolvedValue({ id: 'building-1' }) },
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue([]) },
    jobberOutboundTask: { create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(prisma)),
  } as never;
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, prisma };
}

/** What the update was asked to write. */
const written = (prisma: { inspection: { update: jest.Mock } }) =>
  prisma.inspection.update.mock.calls.at(-1)![0].data as Record<string, never>;

const filter = (over: Record<string, unknown> = {}) => ({
  size: '20x25x1',
  location: 'upstairs hallway',
  slot: 1,
  changed: true,
  photoId: '30000000-0000-4000-8000-000000000001',
  ...over,
});

describe('saving the checklist while the job is walked', () => {
  it('keeps a part-answered checklist, leaving out what nobody has ticked', async () => {
    const { service, prisma } = build();

    await service.saveServicesReport(technician, 'job-1', {
      servicesReport: {
        services: { pestControl: { done: true } },
        filters: [],
        filtersInstalled: [],
      } as never,
    });

    const report = written(prisma).servicesReport as unknown as Record<string, unknown>;
    expect(report).toMatchObject({ services: { pestControl: { done: true, reason: null, reschedule: false } } });
    // Untouched, rather than recorded as not done.
    expect(Object.keys((report as { services: object }).services)).toEqual(['pestControl']);
    expect(written(prisma).servicesReportedAt).toEqual(expect.any(Date));
  });

  it('does not ask for the photographs yet: completeness is decided at submission', async () => {
    const { service } = build();

    // The filter change is ticked done with not one register answered, which
    // the submission refuses and this must not.
    await expect(
      service.saveServicesReport(technician, 'job-1', {
        servicesReport: {
          services: { filterChange: { done: true } },
          filters: [],
          filtersInstalled: [],
        } as never,
      }),
    ).resolves.toBeDefined();
  });

  it('records for each register whether the visit had listed it', async () => {
    const { service, prisma } = build();

    await service.saveServicesReport(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true } },
        filters: [filter(), filter({ size: '16x20x1', location: null, booked: true })],
        filtersInstalled: [],
      } as never,
    });

    const filters = (written(prisma).servicesReport as unknown as { filters: { size: string; booked: boolean }[] })
      .filters;
    // Decided from the visit's Details, never from the flag the phone sent: a
    // register the coordinator listed cannot become "found on site".
    expect(filters).toEqual([
      expect.objectContaining({ size: '20x25x1', slot: 1, booked: true }),
      expect.objectContaining({ size: '16x20x1', booked: false }),
    ]);
  });

  it('takes the last answer for a register, which is a technician correcting a tick', async () => {
    const { service, prisma } = build();

    await service.saveServicesReport(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true } },
        filters: [filter(), filter({ changed: false, reason: 'Painted over', photoId: null })],
        filtersInstalled: [],
      } as never,
    });

    const filters = (written(prisma).servicesReport as unknown as { filters: unknown[] }).filters;
    expect(filters).toEqual([
      expect.objectContaining({ changed: false, reason: 'Painted over', photoId: null }),
    ]);
  });

  it('refuses before the job is started, because there is nothing to answer for yet', async () => {
    const { service } = build(job({ status: InspectionStatus.SCHEDULED, startedAt: null }));

    await expect(
      service.saveServicesReport(technician, 'job-1', {
        servicesReport: { services: {}, filters: [], filtersInstalled: [] } as never,
      }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_IN_PROGRESS' });
  });
});

describe('where a job’s filter photographs are filed', () => {
  it('makes one area for them, outside the floor plan and outside the walk', async () => {
    const { service, prisma } = build();

    await expect(service.filtersArea(technician, 'job-1')).resolves.toEqual({ areaId: 'inspection-area-1' });

    expect(prisma.propertyArea.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'AC filters',
          propertyId: 'building-1',
          unitId: 'unit-1',
          floorId: null,
          source: 'SYSTEM',
          // The checklist asks for these photographs; the completion gate must not.
          isRequired: false,
        }),
      }),
    );
    expect(prisma.inspectionArea.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { inspectionId_propertyAreaId: { inspectionId: 'job-1', propertyAreaId: 'property-area-1' } },
      }),
    );
  });

  it('reuses the area a previous visit to this unit already made', async () => {
    const { service, prisma } = build();
    prisma.propertyArea.findFirst.mockResolvedValue({ id: 'property-area-earlier' });

    await service.filtersArea(technician, 'job-1');

    expect(prisma.propertyArea.create).not.toHaveBeenCalled();
    expect(prisma.inspectionArea.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inspectionId_propertyAreaId: { inspectionId: 'job-1', propertyAreaId: 'property-area-earlier' },
        }),
      }),
    );
  });

  it('refuses before the job is started', async () => {
    const { service } = build(job({ status: InspectionStatus.SCHEDULED }));

    await expect(service.filtersArea(technician, 'job-1')).rejects.toMatchObject({
      code: 'JOB_NOT_IN_PROGRESS',
    });
  });
});

describe('a job nobody let the technician into', () => {
  it('ends the visit, with every booked service marked to be booked again', async () => {
    const { service, prisma } = build();

    await service.couldNotAccess(technician, 'job-1', { reason: 'Tenant would not open the gate' });

    const data = written(prisma);
    expect(data.status).toBe(InspectionStatus.TECHNICIAN_SUBMITTED);
    expect(data.submittedAt).toEqual(expect.any(Date));
    expect(data.completionBlockedReason).toBe('Could not get in: Tenant would not open the gate');
    expect(data.servicesReport).toMatchObject({
      services: {
        filterChange: { done: false, reason: 'Tenant would not open the gate', reschedule: true },
        pestControl: { done: false, reason: 'Tenant would not open the gate', reschedule: true },
      },
      notes: 'Could not get in: Tenant would not open the gate',
    });
  });

  it('tells Jobber, in the same transaction as the submission', async () => {
    const { service, prisma } = build();

    await service.couldNotAccess(technician, 'job-1', { reason: 'Locked gate' });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.create).toHaveBeenCalled();
  });

  it('walks no areas, so it does not ask whether they were finished', async () => {
    const { service, prisma } = build();

    await service.couldNotAccess(technician, 'job-1', { reason: 'Nobody home' });

    // There is nothing to photograph in a house nobody entered.
    expect(prisma.inspectionArea.count).not.toHaveBeenCalled();
  });

  it('stamps the attempt for a job the technician never pressed Start on', async () => {
    const { service, prisma } = build(job({ status: InspectionStatus.SCHEDULED, startedAt: null }));

    await service.couldNotAccess(technician, 'job-1', { reason: 'Aggressive dog in the yard' });

    expect(written(prisma).startedAt).toEqual(expect.any(Date));
  });

  it('keeps the start it already had', async () => {
    const started = new Date('2026-09-18T14:06:00.000Z');
    const { service, prisma } = build(job({ startedAt: started }));

    await service.couldNotAccess(technician, 'job-1', { reason: 'Gate code did not work' });

    expect(written(prisma).startedAt).toBe(started);
  });

  it('refuses for a job already submitted', async () => {
    const { service } = build(job({ status: InspectionStatus.TECHNICIAN_SUBMITTED }));

    await expect(
      service.couldNotAccess(technician, 'job-1', { reason: 'Nobody home' }),
    ).rejects.toBeInstanceOf(ApplicationError);
  });
});

describe('submitting a job whose registers were answered one by one', () => {
  const answered = [
    filter(),
    filter({ slot: 2, photoId: '30000000-0000-4000-8000-000000000002' }),
    filter({ size: '12x12x1', location: 'downstairs', changed: false, reason: 'Painted over', photoId: null }),
  ];

  it('stores each register, and reads the installed sizes from them', async () => {
    const { service, prisma } = build();

    await service.completeInspection(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true }, pestControl: { done: true } },
        filters: answered,
        filtersInstalled: [],
      } as never,
    });

    const report = written(prisma).servicesReport as unknown as {
      filters: unknown[];
      filtersInstalled: string[];
    };
    expect(report.filters).toHaveLength(3);
    // Only the ones actually changed, once each.
    expect(report.filtersInstalled).toEqual(['20x25x1']);
  });

  it('refuses a register marked changed with no photograph', async () => {
    const { service } = build();

    await expect(
      service.completeInspection(technician, 'job-1', {
        servicesReport: {
          services: { filterChange: { done: true }, pestControl: { done: true } },
          filters: [filter({ photoId: null }), answered[1], answered[2]],
          filtersInstalled: [],
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'SERVICES_REPORT_INCOMPLETE' });
  });

  it('refuses when a register the visit listed was never answered', async () => {
    const { service } = build();

    await expect(
      service.completeInspection(technician, 'job-1', {
        servicesReport: {
          services: { filterChange: { done: true }, pestControl: { done: true } },
          filters: [answered[0]!],
          filtersInstalled: [],
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'SERVICES_REPORT_INCOMPLETE' });
  });

  it('still takes the old shape from a phone that has not been updated', async () => {
    const { service, prisma } = build();

    await service.completeInspection(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true }, pestControl: { done: true } },
        filtersInstalled: ['20x25x1', '12x12x1'],
      } as never,
    });

    const report = written(prisma).servicesReport as unknown as {
      filters?: unknown[];
      filtersInstalled: string[];
    };
    expect(report.filters).toBeUndefined();
    expect(report.filtersInstalled).toEqual(['20x25x1', '12x12x1']);
  });
});

/**
 * A photograph taken in a basement travels in the upload queue like every
 * other one here, so the register is answered with the key the handset gave it
 * and the server points at the image once it arrives.
 */
describe('the photograph a register was answered with', () => {
  const withKey = { ...filter(), photoId: null, photoKey: 'snapshot-1758200000-ab12c' };

  it('is pointed at as soon as its upload has landed', async () => {
    const { service, prisma } = build();
    prisma.inspectionPhoto.findMany.mockResolvedValue([
      { id: '40000000-0000-4000-8000-000000000007', idempotencyKey: 'snapshot-1758200000-ab12c' },
    ]);

    await service.saveServicesReport(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true } },
        filters: [withKey],
        filtersInstalled: [],
      } as never,
    });

    expect(prisma.inspectionPhoto.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          inspectionId: 'job-1',
          idempotencyKey: { in: ['snapshot-1758200000-ab12c'] },
        }),
      }),
    );
    const filters = (written(prisma).servicesReport as unknown as { filters: unknown[] }).filters;
    expect(filters).toEqual([
      expect.objectContaining({
        photoId: '40000000-0000-4000-8000-000000000007',
        // Kept, so a later save does not go looking for it again in vain.
        photoKey: 'snapshot-1758200000-ab12c',
      }),
    ]);
  });

  it('is accepted at submission while the image is still on the device', async () => {
    const { service, prisma } = build();

    await service.completeInspection(technician, 'job-1', {
      servicesReport: {
        services: { filterChange: { done: true }, pestControl: { done: true } },
        filters: [
          withKey,
          { ...filter(), slot: 2, photoId: null, photoKey: 'snapshot-1758200001-cd34e' },
          {
            ...filter(),
            size: '12x12x1',
            location: 'downstairs',
            changed: false,
            reason: 'Painted over',
            photoId: null,
          },
        ],
        filtersInstalled: [],
      } as never,
    });

    // Submitted rather than refused: the answer is the technician's, and the
    // image follows from the queue.
    expect(written(prisma).status).toBe(InspectionStatus.TECHNICIAN_SUBMITTED);
  });
});
