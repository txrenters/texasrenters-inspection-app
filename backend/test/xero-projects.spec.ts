import type { XeroSettingsValues } from '@texasrenters/shared';

import { XeroError } from '../src/integrations/xero/xero.errors';
import { LABOUR_TASK_NAME, MAX_PROJECTS_PER_RUN, XeroProjectsService, packageQuarterOf } from '../src/integrations/xero/xero-projects.service';

/**
 * A Xero project for each visit (2026-11-11), as the office keeps one in a
 * company's books: under the property's contact, named after the technician,
 * the package's quarter or what the visit was, and its day, with the labour
 * logged as time. Everything invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const TENANT = 'tenant-1';
const SEND_FROM = '2026-11-01';
const VALUES: XeroSettingsValues = {
  sendFrom: SEND_FROM,
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  salesAccounts: {},
  paymentAccounts: {},
  paymentsToXero: false,
  projectsEnabled: true,
  projectUserId: 'user-1',
  labourRateCents: 3500,
  labourMinutes: 6,
};
const NAME = 'Ada: Tenant Benefit Package - 4th Qtr - 2026 - 11.10.2026';

type Visit = {
  id: string;
  scheduledAt: Date;
  jobberVisitTitle: string | null;
  tbpPlanStop: { plan: { quarterYear: number; quarterNumber: number } } | null;
  assignments: { technician: { displayName: string } }[];
};
type Candidate = { id: string; clientName: string; jobberClientId: string | null; lines: { name: string }[]; inspection: Visit | null };

const visitInvoice = (over: Partial<Candidate> = {}, visit: Partial<Visit> = {}): Candidate => ({
  id: 'inv-1',
  clientName: '12 Example Lane',
  jobberClientId: 'client-1',
  lines: [{ name: 'HVAC Inspection & Filter Change' }],
  inspection: {
    id: 'visit-1',
    scheduledAt: new Date('2026-11-10T00:00:00.000Z'),
    jobberVisitTitle: '12 Example Lane - Zone 4 - Q4 2026 Tenant Benefit Package',
    tbpPlanStop: null,
    assignments: [{ technician: { displayName: 'Ada Lane' } }],
    ...visit,
  },
  ...over,
});

type Row = Record<string, unknown> & { inspectionId: string };

function harness(
  options: {
    invoices?: Candidate[];
    links?: Row[];
    contacts?: { clientKey: string; xeroContactId: string }[];
    projectsInXero?: { projectId: string; name: string }[];
    tasksInXero?: { taskId: string; name: string }[];
    timesInXero?: { timeEntryId: string }[];
  } = {},
) {
  const links = new Map<string, Row>((options.links ?? []).map((link) => [link.inspectionId, { ...link }]));
  const prisma = {
    invoice: { findMany: jest.fn<Promise<Candidate[]>, [unknown]>(async () => options.invoices ?? [visitInvoice()]) },
    xeroProjectLink: {
      findMany: jest.fn(async ({ where }: { where: { inspectionId: { in: string[] } } }) => [...links.values()].filter((link) => where.inspectionId.in.includes(link.inspectionId))),
      upsert: jest.fn(async ({ where, create, update }: { where: { organizationId_xeroTenantId_inspectionId: { inspectionId: string } }; create: Row; update: Row }) => {
        const id = where.organizationId_xeroTenantId_inspectionId.inspectionId;
        const row = links.has(id) ? { ...links.get(id)!, ...update } : create;
        links.set(id, row);
        return row;
      }),
      count: jest.fn(async ({ where }: { where: { status: string } }) => [...links.values()].filter((link) => link.status === where.status).length),
      updateMany: jest.fn(async () => ({ count: 3 })),
    },
    xeroContactLink: { findMany: jest.fn(async () => options.contacts ?? [{ clientKey: 'jobber:client-1', xeroContactId: 'contact-1' }]) },
  };
  const client = {
    projectsGet: jest.fn(async (_org: string, _tenant: string, path: string): Promise<unknown> => {
      if (path.startsWith('/Projects?')) return { items: options.projectsInXero ?? [] };
      if (path.includes('/Tasks')) return { items: options.tasksInXero ?? [] };
      if (path.includes('/Time')) return { items: options.timesInXero ?? [] };
      return {};
    }),
    projectsPost: jest.fn<Promise<unknown>, [string, string, string, unknown, unknown, string]>(async (...args) => {
      const path = args[2];
      if (path === '/Projects') return { projectId: 'project-1', name: NAME };
      if (path.endsWith('/Tasks')) return { taskId: 'task-1', name: LABOUR_TASK_NAME };
      return { timeEntryId: 'time-1' };
    }),
  };
  const service = new XeroProjectsService(prisma as never, client as never);
  const posts = (suffix: string) => client.projectsPost.mock.calls.filter(([, , path]) => path.endsWith(suffix));
  return { service, prisma, client, links, posts };
}

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date('2026-11-11T18:00:00.000Z'),
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'queueMicrotask'],
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the quarter a visit’s project names', () => {
  const day = new Date('2026-09-25T00:00:00.000Z');
  it('is its plan’s, which starts a quarter up to fifteen days early', () => {
    expect(packageQuarterOf({ scheduledAt: day, jobberVisitTitle: null, tbpPlanStop: { plan: { quarterYear: 2026, quarterNumber: 4 } } })).toEqual({ year: 2026, quarter: 4 });
  });
  it('is the one a package title names, for a visit the office booked in Jobber itself', () => {
    expect(packageQuarterOf({ scheduledAt: day, jobberVisitTitle: 'Zone 2 - Q4 2026 Tenant Benefit Package', tbpPlanStop: null })).toEqual({ year: 2026, quarter: 4 });
  });
  it('is its day’s for a package title naming none, and none for any other visit', () => {
    expect(packageQuarterOf({ scheduledAt: day, jobberVisitTitle: 'Tenant Benefit Package', tbpPlanStop: null })).toEqual({ year: 2026, quarter: 3 });
    expect(packageQuarterOf({ scheduledAt: day, jobberVisitTitle: 'Move Out Inspection - Q3 2026', tbpPlanStop: null })).toBeNull();
  });
});

describe('a visit’s project', () => {
  it('is made under the property’s contact, named as the office names them and due on the visit’s day, with its labour as time', async () => {
    const { service, client, posts, links } = harness();
    const result = await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect(result).toEqual({ made: 1, linked: 0, failed: 0, names: [NAME] });
    // Looked for first, under the contact: the office may have made it by hand.
    expect(client.projectsGet.mock.calls[0]![2]).toBe('/Projects?contactID=contact-1&pageSize=500');
    expect(posts('/Projects')[0]![3]).toEqual({ contactId: 'contact-1', name: NAME, deadlineUtc: '2026-11-10T12:00:00Z' });
    expect(posts('/Tasks')[0]![2]).toBe('/Projects/project-1/Tasks');
    expect(posts('/Tasks')[0]![3]).toEqual({ name: 'Hourly Labor Charge', rate: { currency: 'USD', value: 35 }, chargeType: 'TIME' });
    expect(posts('/Time')[0]![3]).toEqual({ userId: 'user-1', taskId: 'task-1', dateUtc: '2026-11-10T12:00:00Z', duration: 6, description: 'Visit on 2026-11-10' });
    // Each write with an idempotency key, so a retry after a timeout makes nothing twice.
    for (const call of client.projectsPost.mock.calls) expect(call[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(links.get('visit-1')).toMatchObject({
      status: 'DONE',
      name: NAME,
      xeroProjectId: 'project-1',
      madeHere: true,
      xeroTaskId: 'task-1',
      xeroTimeEntryId: 'time-1',
      problem: null,
      nextAttemptAt: null,
    });
  });

  it('is the one the office made by hand under the same name -- linked, and given no labour', async () => {
    const { service, client, links } = harness({ projectsInXero: [{ projectId: 'by-hand', name: '  ada:  tenant benefit package - 4th qtr - 2026 - 11.10.2026 ' }] });
    expect(await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD')).toEqual({ made: 0, linked: 1, failed: 0, names: [NAME] });
    expect(client.projectsPost).not.toHaveBeenCalled();
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroProjectId: 'by-hand', madeHere: false, xeroTaskId: null });
  });

  it('names any other visit by what it was', async () => {
    const { service, posts } = harness({ invoices: [visitInvoice({ lines: [{ name: 'Move Out Inspection' }] }, { jobberVisitTitle: '12 Example Lane - Move Out' })] });
    await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect((posts('/Projects')[0]![3] as { name: string }).name).toBe('Ada: Move Out Inspection - 11.10.2026');
  });

  it('is one for a visit, however many of its invoices there are', async () => {
    const { service, posts } = harness({ invoices: [visitInvoice(), visitInvoice({ id: 'inv-2' })] });
    await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect(posts('/Projects')).toHaveLength(1);
  });

  it('logs no labour when its minutes or rate is 0', async () => {
    const { service, posts } = harness();
    await service.run(ORG, TENANT, SEND_FROM, { ...VALUES, labourMinutes: 0 }, 'USD');
    expect(posts('/Projects')).toHaveLength(1);
    expect(posts('/Tasks')).toHaveLength(0);
    expect(posts('/Time')).toHaveLength(0);
  });

  it('carries on where a refusal stopped it, looking for what the last try made before making more', async () => {
    const { service, client, posts, links } = harness({
      links: [{ inspectionId: 'visit-1', name: NAME, status: 'FAILED', attempts: 1, xeroProjectId: 'project-1', madeHere: true, xeroTaskId: null, xeroTimeEntryId: null }],
      tasksInXero: [{ taskId: 'task-made-before', name: 'Hourly Labor Charge' }],
    });
    await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    // No second project, and the task the last try made is the one the time goes on.
    expect(client.projectsGet.mock.calls.map((call) => call[2])).toEqual(['/Projects/project-1/Tasks?pageSize=500', '/Projects/project-1/Time?taskId=task-made-before']);
    expect(posts('/Projects')).toHaveLength(0);
    expect(posts('/Tasks')).toHaveLength(0);
    expect(posts('/Time')[0]![3]).toMatchObject({ taskId: 'task-made-before' });
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroTaskId: 'task-made-before', xeroTimeEntryId: 'time-1' });
  });

  it('keeps what was made when Xero refuses a step, says why, and tries again in an hour -- then goes on to the next visit', async () => {
    const { service, client, links } = harness({
      invoices: [visitInvoice(), visitInvoice({ id: 'inv-2', jobberClientId: 'client-2' }, { id: 'visit-2' })],
      contacts: [
        { clientKey: 'jobber:client-1', xeroContactId: 'contact-1' },
        { clientKey: 'jobber:client-2', xeroContactId: 'contact-2' },
      ],
    });
    client.projectsPost
      .mockResolvedValueOnce({ projectId: 'project-1' })
      .mockRejectedValueOnce(new XeroError('Xero refused it: The Rate field is required.', 'XERO_VALIDATION', 422, 400));
    const result = await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect(result).toMatchObject({ made: 1, failed: 1 });
    expect(links.get('visit-1')).toMatchObject({
      status: 'FAILED',
      xeroProjectId: 'project-1',
      madeHere: true,
      xeroTaskId: null,
      attempts: 1,
      problem: 'Xero refused it: The Rate field is required.',
      nextAttemptAt: new Date('2026-11-11T19:00:00.000Z'),
    });
    expect(links.get('visit-2')).toMatchObject({ status: 'DONE' });
  });

  it('stops the run on the daily ceiling, keeping what this visit has so far', async () => {
    const { service, client, links } = harness({ invoices: [visitInvoice(), visitInvoice({ id: 'inv-2' }, { id: 'visit-2' })] });
    client.projectsPost.mockResolvedValueOnce({ projectId: 'project-1' }).mockRejectedValueOnce(new XeroError('The console has used its 300 calls.', 'XERO_DAILY_CEILING', 429));
    const result = { made: 0, linked: 0, failed: 0, names: [] as string[] };
    await expect(service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD', result)).rejects.toThrow('300 calls');
    expect(result.failed).toBe(1);
    expect(links.get('visit-1')).toMatchObject({ status: 'FAILED', xeroProjectId: 'project-1' });
    expect(links.has('visit-2')).toBe(false);
  });

  it.each([
    [{ assignments: [] }, {}, 'The visit has no technician, so its project cannot be named as the office names them. Assign one, then try again.'],
    [{}, { contacts: [] }, 'Its client has no contact in Xero yet.'],
  ])('is held back, saying why, without a call to Xero (%#)', async (visit, options, problem) => {
    const { service, client, links } = harness({ invoices: [visitInvoice({}, visit as Partial<Visit>)], ...(options as object) });
    expect(await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD')).toMatchObject({ failed: 1 });
    expect(client.projectsGet).not.toHaveBeenCalled();
    expect(client.projectsPost).not.toHaveBeenCalled();
    expect(links.get('visit-1')).toMatchObject({ status: 'FAILED', problem });
  });

  it('is held back while the labour has no Xero user to go under', async () => {
    const { service, client, links } = harness();
    await service.run(ORG, TENANT, SEND_FROM, { ...VALUES, projectUserId: null }, 'USD');
    expect(client.projectsPost).not.toHaveBeenCalled();
    expect(links.get('visit-1')).toMatchObject({ status: 'FAILED', problem: 'Choose the Xero user the labour is logged under.' });
  });

  it(`is made for at most ${MAX_PROJECTS_PER_RUN} visits a run, the oldest first`, async () => {
    const many = Array.from({ length: 14 }, (_, index) => visitInvoice({ id: `inv-${index}` }, { id: `visit-${index}` }));
    const { service, posts, prisma } = harness({ invoices: many });
    await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect(posts('/Projects')).toHaveLength(MAX_PROJECTS_PER_RUN);
    // Only invoices in Xero already, from the start date, whose visit has no project or a retry due.
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          xeroTenantId: TENANT,
          issuedOn: { gte: new Date('2026-11-01T00:00:00.000Z') },
          xeroSync: { is: { xeroTenantId: TENANT, status: 'SENT' } },
        }),
        orderBy: [{ issuedOn: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('asks Xero nothing when no visit needs a project', async () => {
    const { service, client, prisma } = harness({ invoices: [] });
    expect(await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD')).toEqual({ made: 0, linked: 0, failed: 0, names: [] });
    expect(client.projectsGet).not.toHaveBeenCalled();
    expect(prisma.xeroProjectLink.findMany).not.toHaveBeenCalled();
  });

  it('shows the counts and refusals, and makes every refused one due again', async () => {
    const { service, prisma } = harness({
      links: [
        { inspectionId: 'visit-1', name: NAME, status: 'DONE' },
        { inspectionId: 'visit-2', name: 'Ada: Move Out Inspection - 11.10.2026', status: 'FAILED', problem: 'Xero refused it.', attempts: 2 },
      ],
    });
    (prisma.xeroProjectLink.findMany as jest.Mock).mockResolvedValueOnce([
      { inspectionId: 'visit-2', name: 'Ada: Move Out Inspection - 11.10.2026', problem: 'Xero refused it.', attempts: 2, lastAttemptAt: null, nextAttemptAt: null },
    ]);
    expect(await service.summary(ORG, TENANT)).toEqual({
      done: 1,
      failed: 1,
      failures: [{ inspectionId: 'visit-2', name: 'Ada: Move Out Inspection - 11.10.2026', problem: 'Xero refused it.', attempts: 2, lastAttemptAt: null, nextAttemptAt: null }],
    });
    expect(await service.retry(ORG, TENANT)).toBe(3);
    expect(prisma.xeroProjectLink.updateMany).toHaveBeenCalledWith({ where: { organizationId: ORG, xeroTenantId: TENANT, status: 'FAILED' }, data: { nextAttemptAt: expect.any(Date) } });
  });
});
