import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { makeInvoices, visitParts, type MakeRequest } from '../src/admin/invoice-maker';
import { goesToXero, invoiceProblem, invoicingState, sentFrom, type InvoicingState } from '../src/admin/invoicing-state';

/**
 * Where invoicing stands, and the one maker of invoices (2026-11-13, PR 3 of
 * the invoicing audit): the visit's form and the batch ask the same things
 * before anything is written. Everything invented.
 */

const ORG = '10000000-0000-4000-8000-000000000001';
const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const VISIT = '20000000-0000-4000-8000-000000000021';

const office = {
  id: '30000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const names: Record<string, string> = { [HOMES]: 'Example Home Services', [PEST]: 'Example Pest Co' };
const state = (over: Partial<InvoicingState> = {}): InvoicingState => ({
  takenOverAt: new Date('2026-11-12T14:14:00.000Z'),
  writesOn: true,
  organisations: [],
  sending: new Set([HOMES]),
  startDays: new Map([[HOMES, '2026-11-05']]),
  nameOf: (tenantId) => names[tenantId] ?? 'an organisation no longer known',
  ...over,
});

afterEach(() => delete process.env.JOBBER_INVOICE_WRITES_ENABLED);

describe('where invoicing stands', () => {
  it('is read once: the switch, the companies, which send to Xero and from which day', async () => {
    const db = {
      invoiceSettings: { findUnique: jest.fn().mockResolvedValue({ invoicingTakenOverAt: new Date('2026-11-12T14:14:00.000Z') }) },
      xeroOrganisation: {
        findMany: jest.fn().mockResolvedValue([
          { xeroTenantId: HOMES, name: 'Example Home Services', status: 'CONNECTED' },
          { xeroTenantId: PEST, name: 'Example Pest Co', status: 'CONNECTED' },
        ]),
      },
      // The sending ones only, connected.
      xeroSettings: { findMany: jest.fn().mockResolvedValue([{ xeroTenantId: HOMES, sendFrom: new Date('2026-11-05T00:00:00.000Z') }]) },
    };
    const read = await invoicingState(db as never, ORG);
    expect(read).toMatchObject({ writesOn: true, takenOverAt: new Date('2026-11-12T14:14:00.000Z') });
    expect([...read.sending]).toEqual([HOMES]);
    expect([...read.startDays]).toEqual([[HOMES, '2026-11-05']]);
    expect(read.nameOf(PEST)).toBe('Example Pest Co');
    expect(db.xeroSettings.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, sendingEnabled: true, xeroOrganisation: { status: 'CONNECTED' } },
      select: { xeroTenantId: true, sendFrom: true },
    });

    // Before the switch, writes are on only when the server is told so.
    db.invoiceSettings.findUnique.mockResolvedValue(null);
    expect((await invoicingState(db as never, ORG)).writesOn).toBe(false);
    process.env.JOBBER_INVOICE_WRITES_ENABLED = 'true';
    expect((await invoicingState(db as never, ORG)).writesOn).toBe(true);
  });

  it('says what keeps an invoice from being made, the same wherever it is made', () => {
    // Before the switch: no company, or one not sending, is as it was.
    expect(invoiceProblem(state({ takenOverAt: null }), null, '2026-11-13')).toBeNull();
    expect(invoiceProblem(state({ takenOverAt: null }), PEST, '2026-11-13')).toBeNull();
    // Once the console makes the invoices: each reaches a company's books in Xero.
    expect(invoiceProblem(state(), null, '2026-11-13')).toBe(
      'An invoice that goes to no company would reach no books. Choose the company whose books it goes to.',
    );
    expect(invoiceProblem(state(), PEST, '2026-11-13')).toBe(
      'Example Pest Co does not send its invoices to Xero, so this one would reach no books. Turn its sending on, on the Xero page, first.',
    );
    // Never one made before its sending company's start date has come (2026-11-13): the day it is dated does not matter.
    expect(invoiceProblem(state(), HOMES, '2026-11-04')).toBe(
      'Example Home Services sends its invoices to Xero from November 5, 2026: one made before then would never reach its books. Make it that day or later, or move the start date on the Xero page.',
    );
    expect(invoiceProblem(state(), HOMES, '2026-11-05')).toBeNull();
    expect(goesToXero(state(), HOMES)).toBe(true);
    expect(goesToXero(state(), PEST)).toBe(false);
    expect(goesToXero(state(), null)).toBe(false);
  });

  it('sends a company the console’s invoices made from its start date in Texas, whatever day each is dated, and Jobber’s issued from it (2026-11-13)', () => {
    // November 5 begins at 06:00 UTC in Texas (CST).
    expect(sentFrom('2026-11-05')).toEqual({
      OR: [
        { origin: 'CONSOLE', createdAt: { gte: new Date('2026-11-05T06:00:00.000Z') } },
        { origin: { not: 'CONSOLE' }, issuedOn: { gte: new Date('2026-11-05T00:00:00.000Z') } },
      ],
    });
  });

  it('lists a visit’s invoices, one per company, with what holds the visit back', () => {
    const lines = [
      { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 },
      { name: 'Pest Control', quantity: 1, unitPriceCents: 3900 },
    ];
    const companies = [
      { name: 'Filter Change', xeroTenantId: HOMES },
      { name: 'Pest Control', xeroTenantId: PEST },
    ];
    const { parts, problem } = visitParts(lines, companies, state(), '2026-11-13');
    expect(parts.map((part) => [part.company, part.totalCents, part.toXero])).toEqual([
      ['Example Home Services', 3999, true],
      ['Example Pest Co', 3900, false],
    ]);
    expect(problem).toMatch(/^Example Pest Co does not send its invoices to Xero/);
  });
});

