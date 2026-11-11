import { UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';
import { compareMonth, monthWhere, type ConsoleInvoiceForCheck, type XeroInvoiceForCheck } from '../src/integrations/xero/xero-check';
import { XeroCheckService } from '../src/integrations/xero/xero-check.service';
import { XeroController } from '../src/integrations/xero/xero.controller';

/**
 * Checking a month of a company's invoices against its books in Xero
 * (2026-11-10, phase 5 of the multi-company plan): only when asked, at most
 * once a minute, ten reads at most, and kept. Everything invented.
 */

const ORG = '91000000-0000-4000-8000-000000000001';
const TENANT = 'a2000000-0000-4000-8000-000000000002';
const office: AuthenticatedUser = {
  id: '91000000-0000-4000-8000-000000000030',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['integrations:read', 'integrations:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const here = (over: Partial<ConsoleInvoiceForCheck> = {}): ConsoleInvoiceForCheck => ({
  id: 'inv-1',
  number: '8440',
  clientName: '12 Example Lane',
  status: 'AWAITING_PAYMENT',
  totalCents: 17500,
  paidCents: 0,
  xeroInvoiceId: 'xero-1',
  problem: null,
  ...over,
});
const there = (over: Partial<XeroInvoiceForCheck> = {}): XeroInvoiceForCheck => ({
  InvoiceID: 'xero-1',
  InvoiceNumber: '8440',
  Status: 'AUTHORISED',
  Contact: { Name: '12 Example Lane' },
  Total: 175,
  AmountPaid: 0,
  ...over,
});

describe('a month, the console against Xero', () => {
  it('matches an invoice that is the same in both', () => {
    expect(compareMonth([here()], [there()])).toEqual({
      counts: { console: 1, xero: 1, matching: 1, different: 0, notSent: 0, missingInXero: 0, onlyInXero: 0 },
      differences: [],
      truncated: false,
    });
  });

  it('says what differs, in words: the total, and what was paid', () => {
    const { counts, differences } = compareMonth([here({ paidCents: 17500, status: 'PAID' })], [there({ Total: 180, AmountPaid: 0 })]);
    expect(counts).toMatchObject({ matching: 0, different: 1 });
    expect(differences).toEqual([
      { kind: 'TOTAL', invoiceId: 'inv-1', number: '8440', clientName: '12 Example Lane', here: '$175.00', xero: '$180.00' },
      { kind: 'PAID', invoiceId: 'inv-1', number: '8440', clientName: '12 Example Lane', here: '$175.00 paid', xero: '$0.00 paid' },
    ]);
  });

  it('says when one is voided in only one of them', () => {
    expect(compareMonth([here({ status: 'VOIDED' })], [there()]).differences).toEqual([
      expect.objectContaining({ kind: 'STATUS', here: 'voided', xero: 'approved, owing' }),
    ]);
    expect(compareMonth([here()], [there({ Status: 'VOIDED' })]).differences).toEqual([expect.objectContaining({ kind: 'STATUS', here: 'awaiting payment', xero: 'voided' })]);
    // Voided in both: the same, whatever the amounts.
    expect(compareMonth([here({ status: 'VOIDED' })], [there({ Status: 'VOIDED', Total: 0 })]).counts.matching).toBe(1);
  });

  it('lists one not sent yet, with why', () => {
    const { counts, differences } = compareMonth([here({ xeroInvoiceId: null, problem: 'Choose the account Filter Change goes to.' })], []);
    expect(counts).toMatchObject({ console: 1, notSent: 1 });
    expect(differences[0]).toMatchObject({ kind: 'NOT_SENT', here: '$175.00, awaiting payment', xero: 'Not sent: Choose the account Filter Change goes to.' });
    // Voided before it was ever sent: nothing to check.
    expect(compareMonth([here({ xeroInvoiceId: null, status: 'VOIDED' })], []).counts.console).toBe(0);
  });

  it('lists one sent that Xero no longer has this month', () => {
    expect(compareMonth([here()], []).differences).toEqual([
      expect.objectContaining({ kind: 'MISSING_IN_XERO', here: '$175.00, sent, awaiting payment', xero: 'Not in Xero this month: deleted there, or dated another month' }),
    ]);
  });

  it('lists one in Xero that did not come from the console, but not one voided there', () => {
    const { counts, differences } = compareMonth([here()], [there(), there({ InvoiceID: 'xero-9', InvoiceNumber: 'INV-0099', Contact: { Name: 'Walk-in client' }, Total: 60 }), there({ InvoiceID: 'xero-10', Status: 'VOIDED' })]);
    expect(counts).toMatchObject({ xero: 3, matching: 1, onlyInXero: 1 });
    expect(differences).toEqual([{ kind: 'ONLY_IN_XERO', invoiceId: null, number: 'INV-0099', clientName: 'Walk-in client', here: 'Not in the console', xero: '$60.00, approved, owing' }]);
  });

  it('keeps at most 200 differences, and says there were more', () => {
    const many = Array.from({ length: 205 }, (_, index) => here({ id: `inv-${index}`, xeroInvoiceId: null }));
    const result = compareMonth(many, []);
    expect(result.differences).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.counts.notSent).toBe(205);
  });

  it('asks Xero for the month by its sales invoices’ dates, December into January', () => {
    expect(monthWhere('2026-11')).toBe('Type=="ACCREC"&&Date>=DateTime(2026,11,1)&&Date<DateTime(2026,12,1)');
    expect(monthWhere('2026-12')).toBe('Type=="ACCREC"&&Date>=DateTime(2026,12,1)&&Date<DateTime(2027,1,1)');
  });
});

