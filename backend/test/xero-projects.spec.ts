import type { XeroSettingsValues } from '@texasrenters/shared';

import { XeroError } from '../src/integrations/xero/xero.errors';
import {
  LABOUR_TASK_NAME,
  MAX_PROJECT_PAGES_PER_READ,
  MAX_PROJECTS_PER_RUN,
  XeroProjectsService,
  finishedDayOf,
  packageQuarterOf,
} from '../src/integrations/xero/xero-projects.service';

/**
 * A Xero project for each visit (2026-11-11), as the office keeps one in a
 * company's books: under the property's contact, named after the technician,
 * the package's quarter or what the visit was, and the day it was finished,
 * with the labour logged as time. Made first (2026-11-13), in the console's New
 * project dialog, or chosen from those in Xero. Everything invented.
 */

const ORG = '90000000-0000-4000-8000-000000000001';
const TENANT = 'tenant-1';
const SEND_FROM = '2026-11-01';
const OFFICE = { id: '90000000-0000-4000-8000-0000000000aa', organizationId: ORG } as never;
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
  completedAt: Date | null;
  inspectionType: string;
  jobberVisitTitle: string | null;
  tbpPlanStop: { plan: { quarterYear: number; quarterNumber: number } } | null;
  assignments: { technician: { displayName: string } }[];
  propertywareBuilding?: { id: string; name: string; addressLine1: string | null } | null;
};
type Candidate = { id: string; clientName: string; jobberClientId: string | null; inspection: Visit | null };

const aVisit = (over: Partial<Visit> = {}): Visit => ({
  id: 'visit-1',
  scheduledAt: new Date('2026-11-10T00:00:00.000Z'),
  completedAt: null,
  inspectionType: 'OCCUPIED',
  jobberVisitTitle: '12 Example Lane - Zone 4 - Q4 2026 Tenant Benefit Package',
  tbpPlanStop: null,
  assignments: [{ technician: { displayName: 'Ada Lane' } }],
  propertywareBuilding: { id: 'building-1', name: '12 Example Lane', addressLine1: '12 Example Lane' },
  ...over,
});

const visitInvoice = (over: Partial<Candidate> = {}, visit: Partial<Visit> = {}): Candidate => ({
  id: 'inv-1',
  clientName: '12 Example Lane',
  jobberClientId: 'client-1',
  inspection: aVisit(visit),
  ...over,
});

type Row = Record<string, unknown>;