describe('the one maker', () => {
  const request = (over: Partial<MakeRequest> = {}): MakeRequest => ({
    inspectionId: VISIT,
    propertywareBuildingId: 'b1',
    clientName: '100 Example Way',
    jobberJobId: null,
    subject: 'For Services Rendered',
    issuedOn: '2026-11-13',
    paymentTermsDays: 30,
    clientMessage: null,
    contractDisclaimer: null,
    asDraft: false,
    additional: false,
    invoices: [{ xeroTenantId: HOMES, lines: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 3999 }], clientRequestId: 'key:1' }],
    ...over,
  });
  const tx = (invoiced = false) => {
    let made = 0;
    return {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoiced ? { id: 'jobber-copy' } : null),
        create: jest.fn<Promise<{ id: string }>, [{ data: Record<string, unknown> }]>(async () => ({ id: `made-${++made}` })),
      },
      auditLog: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ highest: '8439' }]),
    };
  };

  it('makes a sending company’s invoice a draft Xero numbers, under the lock, after asking whether the visit is invoiced', async () => {
    const db = tx();
    const outcome = await makeInvoices(db as never, office, state(), request());
    expect(outcome).toEqual({ made: [expect.objectContaining({ id: 'made-1', number: null, xeroTenantId: HOMES })] });
    expect((db.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(db.invoice.findFirst).toHaveBeenCalledWith({ where: { organizationId: ORG, inspectionId: VISIT, status: { not: 'VOIDED' } }, select: { id: true } });
    expect(db.invoice.create.mock.calls[0]?.[0].data).toMatchObject({ status: 'DRAFT', number: null, xeroTenantId: HOMES });
  });

  it('refuses before anything is written: what reaches no books, then a visit invoiced already unless asked on purpose', async () => {
    const pest = request({ invoices: [{ xeroTenantId: PEST, lines: [{ name: 'Pest Control', quantity: 1, unitPriceCents: 3900 }], clientRequestId: 'key:1' }] });
    const refused = tx();
    expect(await makeInvoices(refused as never, office, state(), pest)).toEqual({ refused: 'PROBLEM', problem: expect.stringMatching(/^Example Pest Co does not send/) });
    expect(refused.$queryRaw).not.toHaveBeenCalled();
    expect(refused.invoice.create).not.toHaveBeenCalled();

    const invoiced = tx(true);
    expect(await makeInvoices(invoiced as never, office, state(), request())).toEqual({ refused: 'VISIT_INVOICED' });
    expect(invoiced.invoice.create).not.toHaveBeenCalled();

    const another = tx(true);
    expect(await makeInvoices(another as never, office, state(), request({ additional: true }))).toMatchObject({ made: [expect.anything()] });
    expect(another.invoice.findFirst).not.toHaveBeenCalled();
  });
});