function harness(
  options: { xeroPages?: XeroInvoiceForCheck[][]; latest?: Date | null; sendFrom?: Date | null; invoices?: unknown[]; paymentsToXero?: boolean } = {},
) {
  const stored: Record<string, unknown>[] = [];
  const prisma = {
    xeroCheck: {
      findFirst: jest.fn(async () => (options.latest ? { ranAt: options.latest } : null)),
      findUnique: jest.fn(async () => (stored[0] ? { ...stored[0], ranBy: { displayName: 'Office Coordinator' } } : null)),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => {
        stored.splice(0, stored.length, create);
        return create;
      }),
    },
    xeroSettings: {
      findUnique: jest.fn(async () => ({
        sendFrom: options.sendFrom === undefined ? new Date('2026-11-01T00:00:00.000Z') : options.sendFrom,
        paymentsToXero: options.paymentsToXero ?? true,
      })),
    },
    invoice: {
      findMany: jest.fn<Promise<unknown[]>, [{ where: Record<string, unknown> }]>(async () =>
        options.invoices ?? [
          {
            id: 'inv-1',
            number: '8440',
            clientName: '12 Example Lane',
            status: 'PAID',
            totalCents: 17500,
            payments: [{ amountCents: 10000 }, { amountCents: 7500 }],
            xeroSync: { xeroTenantId: TENANT, xeroInvoiceId: 'xero-1', status: 'SENT', problem: null },
          },
        ],
      ),
    },
    auditLog: { create: jest.fn() },
  };
  const pages = options.xeroPages ?? [[there({ Status: 'PAID', AmountPaid: 175 })]];
  const client = { get: jest.fn(async (_org: string, _tenant: string, path: string) => ({ Invoices: pages[Number(/page=(\d+)/.exec(path)![1]) - 1] ?? [] })) };
  return { checks: new XeroCheckService(prisma as never, client as never), prisma, client };
}