/** A Prisma `where`, as far as these services ask: equals, `in`, `not`, `lt`, `gt` and `OR`. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return (wanted as Row[]).some((each) => matches(row, each));
    const value = row[key];
    if (wanted === null || typeof wanted !== 'object' || wanted instanceof Date) return value === wanted || (value instanceof Date && wanted instanceof Date && +value === +wanted);
    const test = wanted as { in?: unknown[]; not?: unknown; lt?: Date; gt?: Date };
    if ('in' in test) return test.in!.includes(value);
    if ('not' in test) return value !== test.not;
    if ('lt' in test) return value instanceof Date && value < test.lt!;
    if ('gt' in test) return value instanceof Date && value > test.gt!;
    return true;
  });
}

function harness(
  options: {
    invoices?: Candidate[];
    visit?: Visit | null;
    links?: Row[];
    contacts?: { clientKey: string; xeroContactId: string; xeroTenantId?: string }[];
    projects?: Row[];
    projectsInXero?: { projectId: string; name: string; contactId?: string; status?: string; deadlineUtc?: string }[];
    pages?: { items: { projectId: string; name: string; contactId?: string }[]; pageCount: number }[];
    tasksInXero?: { taskId: string; name: string }[];
    timesInXero?: { timeEntryId: string }[];
    settings?: Row;
    organisation?: Row;
    connection?: { status: string; scopes: string[] } | null;
  } = {},
) {
  const links = new Map<string, Row>((options.links ?? []).map((link) => [link.inspectionId as string, { organizationId: ORG, xeroTenantId: TENANT, ...link }]));
  const contacts: Row[] = (options.contacts ?? [
    { clientKey: 'jobber:client-1', xeroContactId: 'contact-1' },
    { clientKey: 'property:building-1', xeroContactId: 'contact-1' },
  ]).map((contact) => ({ organizationId: ORG, xeroTenantId: TENANT, ...contact }));
  let made = 0;
  const projects = new Map<string, Row>(
    (options.projects ?? []).map((project) => [
      project.xeroProjectId as string,
      { id: `row-${(made += 1)}`, organizationId: ORG, xeroTenantId: TENANT, status: 'INPROGRESS', madeHere: false, deadlineOn: null, seenAt: null, createdAt: new Date(), ...project },
    ]),
  );
  const settings: Row = { organizationId: ORG, xeroTenantId: TENANT, projectsEnabled: true, labourRateCents: 3500, labourMinutes: 0, projectsReadAt: null, ...options.settings };
  const organisation: Row = { name: 'Texas Homes', status: 'CONNECTED', callsDay: null, callsUsed: 0, ...options.organisation };
  const connection = options.connection === undefined ? { status: 'CONNECTED', scopes: ['accounting.contacts', 'projects'] } : options.connection;
  const byProjectKey = (where: { organizationId_xeroTenantId_xeroProjectId?: { xeroProjectId: string }; organizationId_clientRequestId?: { clientRequestId: string } }) =>
    where.organizationId_xeroTenantId_xeroProjectId
      ? projects.get(where.organizationId_xeroTenantId_xeroProjectId.xeroProjectId)
      : [...projects.values()].find((row) => row.clientRequestId === where.organizationId_clientRequestId!.clientRequestId);
  const prisma = {
    invoice: { findMany: jest.fn<Promise<Candidate[]>, [unknown]>(async () => options.invoices ?? [visitInvoice()]) },
    inspection: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const visit = options.visit === undefined ? aVisit() : options.visit;
        return visit && visit.id === where.id ? visit : null;
      }),
    },
    xeroProjectLink: {
      findMany: jest.fn(async ({ where }: { where: Row & { inspectionId: unknown } }) => [...links.values()].filter((link) => matches(link, where))),
      findUnique: jest.fn(async ({ where }: { where: { organizationId_xeroTenantId_inspectionId: { inspectionId: string } } }) => links.get(where.organizationId_xeroTenantId_inspectionId.inspectionId) ?? null),
      upsert: jest.fn(async ({ where, create, update }: { where: { organizationId_xeroTenantId_inspectionId: { inspectionId: string } }; create: Row; update: Row }) => {
        const id = where.organizationId_xeroTenantId_inspectionId.inspectionId;
        const row = links.has(id) ? { ...links.get(id)!, ...update } : create;
        links.set(id, row);
        return row;
      }),
      count: jest.fn(async ({ where }: { where: { status: string } }) => [...links.values()].filter((link) => link.status === where.status).length),
      updateMany: jest.fn(async () => ({ count: 3 })),
    },
    xeroContactLink: {
      findMany: jest.fn(async ({ where }: { where: Row }) => contacts.filter((contact) => matches(contact, where))),
      findUnique: jest.fn(async ({ where }: { where: { organizationId_xeroTenantId_clientKey: { clientKey: string } } }) =>
        contacts.find((contact) => contact.clientKey === where.organizationId_xeroTenantId_clientKey.clientKey) ?? null,
      ),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        contacts.push(...data);
        return { count: data.length };
      }),
    },
    xeroProject: {
      findMany: jest.fn(async ({ where, orderBy }: { where: Row; orderBy?: unknown }) => {
        const rows = [...projects.values()].filter((row) => matches(row, where));
        return orderBy ? rows.sort((a, b) => +((b.deadlineOn as Date | null) ?? 0) - +((a.deadlineOn as Date | null) ?? 0)) : rows;
      }),
      findUnique: jest.fn(async ({ where }: { where: never }) => byProjectKey(where) ?? null),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        for (const row of data) projects.set(row.xeroProjectId as string, { id: `row-${(made += 1)}`, createdAt: new Date(), ...row });
        return { count: data.length };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = [...projects.values()].find((each) => each.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...projects.values()].filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      upsert: jest.fn(async ({ where, create, update }: { where: never; create: Row; update: Row }) => {
        const row = byProjectKey(where);
        if (row) return Object.assign(row, update);
        const fresh: Row = { id: `row-${(made += 1)}`, createdAt: new Date(), ...create };
        projects.set(fresh.xeroProjectId as string, fresh);
        return fresh;
      }),
    },
    xeroSettings: {
      findMany: jest.fn(async () => (settings.projectsEnabled ? [{ xeroTenantId: TENANT, projectsReadAt: settings.projectsReadAt, xeroOrganisation: { name: organisation.name } }] : [])),
      findUnique: jest.fn(async () => settings),
      update: jest.fn(async ({ data }: { data: Row }) => Object.assign(settings, data)),
    },
    xeroOrganisation: { findUnique: jest.fn(async () => organisation) },
    xeroConnection: { findUnique: jest.fn(async () => connection) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const client = {
    get: jest.fn(async () => ({ Contacts: [] })),
    post: jest.fn(async (_org: string, _tenant: string, _path: string, body: { Contacts: { Name: string }[] }) => ({
      Contacts: body.Contacts.map((contact) => ({ ContactID: 'contact-new', Name: contact.Name })),
    })),
    projectsGet: jest.fn(async (_org: string, _tenant: string, path: string): Promise<unknown> => {
      const page = /[?&]page=(\d+)/.exec(path);
      if (path.startsWith('/Projects?states=') && page) {
        const at = options.pages?.[Number(page[1]) - 1];
        return { pagination: { page: Number(page[1]), pageCount: at?.pageCount ?? 1 }, items: at?.items ?? [] };
      }
      if (path.startsWith('/Projects?')) return { items: options.projectsInXero ?? [] };
      if (path.includes('/Tasks')) return { items: options.tasksInXero ?? [] };
      if (path.includes('/Time')) return { items: options.timesInXero ?? [] };
      return {};
    }),
    projectsPost: jest.fn<Promise<unknown>, [string, string, string, unknown, unknown, string]>(async (...args) => {
      const path = args[2];
      if (path === '/Projects') return { projectId: 'project-1', name: (args[3] as { name: string }).name };
      if (path.endsWith('/Tasks')) return { taskId: 'task-1', name: LABOUR_TASK_NAME };
      return { timeEntryId: 'time-1' };
    }),
  };
  const service = new XeroProjectsService(prisma as never, client as never);
  const posts = (suffix: string) => client.projectsPost.mock.calls.filter(([, , path]) => path.endsWith(suffix));
  const calls = () => client.get.mock.calls.length + client.post.mock.calls.length + client.projectsGet.mock.calls.length + client.projectsPost.mock.calls.length;
  return { service, prisma, client, links, projects, settings, posts, calls };
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

describe('the day a visit’s project is dated (2026-11-13)', () => {
  it('is the day it was finished, in Texas, not in UTC', () => {
    // 9 p.m. in Texas on the 12th is the 13th in UTC.
    expect(finishedDayOf({ completedAt: new Date('2026-11-13T03:00:00.000Z'), scheduledAt: new Date('2026-11-10T00:00:00.000Z') })).toBe('2026-11-12');
  });
  it('is its scheduled day while it has not been finished', () => {
    expect(finishedDayOf({ completedAt: null, scheduledAt: new Date('2026-11-10T00:00:00.000Z') })).toBe('2026-11-10');
  });
});

describe('a visit’s project, made by the sending run', () => {
  it('is made under the property’s contact, named as the office names them and due on the visit’s day, with its labour as time', async () => {
    const { service, client, posts, links, projects } = harness();
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
    // Kept here, so the invoice form offers it with no call to Xero.
    expect(projects.get('project-1')).toMatchObject({ name: NAME, xeroContactId: 'contact-1', status: 'INPROGRESS', madeHere: true });
  });

  it('is the one the office made by hand under the same name -- linked, and given no labour', async () => {
    const { service, client, links, projects } = harness({ projectsInXero: [{ projectId: 'by-hand', name: '  ada:  tenant benefit package - 4th qtr - 2026 - 11.10.2026 ', contactId: 'contact-1' }] });
    expect(await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD')).toEqual({ made: 0, linked: 1, failed: 0, names: [NAME] });
    expect(client.projectsPost).not.toHaveBeenCalled();
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroProjectId: 'by-hand', madeHere: false, xeroTaskId: null });
    expect(projects.get('by-hand')).toMatchObject({ madeHere: false, xeroContactId: 'contact-1' });
  });

  it('names any other visit by what it was, in the quarter and on the day it was finished', async () => {
    const finished = new Date('2026-11-13T03:00:00.000Z');
    const { service, posts } = harness({ invoices: [visitInvoice({}, { inspectionType: 'MOVE_OUT', jobberVisitTitle: '12 Example Lane - Move Out', completedAt: finished })] });
    await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD');
    expect(posts('/Projects')[0]![3]).toMatchObject({ name: 'Ada: Move Out Inspection - 4th Qtr - 2026 - 11.12.2026', deadlineUtc: '2026-11-12T12:00:00Z' });
    expect(posts('/Time')[0]![3]).toMatchObject({ dateUtc: '2026-11-12T12:00:00Z' });
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

  it('logs the labour on a project made first, keeping the name the office gave it', async () => {
    const { service, client, posts, links } = harness({
      links: [{ inspectionId: 'visit-1', name: 'Ada: typed by the office', status: 'PENDING', attempts: 0, xeroProjectId: 'made-first', madeHere: true, xeroTaskId: null, xeroTimeEntryId: null }],
    });
    expect(await service.run(ORG, TENANT, SEND_FROM, VALUES, 'USD')).toEqual({ made: 1, linked: 0, failed: 0, names: ['Ada: typed by the office'] });
    expect(client.projectsGet).not.toHaveBeenCalled();
    expect(posts('/Projects')).toHaveLength(0);
    expect(posts('/Tasks')[0]![2]).toBe('/Projects/made-first/Tasks');
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', name: 'Ada: typed by the office', xeroTimeEntryId: 'time-1' });
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

describe('a visit’s projects on the invoice form (2026-11-13)', () => {
  const inProgress = (xeroProjectId: string, name: string, deadline: string, over: Row = {}) => ({
    xeroProjectId,
    name,
    xeroContactId: 'contact-1',
    deadlineOn: new Date(`${deadline}T00:00:00.000Z`),
    ...over,
  });

  it('offers the company’s projects in progress under the property, the visit’s own, and a name and deadline for a new one -- with no call to Xero', async () => {
    const { service, calls } = harness({
      visit: aVisit({ completedAt: new Date('2026-11-12T20:00:00.000Z') }),
      links: [{ inspectionId: 'visit-1', name: NAME, status: 'DONE', xeroProjectId: 'chosen', madeHere: true }],
      projects: [
        inProgress('older', 'Ada: Tenant Benefit Package - 3rd Qtr - 2026 - 08.10.2026', '2026-08-10'),
        inProgress('chosen', NAME, '2026-11-10', { madeHere: true }),
        inProgress('closed', 'Old', '2026-12-01', { status: 'CLOSED' }),
        inProgress('elsewhere', 'Another property', '2026-12-02', { xeroContactId: 'contact-9' }),
      ],
    });
    const view = await service.visitProjects(OFFICE, 'visit-1');
    expect(calls()).toBe(0);
    expect(view).toEqual({
      inspectionId: 'visit-1',
      contactName: '12 Example Lane',
      suggestedName: 'Ada: Tenant Benefit Package - 4th Qtr - 2026 - 11.12.2026',
      deadlineOn: '2026-11-12',
      companies: [
        {
          tenantId: TENANT,
          name: 'Texas Homes',
          chosen: { xeroProjectId: 'chosen', name: NAME, deadlineOn: '2026-11-10', status: 'INPROGRESS', madeHere: true },
          projects: [
            { xeroProjectId: 'chosen', name: NAME, deadlineOn: '2026-11-10', status: 'INPROGRESS', madeHere: true },
            { xeroProjectId: 'older', name: 'Ada: Tenant Benefit Package - 3rd Qtr - 2026 - 08.10.2026', deadlineOn: '2026-08-10', status: 'INPROGRESS', madeHere: false },
          ],
          problem: null,
          readAt: null,
        },
      ],
    });
  });

  it('lists no company whose projects are off, and says when Xero cannot be reached for projects', async () => {
    expect((await harness({ settings: { projectsEnabled: false } }).service.visitProjects(OFFICE, 'visit-1')).companies).toEqual([]);
    const view = await harness({ connection: { status: 'CONNECTED', scopes: ['accounting.contacts'] } }).service.visitProjects(OFFICE, 'visit-1');
    expect(view.companies[0]!.problem).toBe('Connect again, so Xero lets the console make projects.');
  });

  it('leaves the name to the office for a visit with no technician', async () => {
    const view = await harness({ visit: aVisit({ assignments: [] }) }).service.visitProjects(OFFICE, 'visit-1');
    expect(view.suggestedName).toBeNull();
  });
});

describe('“Create project” (2026-11-13)', () => {
  const input = { inspectionId: 'visit-1', name: '  Ada:  Tenant Benefit Package - 4th Qtr - 2026 - 11.10.2026 ', deadlineOn: '2026-11-10', estimateCents: 6450, clientRequestId: 'dialog-key-1' };

  it('makes it in Xero at once, In progress, under the property’s contact, and chooses it for the visit -- in two calls', async () => {
    const { service, client, posts, links, projects, prisma, calls } = harness();
    const answer = await service.make(OFFICE, TENANT, input);
    expect(answer).toEqual({ project: { xeroProjectId: 'project-1', name: NAME, deadlineOn: '2026-11-10', status: 'INPROGRESS', madeHere: true }, found: false });
    expect(calls()).toBe(2);
    expect(client.projectsGet.mock.calls[0]![2]).toBe('/Projects?contactID=contact-1&states=INPROGRESS&pageSize=500');
    expect(posts('/Projects')[0]![3]).toEqual({ contactId: 'contact-1', name: NAME, deadlineUtc: '2026-11-10T12:00:00Z', estimateAmount: 64.5 });
    expect(posts('/Projects')[0]![5]).toMatch(/^[0-9a-f]{64}$/);
    expect(projects.get('project-1')).toMatchObject({ madeHere: true, clientRequestId: 'dialog-key-1', estimateCents: 6450, xeroContactId: 'contact-1' });
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroProjectId: 'project-1', name: NAME, madeHere: true });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_PROJECT_MADE', entityId: 'visit-1', actorUserId: expect.any(String) }) });
  });

  it('leaves its labour to the sending run, once the invoice is in Xero, while the office logs any', async () => {
    const { service, links, posts } = harness({ settings: { labourMinutes: 6 } });
    await service.make(OFFICE, TENANT, input);
    expect(posts('/Tasks')).toHaveLength(0);
    expect(links.get('visit-1')).toMatchObject({ status: 'PENDING', xeroProjectId: 'project-1', madeHere: true });
  });

  it('makes the property a contact first when Xero has none for it', async () => {
    const { service, client, posts } = harness({ contacts: [] });
    await service.make(OFFICE, TENANT, input);
    expect(client.post.mock.calls[0]![2]).toBe('/Contacts?summarizeErrors=false');
    expect(client.post.mock.calls[0]![3]).toEqual({ Contacts: [{ Name: '12 Example Lane' }] });
    expect(posts('/Projects')[0]![3]).toMatchObject({ contactId: 'contact-new' });
  });

  it('chooses the one already in progress there under the same name -- never a second', async () => {
    const { service, client, links, prisma } = harness({ projectsInXero: [{ projectId: 'by-hand', name: NAME.toLowerCase(), contactId: 'contact-1', deadlineUtc: '2026-11-10T00:00:00Z' }] });
    const answer = await service.make(OFFICE, TENANT, input);
    expect(answer).toMatchObject({ project: { xeroProjectId: 'by-hand', madeHere: false }, found: true });
    expect(client.projectsPost).not.toHaveBeenCalled();
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroProjectId: 'by-hand', madeHere: false });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_PROJECT_CHOSEN' }) });
  });

  it('answers a resend of the same dialog with what the first made, asking Xero nothing', async () => {
    const { service, calls } = harness({ projects: [{ xeroProjectId: 'project-1', name: NAME, madeHere: true, clientRequestId: 'dialog-key-1' }] });
    expect(await service.make(OFFICE, TENANT, input)).toMatchObject({ project: { xeroProjectId: 'project-1' }, found: false });
    expect(calls()).toBe(0);
  });

  it.each([
    [{ settings: { projectsEnabled: false } }, input, 'Projects are off for Texas Homes'],
    [{ connection: { status: 'CONNECTED', scopes: ['accounting.contacts'] } }, input, 'Connect again, so Xero lets the console make projects.'],
    [{ organisation: { status: 'REMOVED' } }, input, 'Texas Homes is no longer connected'],
    [{}, { ...input, name: '   ' }, 'Give the project a name'],
    [{}, { ...input, name: 'x'.repeat(101) }, 'Give the project a name'],
    [{}, { ...input, deadlineOn: '2026-02-30' }, 'Give the project a deadline.'],
    [{}, { ...input, estimateCents: -1 }, 'The estimate is not an amount Xero takes.'],
    [{ visit: null }, input, 'That visit was not found.'],
  ])('is refused, asking Xero nothing (%#)', async (options, given, problem) => {
    const { service, calls } = harness(options as never);
    await expect(service.make(OFFICE, TENANT, given)).rejects.toThrow(problem);
    expect(calls()).toBe(0);
  });
});

describe('choosing a project already in Xero (2026-11-13)', () => {
  const theirs = { xeroProjectId: 'by-hand', name: 'Ada: made by hand', xeroContactId: 'contact-1' };

  it('makes it the visit’s, with no call to Xero and no labour of the console’s on it', async () => {
    const { service, links, prisma, calls } = harness({ projects: [theirs], links: [{ inspectionId: 'visit-1', name: NAME, status: 'DONE', xeroProjectId: 'project-1', madeHere: true, xeroTaskId: 't', xeroTimeEntryId: 'e' }] });
    expect(await service.choose(OFFICE, TENANT, 'visit-1', 'by-hand')).toMatchObject({ xeroProjectId: 'by-hand', name: 'Ada: made by hand' });
    expect(calls()).toBe(0);
    expect(links.get('visit-1')).toMatchObject({ status: 'DONE', xeroProjectId: 'by-hand', madeHere: false, xeroTaskId: null, xeroTimeEntryId: null });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'XERO_PROJECT_CHOSEN', metadata: expect.objectContaining({ replaced: 'project-1' }) }) });
  });

  it.each([
    [{ projects: [] }, 'That project is not in this company’s books.'],
    [{ projects: [{ ...theirs, xeroContactId: 'contact-9' }] }, 'That project is not under 12 Example Lane in Xero.'],
    [{ projects: [{ ...theirs, status: 'CLOSED' }] }, 'That project is closed in Xero.'],
    [{ projects: [theirs], settings: { projectsEnabled: false } }, 'Projects are off for Texas Homes'],
  ])('is refused (%#)', async (options, problem) => {
    const { service, links } = harness(options as never);
    await expect(service.choose(OFFICE, TENANT, 'visit-1', 'by-hand')).rejects.toThrow(problem);
    expect(links.has('visit-1')).toBe(false);
  });
});

describe('the company’s projects read from Xero (2026-11-13)', () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ projectId: `p-${from + index}`, name: `Project ${from + index}`, contactId: 'contact-1' }));

  it('reads every page of those in progress, keeps them, and closes what is no longer there', async () => {
    const { service, client, projects, settings } = harness({
      projects: [{ xeroProjectId: 'gone', name: 'Closed in Xero', seenAt: new Date('2026-11-10T00:00:00.000Z') }],
      pages: [
        { items: page(0, 500), pageCount: 2 },
        { items: page(500, 3), pageCount: 2 },
      ],
    });
    const result = await service.readIfDue(ORG, TENANT);
    expect(result).toEqual({ read: 503, closed: 1, calls: 2, complete: true, problem: null });
    expect(client.projectsGet.mock.calls.map((call) => call[2])).toEqual([
      '/Projects?states=INPROGRESS&page=1&pageSize=500',
      '/Projects?states=INPROGRESS&page=2&pageSize=500',
    ]);
    expect(projects.get('p-502')).toMatchObject({ name: 'Project 502', status: 'INPROGRESS', madeHere: false });
    expect(projects.get('gone')).toMatchObject({ status: 'CLOSED' });
    expect(settings.projectsReadAt).toEqual(new Date('2026-11-11T18:00:00.000Z'));
  });

  it(`stops at ${MAX_PROJECT_PAGES_PER_READ} pages, closing nothing, and reads again next time`, async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({ items: page(index * 500, 500), pageCount: 6 }));
    const { service, projects, settings } = harness({ projects: [{ xeroProjectId: 'gone', name: 'Not read yet' }], pages });
    expect(await service.readIfDue(ORG, TENANT)).toMatchObject({ calls: MAX_PROJECT_PAGES_PER_READ, complete: false, closed: 0 });
    expect(projects.get('gone')).toMatchObject({ status: 'INPROGRESS' });
    expect(settings.projectsReadAt).toBeNull();
  });

  it('keeps inside the day’s calls the read leaves to sending', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({ items: page(index * 500, 500), pageCount: 6 }));
    const { service } = harness({ pages, organisation: { callsDay: '2026-11-11', callsUsed: 198 } });
    expect(await service.readIfDue(ORG, TENANT)).toMatchObject({ calls: 2 });
    const spent = harness({ pages, organisation: { callsDay: '2026-11-11', callsUsed: 200 } });
    expect(await spent.service.readIfDue(ORG, TENANT)).toMatchObject({ calls: 0, problem: expect.stringContaining('for sending') });
    expect(spent.client.projectsGet).not.toHaveBeenCalled();
  });

  it.each([
    ['read in the past six hours', { settings: { projectsReadAt: new Date('2026-11-11T13:00:00.000Z') } }],
    ['projects off', { settings: { projectsEnabled: false } }],
    ['no projects permission', { connection: { status: 'CONNECTED', scopes: [] } }],
    ['the company disconnected', { organisation: { status: 'REMOVED' } }],
  ])('asks Xero nothing: %s', async (_why, options) => {
    const { service, client } = harness(options as never);
    expect(await service.readIfDue(ORG, TENANT)).toBeNull();
    expect(client.projectsGet).not.toHaveBeenCalled();
  });
});
