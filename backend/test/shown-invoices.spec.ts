import { KEPT_IN_XERO, keptInXero, officeXeroBooks, shownInvoices } from '../src/admin/shown-invoices';

/**
 * What the invoice pages show (2026-11-12, PR 3 of the plan to make invoices
 * in the console with Xero as the record): a company whose books are read from
 * Xero in full shows them as Xero has them, in place of Jobber's copies; any
 * other shows as before. The rule is a Prisma where clause, so it is read here
 * the way the database would, over invented rows.
 */

const HOMES = 'b1000000-0000-4000-8000-000000000001';
const PEST = 'b1000000-0000-4000-8000-000000000002';
const AIR = 'b1000000-0000-4000-8000-000000000003';

type Row = { id: string; origin: 'JOBBER' | 'CONSOLE' | 'XERO'; xeroTenantId: string | null; xeroInvoiceId?: string | null; jobberCopyId?: string | null };
const ROWS: Row[] = [
  // Jobber's copy in a company that is read: Xero's row stands for it.
  { id: 'jobber-homes', origin: 'JOBBER', xeroTenantId: HOMES },
  // Jobber's copy of no company that Xero's row in a read company stands for.
  { id: 'jobber-twinned', origin: 'JOBBER', xeroTenantId: null },
  // Jobber's copy of no company, in nobody's books.
  { id: 'jobber-none', origin: 'JOBBER', xeroTenantId: null },
  // Jobber's copy in a company never read (disconnected).
  { id: 'jobber-air', origin: 'JOBBER', xeroTenantId: AIR },
  { id: 'xero-homes', origin: 'XERO', xeroTenantId: HOMES, xeroInvoiceId: 'x-1' },
  { id: 'xero-twin', origin: 'XERO', xeroTenantId: HOMES, xeroInvoiceId: 'x-2', jobberCopyId: 'jobber-twinned' },
  // Xero's row in a company whose first read is still going.
  { id: 'xero-pest', origin: 'XERO', xeroTenantId: PEST, xeroInvoiceId: 'x-3' },
  { id: 'console-homes', origin: 'CONSOLE', xeroTenantId: HOMES, xeroInvoiceId: 'x-4' },
  { id: 'console-none', origin: 'CONSOLE', xeroTenantId: null },
];

type Where = Record<string, unknown>;
/** The parts of a where clause the rule uses, as Postgres reads them. */
function holds(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'NOT') return (condition as Where[]).every((each) => !holds(row, each));
    if (key === 'xeroTwins') {
      const some = (condition as { some: Where }).some;
      return ROWS.some((twin) => twin.jobberCopyId === row.id && holds(twin, some));
    }
    const value = (row as Record<string, unknown>)[key] ?? null;
    if (condition && typeof condition === 'object') {
      const test = condition as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      // SQL: a null is in nothing and not-in nothing; the rule says `not: null` first wherever a null could reach.
      if ('not' in test && test.not === null && value === null) return false;
      if (test.in) return value !== null && test.in.includes(value);
      if (test.notIn) return value !== null && !test.notIn.includes(value);
      return true;
    }
    return value === condition;
  });
}
const shown = (where: Where) => ROWS.filter((row) => holds(row, where)).map((row) => row.id);

describe('what the invoice pages show', () => {
  it('shows a read company’s books as Xero has them, and every other company’s as before', () => {
    expect(shown(shownInvoices([HOMES]))).toEqual(['jobber-none', 'jobber-air', 'xero-homes', 'xero-twin', 'console-homes', 'console-none']);
  });

  it('shows Jobber’s copies and the console’s while no company is read, and nothing read from Xero', () => {
    expect(shown(shownInvoices([]))).toEqual(['jobber-homes', 'jobber-twinned', 'jobber-none', 'jobber-air', 'console-homes', 'console-none']);
  });

  it('leaves out every invoice of a read company where the console must do nothing for them', () => {
    expect(shown(shownInvoices([HOMES], { outsideXeroBooks: true }))).toEqual(['jobber-none', 'jobber-air', 'console-none']);
  });

  it('keeps an invoice in Xero once it is read from there, or the console’s own once Xero has it (2026-11-12)', () => {
    const row = (id: string) => ROWS.find((candidate) => candidate.id === id)!;
    const kept = (id: string) => keptInXero({ origin: row(id).origin, xeroInvoiceId: row(id).xeroInvoiceId ?? null });
    expect(kept('xero-pest')).toBe(true);
    expect(kept('console-homes')).toBe(true);
    expect(kept('console-none')).toBe(false);
    expect(kept('jobber-homes')).toBe(false);
    expect(KEPT_IN_XERO).toMatch(/Change it there/);
  });

  it('knows which companies are read, when last, and each one’s short code for its links', async () => {
    const db = {
      xeroSettings: { findMany: jest.fn(async () => [{ xeroTenantId: HOMES, booksLastRunAt: new Date('2026-11-12T22:05:00.000Z') }]) },
      xeroOrganisation: {
        findMany: jest.fn(async () => [
          { xeroTenantId: HOMES, name: 'Example Home Services', organisation: { shortCode: '!abc12' } },
          { xeroTenantId: PEST, name: 'Example Pest Co', organisation: null },
        ]),
      },
    };
    const books = await officeXeroBooks(db as never, 'org-1');
    expect(books.read).toEqual([HOMES]);
    expect(books.shortCodes.get(HOMES)).toBe('!abc12');
    expect(books.shortCodes.get(PEST)).toBeNull();
    expect(books.companies).toEqual([{ tenantId: HOMES, name: 'Example Home Services', readAt: '2026-11-12T22:05:00.000Z' }]);
    expect(db.xeroSettings.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1', booksReadAt: { not: null } } }));
  });
});