describe('checking a month', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-20T18:00:00.000Z'), doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'] });
  });
  afterEach(() => jest.useRealTimers());

  it('reads the month from Xero, compares, keeps what it found, and puts it on the record', async () => {
    const { checks, prisma, client } = harness();
    const view = await checks.run(office, TENANT, '2026-11');

    expect(client.get).toHaveBeenCalledTimes(1);
    const [, tenant, path] = client.get.mock.calls[0]!;
    expect(tenant).toBe(TENANT);
    expect(path).toBe(`/Invoices?where=${encodeURIComponent(monthWhere('2026-11'))}&Statuses=AUTHORISED,PAID,VOIDED&summaryOnly=true&page=1&pageSize=100`);
    // The office's invoices of the month, its company's, from the start date, not drafts -- the month Xero files
    // them in (2026-11-11): their visit's, else the one they were issued in.
    expect(prisma.invoice.findMany.mock.calls[0]![0].where).toEqual({
      organizationId: ORG,
      xeroTenantId: TENANT,
      // What the console sent, never what it read back from Xero (2026-11-12).
      origin: { not: 'XERO' },
      status: { not: 'DRAFT' },
      issuedOn: { gte: new Date('2026-11-01T00:00:00.000Z') },
      OR: [{ inspection: { is: { scheduledAt: { gte: new Date('2026-11-01T00:00:00.000Z'), lt: new Date('2026-12-01T00:00:00.000Z') } } } }, { inspectionId: null, issuedOn: { gte: new Date('2026-11-01T00:00:00.000Z'), lt: new Date('2026-12-01T00:00:00.000Z') } }],
    });
    expect(view).toMatchObject({ month: '2026-11', ranBy: 'Office Coordinator', calls: 1, truncated: false, counts: { console: 1, xero: 1, matching: 1 }, differences: [] });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'XERO_CHECK_RAN', actorUserId: office.id, metadata: expect.objectContaining({ tenantId: TENANT, month: '2026-11', calls: 1 }) }),
    });
  });

  it('reads 100 a call until Xero has no more, and ten calls at most', async () => {
    const full = (start: number) => Array.from({ length: 100 }, (_, index) => there({ InvoiceID: `x-${start + index}`, Status: 'VOIDED' }));
    const two = harness({ xeroPages: [full(0), [there({ InvoiceID: 'x-last', Status: 'VOIDED' })]] });
    expect(await two.checks.run(office, TENANT, '2026-11')).toMatchObject({ calls: 2, truncated: false, counts: { xero: 101 } });

    const many = harness({ xeroPages: Array.from({ length: 12 }, (_, page) => full(page * 100)) });
    const view = await many.checks.run(office, TENANT, '2026-11');
    expect(many.client.get).toHaveBeenCalledTimes(10);
    expect(view).toMatchObject({ calls: 10, truncated: true });
  });

  it('runs at most once a minute for an organisation', async () => {
    const { checks, client } = harness({ latest: new Date('2026-11-20T17:59:30.000Z') });
    await expect(checks.run(office, TENANT, '2026-11')).rejects.toMatchObject({ code: 'XERO_CHECK_TOO_SOON' });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('refuses a month still to come, or no month', async () => {
    const { checks, client } = harness();
    await expect(checks.run(office, TENANT, '2026-12')).rejects.toMatchObject({ code: 'XERO_CHECK_INVALID', message: 'A month still to come has nothing to check.' });
    await expect(checks.run(office, TENANT, '2026-13')).rejects.toMatchObject({ code: 'XERO_CHECK_INVALID' });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('expects nothing in Xero before a start date, and lists only what Xero has', async () => {
    const none = harness({ sendFrom: null, xeroPages: [[there({ InvoiceID: 'by-hand', InvoiceNumber: 'INV-1' })]] });
    const view = await none.checks.run(office, TENANT, '2026-11');
    expect(none.prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(view.counts).toMatchObject({ console: 0, onlyInXero: 1 });
  });

  it('counts an invoice issued from the start date in the month of its visit, even an earlier one', async () => {
    // Issued on or after December 1 for a November visit: dated November in Xero, so November's.
    const { checks, prisma } = harness({ sendFrom: new Date('2026-12-01T00:00:00.000Z') });
    await checks.run(office, TENANT, '2026-11');
    const where = prisma.invoice.findMany.mock.calls[0]![0].where;
    expect(where.issuedOn).toEqual({ gte: new Date('2026-12-01T00:00:00.000Z') });
    expect((where.OR as unknown[])[0]).toEqual({ inspection: { is: { scheduledAt: { gte: new Date('2026-11-01T00:00:00.000Z'), lt: new Date('2026-12-01T00:00:00.000Z') } } } });
  });

  it('leaves what is paid in Xero alone when payments stay out of it', async () => {
    // Paid here, with nothing paid in Xero: the office records payments there itself.
    const { checks } = harness({ paymentsToXero: false, xeroPages: [[there({ Status: 'PAID', AmountPaid: 0 })]] });
    const view = await checks.run(office, TENANT, '2026-11');
    expect(view.counts).toMatchObject({ matching: 1, different: 0 });
  });

  it('shows the latest check from the console’s record, without asking Xero', async () => {
    const { checks, client } = harness();
    expect(await checks.view(ORG, TENANT, '2026-11')).toEqual({
      tenantId: TENANT,
      month: '2026-11',
      ranAt: null,
      ranBy: null,
      counts: null,
      differences: [],
      truncated: false,
      calls: 0,
      sendFrom: '2026-11-01',
    });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('is seen with integrations:read and run with integrations:manage', () => {
    const permissions = (method: keyof XeroController) => Reflect.getMetadata(PERMISSIONS_METADATA_KEY, XeroController.prototype[method]);
    expect(permissions('check')).toEqual(['integrations:read']);
    expect(permissions('runCheck')).toEqual(['integrations:manage']);
  });
});
