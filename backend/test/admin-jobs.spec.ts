import { ValidationPipe } from '@nestjs/common';
import { UserRole, parseVisitDetails, type AddJobWorkInput, type CreateJobInput, type JobberBookingInput } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { CreateAdminJobDto } from '../src/admin/admin.dto';
import { AdminService } from '../src/admin/admin.service';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * A job: one booking, one number, every inspection ticked in it (2026-11-20,
 * phase 1 of the jobs plan). People, addresses, numbers and ids invented.
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

const TECHNICIAN = '30000000-0000-4000-8000-000000000009';

const booking = (overrides: Partial<JobberBookingInput> = {}): JobberBookingInput => ({
  zone: 'Zone 3',
  benefitPackage: false,
  services: { filterChange: true, pestControl: true, fleaTreatment: false },
  filters: [{ size: '20x25x1', quantity: 2 }],
  planTier: null,
  hvacOptedOut: false,
  contactTenantsBeforeArrival: false,
  tenants: [{ name: 'Jane Q Sample', phones: ['(832) 555-0101'] }],
  accessNotes: [],
  notes: [],
  ...overrides,
});

const idOf = (type: string) => `${type.toLowerCase()}-1`;

function build({ series = [1, 2, 3], typedNumbers = [] as string[], replay = null as null | { id: string; propertywareBuildingId: string } } = {}) {
  const taken = [...series];
  const writtenText = new Map<string, { jobberVisitTitle: string | null; jobberVisitDetails: string | null }>();
  const tx = {
    propertywareBuilding: { findFirst: jest.fn().mockResolvedValue(property) },
    propertywareUnit: { findFirst: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    propertywareLease: { findFirst: jest.fn() },
    property: { upsert: jest.fn().mockResolvedValue({}) },
    propertyArea: {
      findMany: jest.fn().mockResolvedValue([{ id: 'area-1' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'hvac-area-1' }),
      create: jest.fn().mockResolvedValue({ id: 'hvac-area-2' }),
    },
    areaChecklistItem: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }: { data: { inspectionType: string } }) => Promise.resolve({ id: idOf(data.inspectionType) })),
      update: jest.fn(({ where, data }: { where: { id: string }; data: { jobberVisitTitle: string; jobberVisitDetails: string } }) => {
        writtenText.set(where.id, data);
        return Promise.resolve({});
      }),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(writtenText.get(where.id))),
    },
    job: {
      findUnique: jest.fn(({ where }: { where: { organizationId_number: { number: string } } }) =>
        Promise.resolve(
          typedNumbers.includes(where.organizationId_number.number)
            ? { id: 'job-typed', title: 'Move-out' }
            : null,
        ),
      ),
      create: jest.fn(({ data }: { data: { number: string; title: string } }) =>
        Promise.resolve({ id: 'job-1', number: data.number, title: data.title }),
      ),
    },
    userProfile: { findFirst: jest.fn().mockResolvedValue({ id: TECHNICIAN }) },
    inspectionAssignment: { create: jest.fn().mockResolvedValue({ id: 'assignment-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    jobberConnection: { findUnique: jest.fn().mockResolvedValue({ status: 'CONNECTED' }) },
    jobberPropertyLink: { findMany: jest.fn() },
    jobberOutboundTask: { create: jest.fn().mockResolvedValue({ id: 'task-1' }) },
    // The series' next number, and the Jobber links read raw for a booking.
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('DocumentSeries')
          ? [{ taken: taken.shift() }]
          : [{ jobberPropertyId: 'jobber-property-1', jobberAddress: '100 Main Street', propertywareUnitId: null, lastUsedAt: null }],
      ),
    ),
  };
  const prisma = {
    job: {
      findUnique: jest.fn().mockResolvedValue(replay),
      // What the email is written from.
      findFirst: jest.fn().mockResolvedValue({
        number: 'J-00001',
        title: 'Occupied + HVAC, filters and pest control',
        propertywareBuilding: { name: 'Sample House', addressLine1: '100 Main Street' },
        propertywareUnit: null,
        inspections: [{ scheduledAt: new Date('2026-11-23') }],
      }),
      findMany: jest.fn().mockResolvedValue(typedNumbers.map((number) => ({ number }))),
    },
    documentSeries: { findUnique: jest.fn().mockResolvedValue(series.length ? { next: series[0] } : null) },
    userProfile: {
      findUnique: jest.fn().mockResolvedValue({ email: 'tech@example.com', displayName: 'D. Sample', isActive: true }),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const events = { publish: jest.fn() };
  const mailer = { sendJobAssignment: jest.fn().mockResolvedValue(undefined), sendInspectionAssignment: jest.fn() };
  const service = new AdminService(
    prisma as never,
    new PresenceService(),
    events as never,
    undefined,
    undefined,
    undefined,
    mailer as never,
  );
  // The job read is tested on its own below; here it only has to answer.
  jest.spyOn(service, 'job').mockImplementation(async (_user, id) => ({ id }) as never);
  return { service, tx, prisma, events, mailer };
}

const create = (service: AdminService, overrides: Partial<CreateJobInput> = {}) =>
  service.createJob(user, {
    propertyId: property.id,
    scheduledAt: '2026-11-23T00:00:00.000Z',
    inspectionTypes: ['OCCUPIED', 'HVAC'],
    visitServices: {
      services: { filterChange: true, pestControl: true, fleaTreatment: false },
      filters: [{ size: '20x25x1', quantity: 1 }, { size: '16x25x1', quantity: 1 }],
    },
    requestKey: 'job-request-0001',
    ...overrides,
  } as never);

const created = (tx: ReturnType<typeof build>['tx']) =>
  tx.inspection.create.mock.calls.map(([{ data }]) => data as Record<string, unknown>);

describe('making a job', () => {
  const previous = { ...process.env };
  beforeEach(() => {
    process.env.JOBBER_BOOKING_ENABLED = 'true';
    process.env.WEB_APP_ORIGIN = 'https://console.example.com/';
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('makes the job and one inspection per tick in one transaction, the lead first, each in the job', async () => {
    const { service, tx, prisma } = build();
    await create(service);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.job.create).toHaveBeenCalledWith({
      data: {
        organizationId: user.organizationId,
        number: 'J-00001',
        title: 'Occupied + HVAC, filters and pest control',
        propertywareBuildingId: property.id,
        propertywareUnitId: null,
        requestKey: 'job-request-0001',
        createdById: user.id,
      },
      select: { id: true, number: true, title: true },
    });
    // HVAC leads: the AC filters are scored on its filter change.
    expect(created(tx).map((row) => row.inspectionType)).toEqual(['HVAC', 'OCCUPIED']);
    expect(created(tx).every((row) => row.jobId === 'job-1')).toBe(true);
    expect(created(tx).every((row) => String(row.scheduledAt) === String(new Date('2026-11-23')))).toBe(true);
  });

  it('puts the services on the lead only, as the line the phone lists them from', async () => {
    const { service, tx } = build();
    await create(service);

    const [hvac, occupied] = created(tx);
    expect(parseVisitDetails(hvac!.jobberVisitDetails as string).services).toMatchObject({
      filterChange: true,
      pestControl: true,
      fleaTreatment: false,
    });
    expect(occupied!.jobberVisitDetails).toBeUndefined();
  });

  it('alerts the technician once for the whole job: one push, one email, every inspection assigned', async () => {
    const { service, tx, events, mailer } = build();
    await create(service, { technicianId: TECHNICIAN });
    // The email goes after the commit, without holding up the response.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(2);
    expect(events.publish.mock.calls).toEqual([
      [TECHNICIAN, 'hvac-1', 'ASSIGNED', undefined, { push: true }],
      [TECHNICIAN, 'occupied-1', 'ASSIGNED', undefined, { push: false }],
    ]);
    expect(mailer.sendInspectionAssignment).not.toHaveBeenCalled();
    expect(mailer.sendJobAssignment).toHaveBeenCalledTimes(1);
    expect(mailer.sendJobAssignment.mock.calls[0][0]).toMatchObject({
      to: 'tech@example.com',
      jobNumber: 'J-00001',
      work: ['HVAC inspection', 'Occupied inspection', 'AC filter change', 'Pest control'],
    });
  });

  it('books one Jobber visit, on the lead, and the rest follow it as companions', async () => {
    const { service, tx } = build();
    await create(service, { visitServices: undefined, jobberBooking: booking() });

    expect(tx.jobberOutboundTask.create).toHaveBeenCalledTimes(1);
    expect(tx.jobberOutboundTask.create.mock.calls[0][0].data).toMatchObject({
      inspectionId: 'hvac-1',
      kind: 'VISIT_CREATE',
    });
    const occupied = created(tx)[1]!;
    const lead = tx.inspection.update.mock.calls[0][0];
    expect(lead.where).toEqual({ id: 'hvac-1' });
    expect(occupied.jobberCompanionOfId).toBe('hvac-1');
    expect(occupied.jobberVisitTitle).toBe(lead.data.jobberVisitTitle);
    expect(occupied.jobberVisitTitle).toBe('100 Main Street - Zone 3 - HVAC Inspection');
    // The companion's Details are the lead's without the services: those are answered once.
    expect(parseVisitDetails(occupied.jobberVisitDetails as string).services).toMatchObject({
      filterChange: false,
      pestControl: false,
    });
  });

  it('keeps a number the office typed, the way it is kept', async () => {
    const { service, tx } = build();
    await create(service, { number: '  wo 48213 ', title: '  Leak   and filters ' });

    expect(tx.job.create.mock.calls[0][0].data).toMatchObject({ number: 'WO 48213', title: 'Leak and filters' });
    // The series is not spent on it.
    expect(tx.$queryRaw.mock.calls.some(([strings]) => strings.join('').includes('DocumentSeries'))).toBe(false);
  });

  it('refuses a typed number another job has, naming that job, and writes nothing', async () => {
    const { service, tx } = build({ typedNumbers: ['J-00007'] });

    await expect(create(service, { number: 'j-00007' })).rejects.toMatchObject({
      status: 409,
      code: 'JOB_NUMBER_TAKEN',
      details: [{ jobId: 'job-typed' }],
    });
    expect(tx.job.create).not.toHaveBeenCalled();
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });

  it('steps the series past a number somebody typed by hand', async () => {
    const { service, tx } = build({ series: [1, 2], typedNumbers: ['J-00001'] });
    await create(service);

    expect(tx.job.create.mock.calls[0][0].data.number).toBe('J-00002');
  });

  it('refuses a number that cannot be one', async () => {
    const { service, prisma } = build();
    await expect(create(service, { number: '#42!' })).rejects.toMatchObject({ code: 'JOB_NUMBER_INVALID' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the job a retried press already made, and makes nothing', async () => {
    const { service, prisma } = build({ replay: { id: 'job-earlier', propertywareBuildingId: property.id } });
    await expect(create(service)).resolves.toEqual({ id: 'job-earlier' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a request key already used for another property', async () => {
    const { service } = build({ replay: { id: 'job-earlier', propertywareBuildingId: 'another-building' } });
    await expect(create(service)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses services on a job whose lead cannot carry them, before writing', async () => {
    const { service, prisma } = build();
    await expect(create(service, { inspectionTypes: ['ROOF'] })).rejects.toMatchObject({
      code: 'VISIT_SERVICES_TYPE_UNSUPPORTED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a job with no inspection: services alone wait for the phone update', async () => {
    const { service } = build();
    await expect(create(service, { inspectionTypes: [] })).rejects.toMatchObject({ code: 'JOB_NEEDS_AN_INSPECTION' });
  });

  it('audits the job with its number and services by name, never the Details', async () => {
    const { service, tx } = build();
    await create(service);

    const audit = tx.auditLog.create.mock.calls.map(([{ data }]) => data).find((data) => data.action === 'JOB_CREATED');
    expect(audit).toMatchObject({
      entityType: 'Job',
      entityId: 'job-1',
      metadata: {
        number: 'J-00001',
        numberTyped: false,
        inspectionTypes: ['HVAC', 'OCCUPIED'],
        leadInspectionId: 'hvac-1',
        services: ['filterChange', 'pestControl'],
        bookedInJobber: false,
      },
    });
    expect(JSON.stringify(audit)).not.toContain('20x25x1');
  });
});

describe('the next job number', () => {
  it('is the series', async () => {
    const { service } = build({ series: [12] });
    await expect(service.nextJobNumber(user)).resolves.toEqual({ number: 'J-00012' });
  });

  it('starts at one', async () => {
    const { service } = build({ series: [] });
    await expect(service.nextJobNumber(user)).resolves.toEqual({ number: 'J-00001' });
  });

  it('passes over numbers typed by hand', async () => {
    const { service } = build({ series: [12], typedNumbers: ['J-00012', 'J-00013'] });
    await expect(service.nextJobNumber(user)).resolves.toEqual({ number: 'J-00014' });
  });
});

describe('reading a job', () => {
  it('lists the lead first, then the office order, and the day from the lead', async () => {
    const prisma = {
      job: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          number: 'J-00001',
          title: 'Move-out + HVAC',
          source: 'CONSOLE',
          createdAt: new Date('2026-11-20T15:00:00Z'),
          propertywareBuilding: { id: property.id, name: 'Sample House', addressLine1: '100 Main Street' },
          propertywareUnit: null,
          inspections: [
            { id: 'move-out-1', inspectionType: 'MOVE_OUT', status: 'SCHEDULED', scheduledAt: new Date('2026-11-23'), assignments: [] },
            {
              id: 'hvac-1',
              inspectionType: 'HVAC',
              status: 'SCHEDULED',
              scheduledAt: new Date('2026-11-23'),
              assignments: [{ technician: { id: TECHNICIAN, displayName: 'D. Sample' } }],
            },
          ],
        }),
      },
    };
    const service = new AdminService(prisma as never, new PresenceService());
    const job = await service.job(user, 'job-1');

    expect(job.scheduledAt).toBe('2026-11-23');
    expect(job.inspections.map((inspection) => [inspection.id, inspection.lead])).toEqual([
      ['hvac-1', true],
      ['move-out-1', false],
    ]);
    expect(prisma.job.findFirst.mock.calls[0][0].where).toEqual({ id: 'job-1', organizationId: user.organizationId });
  });

  it("is not found in another office's", async () => {
    const service = new AdminService({ job: { findFirst: jest.fn().mockResolvedValue(null) } } as never, new PresenceService());
    await expect(service.job(user, 'job-1')).rejects.toMatchObject({ status: 404, code: 'JOB_NOT_FOUND' });
  });
});

describe('the job request as the API takes it', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreateAdminJobDto });

  // Every field of the contract, so a field the DTO forgets fails here.
  const everything: Required<CreateJobInput> = {
    propertyId: property.id,
    unitId: '20000000-0000-4000-8000-000000000002',
    leaseId: '20000000-0000-4000-8000-000000000003',
    scheduledAt: '2026-11-23',
    technicianId: TECHNICIAN,
    title: 'Occupied + HVAC',
    number: 'J-00042',
    inspectionTypes: ['OCCUPIED', 'HVAC'],
    visitServices: { services: { filterChange: true, pestControl: false, fleaTreatment: false }, filters: [{ size: '20x25x1' }] },
    jobberBooking: booking(),
    priority: 'HIGH',
    internalNotes: 'Dog in the back yard.',
    allowTechnicianAreaCapture: false,
    requestKey: 'job-request-0001',
  };

  it('takes every field the contract names', async () => {
    await expect(validate(everything)).resolves.toBeInstanceOf(CreateAdminJobDto);
  });

  it('refuses a job with nothing ticked, saying why', async () => {
    await expect(validate({ ...everything, inspectionTypes: [] })).rejects.toMatchObject({
      response: { message: expect.arrayContaining([expect.stringContaining('Tick at least one inspection')]) },
    });
  });

  it('refuses a kind ticked twice, and a kind a job cannot hold', async () => {
    await expect(validate({ ...everything, inspectionTypes: ['HVAC', 'HVAC'] })).rejects.toBeDefined();
    await expect(validate({ ...everything, inspectionTypes: ['MAINTENANCE'] })).rejects.toBeDefined();
  });

  it('needs a request key', async () => {
    const rest: Partial<CreateJobInput> = { ...everything };
    delete rest.requestKey;
    await expect(validate(rest)).rejects.toBeDefined();
  });
});

describe('adding work to a job (the job page, 2026-11-20)', () => {
  const lead = {
    id: 'occupied-lead',
    inspectionType: 'OCCUPIED',
    status: 'SCHEDULED',
    scheduledAt: new Date('2026-11-23'),
    scheduledStartAt: null,
    scheduledEndAt: null,
    propertywareUnitId: null,
    propertywareLeaseId: null,
    priority: 'STANDARD',
    internalNotes: 'Dog in the yard.',
    jobberVisitId: 'visit-1',
    jobberVisitTitle: '100 Main Street - Zone 3 - Occupied Inspection',
    jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\nGate Code: 4321',
    assignments: [{ technicianId: TECHNICIAN }],
  };
  const jobWith = (inspections: unknown[]) => ({ id: 'job-1', number: 'J-00042', propertywareBuildingId: property.id, inspections });

  it("makes each one on the lead's day for its technician, following the job's Jobber visit, and alerts once", async () => {
    const { service, tx, prisma, events } = build();
    prisma.job.findFirst.mockResolvedValueOnce(jobWith([lead]));
    await service.addJobWork(user, 'job-1', { inspectionTypes: ['HVAC', 'MOVE_OUT'] } as never);

    const rows = created(tx);
    expect(rows.map((row) => row.inspectionType)).toEqual(['MOVE_OUT', 'HVAC']);
    for (const row of rows) {
      expect(row).toMatchObject({ jobId: 'job-1', jobberCompanionOfId: 'occupied-lead', jobberVisitTitle: lead.jobberVisitTitle });
      expect(String(row.scheduledAt)).toBe(String(lead.scheduledAt));
      // The services stay on the lead: answered once.
      expect(String(row.jobberVisitDetails)).not.toContain('Pest Control');
    }
    expect(tx.inspectionAssignment.create).toHaveBeenCalledTimes(2);
    expect(events.publish.mock.calls.map((call) => call[4])).toEqual([{ push: true }, { push: false }]);
    const audit = tx.auditLog.create.mock.calls.map(([{ data }]) => data).find((data) => data.action === 'JOB_WORK_ADDED');
    expect(audit).toMatchObject({ entityType: 'Job', entityId: 'job-1', metadata: { inspectionTypes: ['MOVE_OUT', 'HVAC'] } });
  });

  it('refuses a kind the job already has, and writes nothing', async () => {
    const { service, prisma } = build();
    prisma.job.findFirst.mockResolvedValueOnce(jobWith([lead]));
    await expect(service.addJobWork(user, 'job-1', { inspectionTypes: ['OCCUPIED'] } as never)).rejects.toMatchObject({
      status: 409,
      code: 'JOB_KIND_ALREADY_IN',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a job whose visit is done: more work is a new job', async () => {
    const { service, prisma } = build();
    prisma.job.findFirst.mockResolvedValueOnce(jobWith([{ ...lead, status: 'TECHNICIAN_SUBMITTED' }]));
    await expect(service.addJobWork(user, 'job-1', { inspectionTypes: ['HVAC'] } as never)).rejects.toMatchObject({
      code: 'JOB_NOT_UPCOMING',
    });
  });

  it("is not found in another office's", async () => {
    const { service, prisma } = build();
    prisma.job.findFirst.mockResolvedValueOnce(null);
    await expect(service.addJobWork(user, 'job-1', { inspectionTypes: ['HVAC'] } as never)).rejects.toMatchObject({ status: 404 });
    expect(prisma.job.findFirst.mock.calls.at(-1)[0].where).toEqual({ id: 'job-1', organizationId: user.organizationId });
  });
});

describe('taking work off a job (the job page, 2026-11-20)', () => {
  const inspections = [
    { id: 'occupied-lead', inspectionType: 'OCCUPIED', status: 'SCHEDULED', startedAt: null, jobberVisitId: 'visit-1', jobberVisitDetails: null },
    { id: 'hvac-1', inspectionType: 'HVAC', status: 'SCHEDULED', startedAt: null, jobberVisitId: null, jobberVisitDetails: null },
  ];
  const setUp = (rows = inspections) => {
    const built = build();
    built.prisma.job.findFirst.mockResolvedValueOnce({ id: 'job-1', number: 'J-00042', inspections: rows });
    (built.prisma as unknown as { auditLog: unknown }).auditLog = { create: jest.fn().mockResolvedValue({}) };
    const update = jest.spyOn(built.service, 'updateInspection').mockResolvedValue({} as never);
    return { ...built, update };
  };

  it('cancels it, naming the job, and audits the job', async () => {
    const { service, update, prisma } = setUp();
    await service.takeOffJobWork(user, 'job-1', 'hvac-1');

    expect(update).toHaveBeenCalledWith(user, 'hvac-1', { status: 'CANCELLED', cancellationReason: 'Taken off job J-00042' });
    const audit = (prisma as unknown as { auditLog: { create: jest.Mock } }).auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: 'JOB_WORK_TAKEN_OFF', entityType: 'Job', entityId: 'job-1' });
  });

  it('keeps the lead while others remain, started work, and the last work on the job', async () => {
    const lead = setUp();
    await expect(lead.service.takeOffJobWork(user, 'job-1', 'occupied-lead')).rejects.toMatchObject({ code: 'JOB_WORK_CANNOT_COME_OFF' });

    const started = setUp([inspections[0]!, { ...inspections[1]!, status: 'IN_PROGRESS' }]);
    await expect(started.service.takeOffJobWork(user, 'job-1', 'hvac-1')).rejects.toMatchObject({
      message: expect.stringContaining('started'),
    });

    const last = setUp([{ ...inspections[0]!, status: 'CANCELLED' }, inspections[1]!]);
    await expect(last.service.takeOffJobWork(user, 'job-1', 'hvac-1')).rejects.toMatchObject({
      message: expect.stringContaining('last work'),
    });
    for (const attempt of [lead, started, last]) expect(attempt.update).not.toHaveBeenCalled();
  });

  it('refuses an inspection that is not in the job', async () => {
    const { service } = setUp();
    await expect(service.takeOffJobWork(user, 'job-1', 'elsewhere')).rejects.toMatchObject({ status: 404, code: 'JOB_WORK_NOT_FOUND' });
  });
});

describe('the add-work request as the API takes it', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  it('takes the kinds to add, and refuses none or a kind a job cannot hold', async () => {
    const { AddJobWorkDto } = await import('../src/admin/admin.dto');
    const body: Required<AddJobWorkInput> = { inspectionTypes: ['HVAC'] };
    await expect(pipe.transform(body, { type: 'body', metatype: AddJobWorkDto })).resolves.toBeInstanceOf(AddJobWorkDto);
    await expect(pipe.transform({ inspectionTypes: [] }, { type: 'body', metatype: AddJobWorkDto })).rejects.toBeDefined();
    await expect(pipe.transform({ inspectionTypes: ['MAINTENANCE'] }, { type: 'body', metatype: AddJobWorkDto })).rejects.toBeDefined();
  });
});
