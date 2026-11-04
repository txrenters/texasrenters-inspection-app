import { JobberConnectionStatus } from '@prisma/client';

import { applyJobberInvoice, removeJobberInvoice } from '../src/integrations/jobber/jobber-invoice-copy';
import { JobberError } from '../src/integrations/jobber/jobber.errors';
import { INVOICE_BY_ID_QUERY, PAYMENT_RECORD_INVOICE_QUERY } from '../src/integrations/jobber/jobber.queries';
import type { JobberInvoice } from '../src/integrations/jobber/jobber.schemas';
import { JobberInvoiceWorker } from '../src/workers/jobber-sync/jobber-invoice.worker';

jest.mock('../src/integrations/jobber/jobber-invoice-copy', () => ({
  applyJobberInvoice: jest.fn().mockResolvedValue('created'),
  removeJobberInvoice: jest.fn().mockResolvedValue(true),
}));

/**
 * Reading Jobber's invoices (2026-11-05): the first read in bounded runs that
 * keep their place, then only what changed; an hour's wait, with the reason
 * kept, when Jobber hides invoices from the app. Ids invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';

const node = (id: string, updatedAt: string, over: Partial<JobberInvoice> = {}): JobberInvoice => ({
  id,
  invoiceNumber: id,
  subject: 'For Services Rendered',
  invoiceStatus: 'paid',
  issuedDate: '2026-10-01T00:00:00Z',
  dueDate: '2026-10-31T00:00:00Z',
  message: null,
  jobberWebUri: null,
  updatedAt,
  amounts: { subtotal: 39.99, taxAmount: 0, total: 39.99, invoiceBalance: 0 },
  billingAddress: null,
  client: { id: 'client-1', name: '100 Example Way' },
  jobs: { nodes: [] },
  visits: { nodes: [] },
  lineItems: { totalCount: 0, nodes: [] },
  paymentRecords: { totalCount: 0, nodes: [] },
  ...over,
});

const page = (nodes: JobberInvoice[], hasNextPage: boolean, endCursor: string | null, available = 9_000) => ({
  data: { invoices: { nodes, pageInfo: { hasNextPage, endCursor } } },
  cost: { requestedQueryCost: 2_700, actualQueryCost: 300, throttleStatus: { maximumAvailable: 10_000, currentlyAvailable: available, restoreRate: 500 } },
});

type ConnectionState = Partial<{
  status: JobberConnectionStatus;
  invoiceReadCursor: string | null;
  invoiceReadStartedAt: Date | null;
  invoiceReadCompletedAt: Date | null;
  invoiceReadThrough: Date | null;
  invoiceReadCheckedAt: Date | null;
  invoiceReadProblem: string | null;
}>;

function setup(state: ConnectionState | null = {}) {
  const prisma = {
    jobberConnection: {
      findUnique: jest.fn().mockResolvedValue(
        state === null
          ? null
          : {
              status: JobberConnectionStatus.CONNECTED,
              invoiceReadCursor: null,
              invoiceReadStartedAt: null,
              invoiceReadCompletedAt: null,
              invoiceReadThrough: null,
              invoiceReadCheckedAt: null,
              invoiceReadProblem: null,
              ...state,
            },
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    invoicePayment: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((work: (tx: object) => unknown) => work({})),
  };
  const client = { requestDetailed: jest.fn(), request: jest.fn() };
  const worker = new JobberInvoiceWorker(prisma as never, client as never);
  const sleep = jest.spyOn(worker as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue();
  const recorded = () => prisma.jobberConnection.update.mock.calls.map(([call]) => call.data);
  return { prisma, client, worker, sleep, recorded };
}

beforeEach(() => jest.mocked(applyJobberInvoice).mockClear().mockResolvedValue('created'));

describe('the first read', () => {
  it('pages every invoice by creation, keeping its place, and hands over to "what changed" at the end', async () => {
    const { client, worker, recorded } = setup();
    client.requestDetailed
      .mockResolvedValueOnce(page([node('a', '2026-11-01T10:00:00Z'), node('b', '2026-10-01T10:00:00Z')], true, 'cursor-1'))
      .mockResolvedValueOnce(page([node('c', '2026-11-02T10:00:00Z')], false, 'cursor-2'));

    const result = await worker.run(ORG);

    expect(result).toMatchObject({ mode: 'all', pages: 2, created: 3, caughtUp: true, problem: null, skipped: null });
    const [first, second] = client.requestDetailed.mock.calls;
    expect(first[1]).toMatch(/key: CREATED_AT/);
    expect(first[2]).toEqual({ first: 20, after: null });
    expect(second[2]).toEqual({ first: 20, after: 'cursor-1' });
    expect(applyJobberInvoice).toHaveBeenCalledTimes(3);

    const [kept, done] = recorded();
    // The start is kept with the first page that came back, not before it.
    expect(kept.invoiceReadStartedAt).toBeInstanceOf(Date);
    expect(kept).toMatchObject({ invoiceReadCursor: 'cursor-1', invoiceReadProblem: null });
    expect(done).toMatchObject({ invoiceReadCursor: null, invoiceReadProblem: null });
    expect(done.invoiceReadStartedAt).toBeUndefined();
    expect(done.invoiceReadCompletedAt).toBeInstanceOf(Date);
    // Five minutes before the read began, so what changed during it is read again.
    expect((kept.invoiceReadStartedAt as Date).getTime() - (done.invoiceReadThrough as Date).getTime()).toBe(5 * 60_000);
  });

  it('carries on from the kept cursor in the next run', async () => {
    const startedAt = new Date('2026-11-05T14:00:00Z');
    const { client, worker, recorded } = setup({ invoiceReadCursor: 'cursor-7', invoiceReadStartedAt: startedAt });
    client.requestDetailed.mockResolvedValueOnce(page([node('h', '2026-11-03T10:00:00Z')], false, 'cursor-8'));

    await worker.run(ORG);

    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 20, after: 'cursor-7' });
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0].invoiceReadThrough).toEqual(new Date(startedAt.getTime() - 5 * 60_000));
  });

  it('stops after fifteen pages and leaves the rest to the next tick', async () => {
    const { client, worker, recorded } = setup();
    let n = 0;
    client.requestDetailed.mockImplementation(async () => {
      n += 1;
      return page([node(`i${n}`, '2026-11-01T10:00:00Z')], true, `cursor-${n}`);
    });

    const result = await worker.run(ORG);

    expect(result).toMatchObject({ pages: 15, caughtUp: false });
    expect(client.requestDetailed).toHaveBeenCalledTimes(15);
    expect(recorded().at(-1)).toMatchObject({ invoiceReadCursor: 'cursor-15' });
  });
});

describe('after the first read', () => {
  const completed = { invoiceReadCompletedAt: new Date('2026-11-05T15:00:00Z'), invoiceReadThrough: new Date('2026-11-05T16:00:00Z') };

  it('reads only what changed since the last change applied, a second early, and moves the mark on', async () => {
    const { client, worker, recorded } = setup(completed);
    client.requestDetailed.mockResolvedValueOnce(
      page([node('x', '2026-11-05T16:00:00Z'), node('y', '2026-11-05T16:07:30Z')], false, 'c'),
    );
    jest.mocked(applyJobberInvoice).mockResolvedValueOnce('stale').mockResolvedValueOnce('updated');

    const result = await worker.run(ORG);

    expect(result).toMatchObject({ mode: 'changed', pages: 1, stale: 1, updated: 1, caughtUp: true });
    expect(client.requestDetailed.mock.calls[0][1]).toMatch(/key: UPDATED_AT/);
    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 20, after: null, updatedAfter: '2026-11-05T15:59:59.000Z' });
    expect(recorded()).toEqual([
      expect.objectContaining({ invoiceReadThrough: new Date('2026-11-05T16:07:30Z'), invoiceReadProblem: null }),
    ]);
  });

  it('reads an invoice by itself when a page cut its lines or payments short', async () => {
    const { client, worker } = setup(completed);
    const long = node('long', '2026-11-05T16:05:00Z', { lineItems: { totalCount: 14, nodes: [] } });
    client.requestDetailed.mockResolvedValueOnce(page([long], false, 'c'));
    client.request.mockResolvedValueOnce({ invoice: node('long', '2026-11-05T16:05:00Z', { lineItems: { totalCount: 1, nodes: [{ name: 'Filter Change', description: null, quantity: 1, unitPrice: 39.99, totalPrice: 39.99 }] } }) });

    const result = await worker.run(ORG);

    expect(result.readAlone).toBe(1);
    expect(client.request).toHaveBeenCalledWith(ORG, INVOICE_BY_ID_QUERY, { id: 'long' });
    expect(jest.mocked(applyJobberInvoice).mock.calls[0][2].lines).toHaveLength(1);
  });
});

describe('when Jobber will not, or cannot, answer', () => {
  it('keeps "not permitted" when Jobber hides invoices, and asks again only after an hour', async () => {
    const { client, worker, recorded } = setup();
    client.requestDetailed.mockRejectedValueOnce(
      new JobberError('Jobber has not given this app access to that data.', 'JOBBER_SCOPE_MISSING', 403),
    );

    expect(await worker.run(ORG)).toMatchObject({ problem: 'NOT_PERMITTED', pages: 0 });
    expect(recorded()).toEqual([{ invoiceReadCheckedAt: expect.any(Date), invoiceReadProblem: 'NOT_PERMITTED' }]);

    const waiting = setup({ invoiceReadProblem: 'NOT_PERMITTED', invoiceReadCheckedAt: new Date(Date.now() - 10 * 60_000) });
    expect(await waiting.worker.run(ORG)).toMatchObject({ skipped: 'WAITING', problem: 'NOT_PERMITTED' });
    expect(waiting.client.requestDetailed).not.toHaveBeenCalled();

    const later = setup({ invoiceReadProblem: 'NOT_PERMITTED', invoiceReadCheckedAt: new Date(Date.now() - 61 * 60_000) });
    later.client.requestDetailed.mockResolvedValueOnce(page([], false, null));
    expect(await later.worker.run(ORG)).toMatchObject({ skipped: null, caughtUp: true, problem: null });
  });

  const throttled = () => new JobberError('Jobber rejected the query.', 'JOBBER_GRAPHQL_ERROR', 429, true);

  it('waits out a throttled page and asks for the same cursor again', async () => {
    const { client, worker, sleep } = setup({ invoiceReadCursor: 'cursor-3', invoiceReadStartedAt: new Date() });
    client.requestDetailed
      .mockRejectedValueOnce(throttled())
      .mockResolvedValueOnce(page([node('a', '2026-11-01T10:00:00Z')], false, 'cursor-4'));

    expect(await worker.run(ORG)).toMatchObject({ pages: 1, caughtUp: true, problem: null });
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(client.requestDetailed.mock.calls.map((call) => call[2].after)).toEqual(['cursor-3', 'cursor-3']);
  });

  it('treats a page throttled three times as a pause, not a problem: the next tick carries on', async () => {
    const { client, worker, sleep, recorded } = setup({ invoiceReadCursor: 'cursor-3', invoiceReadStartedAt: new Date() });
    client.requestDetailed.mockRejectedValue(throttled());

    expect(await worker.run(ORG)).toMatchObject({ problem: null, pages: 0 });
    expect(client.requestDetailed).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(recorded()).toEqual([{ invoiceReadCheckedAt: expect.any(Date) }]);
  });

  it('fails a page that is not the shape asked for, keeping its place, rather than filing part of it', async () => {
    const { client, worker, recorded } = setup({ invoiceReadCursor: 'cursor-3', invoiceReadStartedAt: new Date() });
    client.requestDetailed.mockResolvedValueOnce(page([{ ...node('a', '2026-11-01T10:00:00Z'), invoiceStatus: 'voided' as never }], true, 'cursor-4'));

    expect(await worker.run(ORG)).toMatchObject({ problem: 'FAILED' });
    expect(applyJobberInvoice).not.toHaveBeenCalled();
    expect(recorded()).toEqual([{ invoiceReadCheckedAt: expect.any(Date), invoiceReadProblem: 'FAILED' }]);
  });

  it('does nothing without a Jobber connection', async () => {
    const { client, worker } = setup({ status: JobberConnectionStatus.DISCONNECTED });
    expect(await worker.run(ORG)).toMatchObject({ skipped: 'NOT_CONNECTED' });
    expect(client.requestDetailed).not.toHaveBeenCalled();
    expect(await setup(null).worker.run(ORG)).toMatchObject({ skipped: 'NOT_CONNECTED' });
  });

  it("waits for Jobber's bucket to hold the next page and a reserve for the visit sync", async () => {
    const { client, worker, sleep } = setup();
    client.requestDetailed
      .mockResolvedValueOnce(page([node('a', '2026-11-01T10:00:00Z')], true, 'cursor-1', 1_700))
      .mockResolvedValueOnce(page([node('b', '2026-11-01T10:00:00Z')], false, 'cursor-2'));

    await worker.run(ORG);

    // 2,700 for the page and 1,000 to spare, against 1,700 left, refilling at 500 a second.
    expect(sleep).toHaveBeenCalledWith(4_000);
  });
});

describe('webhooks', () => {
  it('reads an invoice again on INVOICE_CREATE/UPDATE, and drops one Jobber no longer has', async () => {
    const { client, worker } = setup();
    client.request.mockResolvedValueOnce({ invoice: node('a', '2026-11-05T16:00:00Z') });
    expect(await worker.refreshInvoice(ORG, 'a')).toBe('created');

    client.request.mockResolvedValueOnce({ invoice: null });
    expect(await worker.refreshInvoice(ORG, 'gone')).toBe('removed');
    expect(removeJobberInvoice).toHaveBeenCalledWith({}, ORG, 'gone');
  });

  it("reads a payment's invoice again: from the copy when it knows the payment, else from Jobber", async () => {
    const known = setup();
    known.prisma.invoicePayment.findFirst.mockResolvedValueOnce({ invoice: { jobberInvoiceId: 'inv-9' } });
    known.client.request.mockResolvedValueOnce({ invoice: node('inv-9', '2026-11-05T16:00:00Z') });
    await known.worker.refreshForPayment(ORG, 'pay-1');
    expect(known.client.request).toHaveBeenCalledTimes(1);
    expect(known.client.request).toHaveBeenCalledWith(ORG, INVOICE_BY_ID_QUERY, { id: 'inv-9' });

    const fresh = setup();
    fresh.client.request
      .mockResolvedValueOnce({ paymentRecord: { invoice: { id: 'inv-10' } } })
      .mockResolvedValueOnce({ invoice: node('inv-10', '2026-11-05T16:00:00Z') });
    await fresh.worker.refreshForPayment(ORG, 'pay-2');
    expect(fresh.client.request.mock.calls[0]).toEqual([ORG, PAYMENT_RECORD_INVOICE_QUERY, { id: 'pay-2' }]);

    const nowhere = setup();
    nowhere.client.request.mockResolvedValueOnce({ paymentRecord: null });
    expect(await nowhere.worker.refreshForPayment(ORG, 'pay-3')).toBe('missing');
  });
});
