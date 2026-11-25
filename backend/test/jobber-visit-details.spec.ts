import { ApplicationError } from '../src/common/errors';
import { DAILY_CEILING, JobberVisitDetailsService } from '../src/integrations/jobber/jobber-visit-details.service';

const ORG = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-25T18:00:00.000Z');

const node = {
  id: 'v-44796',
  title: '1204 Cedar Hollow Dr - 1204 Cedar Hollow Dr - Zone 2 - General Maintenance - #44796',
  instructions: '  Pest control - Seeing an influx of spiders and ants around the home.\n\nTenant: Jordan Example  ',
  startAt: '2026-11-25T06:00:00Z',
  allDay: true,
  completedAt: null,
  incompleteJobFormsCount: 1,
  job: { jobNumber: 21118, title: 'General Maintenance', jobberWebUri: 'https://secure.getjobber.com/work_orders/1' },
  client: { name: 'Jordan Example', defaultPhones: '5555550100', defaultEmails: ['jordan@example.test'], jobberWebUri: null },
  property: { address: { street1: '1204 Cedar Hollow Dr', street2: null, city: 'Springfield', province: 'Texas', postalCode: '77000' } },
  assignedUsers: { nodes: [{ name: { full: 'Emanuel Hall' } }] },
  notes: { totalCount: 1, nodes: [{ message: 'Gate code 1234', createdAt: '2026-11-24T15:00:00Z' }] },
};

function service({ stored = true, lineItems = 'ok' as 'ok' | 'fail' } = {}) {
  const prisma = { jobberVisitImport: { findFirst: jest.fn().mockResolvedValue(stored ? { id: 'row-1' } : null) } };
  const request = jest.fn((_org: string, query: string) => {
    if (query.includes('VisitLineItems')) {
      if (lineItems === 'fail') return Promise.reject(new Error("Field 'totalPrice' doesn't exist"));
      return Promise.resolve({ visits: { nodes: [{ lineItems: { nodes: [{ name: 'Pest control', description: null, quantity: 1, totalPrice: 95 }] } }] } });
    }
    return Promise.resolve({ visits: { nodes: [node] } });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { details: new JobberVisitDetailsService(prisma as any, { request } as any), request, prisma };
}

describe("a visit's details from Jobber (2026-11-25)", () => {
  it("reads what Jobber's Visit details window shows, and writes nothing", async () => {
    const { details, request } = service();
    const result = await details.details(ORG, 'v-44796', NOW);

    expect(result).toMatchObject({
      title: node.title,
      completed: false,
      startAt: null,
      date: '2026-11-25',
      addressLines: ['1204 Cedar Hollow Dr', 'Springfield, Texas 77000'],
      instructions: 'Pest control - Seeing an influx of spiders and ants around the home.\n\nTenant: Jordan Example',
      job: { number: '21118', title: 'General Maintenance' },
      team: ['Emanuel Hall'],
      client: { name: 'Jordan Example', phones: ['5555550100'], emails: ['jordan@example.test'] },
      notes: [{ message: 'Gate code 1234' }],
      notesTotal: 1,
      checklistsToDo: 1,
      lineItems: [{ name: 'Pest control', quantity: 1, totalPrice: 95 }],
    });
    for (const [, query] of request.mock.calls) expect(query).not.toMatch(/mutation/);
  });

  it('reads Jobber again only after five minutes', async () => {
    const { details, request } = service();
    await details.details(ORG, 'v-44796', NOW);
    await details.details(ORG, 'v-44796', new Date(NOW.getTime() + 4 * 60_000));
    expect(request).toHaveBeenCalledTimes(2); // one open: the details and the line items

    await details.details(ORG, 'v-44796', new Date(NOW.getTime() + 6 * 60_000));
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('keeps the rest when the line items cannot be read', async () => {
    const { details } = service({ lineItems: 'fail' });
    const result = await details.details(ORG, 'v-44796', NOW);
    expect(result.lineItems).toBeNull();
    expect(result.instructions).toContain('Pest control');
  });

  it("never reads Jobber for a visit the sync does not have for the organization", async () => {
    const { details, request } = service({ stored: false });
    await expect(details.details(ORG, 'v-other', NOW)).rejects.toMatchObject({ code: 'JOBBER_VISIT_NOT_FOUND' });
    expect(request).not.toHaveBeenCalled();
  });

  it('stops reading Jobber for the day at the ceiling, however many visits are opened', async () => {
    const { details, request } = service();
    for (let index = 0; index < DAILY_CEILING; index += 1) await details.details(ORG, `v-${index}`, NOW);
    const error = await details.details(ORG, 'v-one-more', NOW).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({ code: 'JOBBER_DETAILS_CEILING' });
    expect(request).toHaveBeenCalledTimes(DAILY_CEILING * 2);

    // The next Texas day starts again.
    await details.details(ORG, 'v-one-more', new Date('2026-11-26T18:00:00.000Z'));
    expect(request).toHaveBeenCalledTimes(DAILY_CEILING * 2 + 2);
  });
});
