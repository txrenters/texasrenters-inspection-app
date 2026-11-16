import { nextXeroInvoiceNumbers } from '../src/admin/invoice-numbers';
import { XeroSettingsService } from '../src/integrations/xero/xero-settings.service';

/**
 * The console numbers the invoices it sends to Xero (2026-11-16): each
 * company's next, one above the highest of its numbers the console knows, and
 * shown on the New invoice before it is saved. Xero's Demo Company showed that
 * Xero steps past a number the console sent, and refuses one it has already.
 * The query itself was run on Postgres (PGlite) against THMP-, Pest- and
 * Demo-like numbers; these tests hold what is done with its answer. Ids and
 * names invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const HOMES = 'c1000000-0000-4000-8000-000000000001';
const PEST = 'c2000000-0000-4000-8000-000000000002';
const AIR = 'c3000000-0000-4000-8000-000000000003';

/** The database as the numbers query answers: each company's highest in its sequence, or nothing for one with none. */
function database(highest: Record<string, { prefix: string; digits: string } | null>) {
  const db = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, _organizationId: string, tenants: string[]) =>
      tenants.flatMap((tenant) => (highest[tenant] ? [{ tenant, ...highest[tenant] }] : [])),
    ),
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  return db;
}

describe('each company’s next number (2026-11-16)', () => {
  it('asks once, in the office’s scope, for every company together', async () => {
    const db = database({ [HOMES]: { prefix: 'INV-', digits: '5405' }, [PEST]: { prefix: 'INV-', digits: '3002' } });
    const next = await nextXeroInvoiceNumbers(db as never, ORG, [HOMES, PEST]);
    expect([...next]).toEqual([
      [HOMES, 'INV-5406'],
      [PEST, 'INV-3003'],
    ]);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect((db.$executeRaw.mock.calls[0] as unknown as [string[], string])[1]).toBe(ORG);
    const [strings, organizationId, tenants] = db.$queryRaw.mock.calls[0]!;
    expect(strings.join('?')).toContain('"xeroTenantId" = ANY(');
    expect([organizationId, tenants]).toEqual([ORG, [HOMES, PEST]]);
  });

  it('has none for a company the console knows no numbers of, and asks nothing when there is no company', async () => {
    const db = database({ [HOMES]: null });
    expect([...(await nextXeroInvoiceNumbers(db as never, ORG, [HOMES]))]).toEqual([]);
    expect([...(await nextXeroInvoiceNumbers(db as never, ORG, []))]).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('the New invoice (2026-11-16)', () => {
  /** Three connected companies; Homes and Pest send to Xero, Air does not. */
  const settingsService = (highest: Record<string, { prefix: string; digits: string } | null>) => {
    const numbers = database(highest);
    const company = (xeroTenantId: string, name: string) => ({
      xeroTenantId,
      sendFrom: null,
      salesAccountId: null,
      salesTaxType: null,
      salesAccounts: {},
      paymentAccounts: {},
      xeroOrganisation: { name, organisation: null, accounts: [], taxRates: [], trackingCategories: [], items: [] },
    });
    const db = {
      ...numbers,
      xeroConnection: { findUnique: jest.fn(async () => ({ status: 'CONNECTED' })) },
      xeroSettings: {
        findMany: jest.fn(async ({ where }: { where: { sendingEnabled?: boolean } }) =>
          where.sendingEnabled
            ? [{ xeroTenantId: HOMES }, { xeroTenantId: PEST }]
            : [company(AIR, 'Example Air'), company(HOMES, 'Example Home Services'), company(PEST, 'Example Pest Co')],
        ),
      },
      invoiceProduct: { findMany: jest.fn(async () => []) },
    };
    return { db, settings: new XeroSettingsService(db as never) };
  };

  it('shows each sending company’s next number, and none for a company that does not send or whose numbers are not known', async () => {
    const { db, settings } = settingsService({ [HOMES]: { prefix: 'INV-', digits: '5405' }, [PEST]: null, [AIR]: { prefix: 'AIR-', digits: '0012' } });
    const companies = await settings.invoiceForm(ORG);
    expect(companies.map((company) => [company.name, company.nextNumber])).toEqual([
      ['Example Air', null],
      ['Example Home Services', 'INV-5406'],
      ['Example Pest Co', null],
    ]);
    // Only the companies that send are asked about.
    expect(db.$queryRaw.mock.calls[0]![2]).toEqual([HOMES, PEST]);
  });
});
