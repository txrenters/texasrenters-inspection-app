import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SEARCH_HITS_PER_KIND, SEARCH_KINDS, UserRole, type SearchKind } from '@texasrenters/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { visiblePurchaseOrders } from '../src/admin/purchase-orders.service';
import { visibleRequisitions } from '../src/admin/purchasing.service';
import { SearchController, SearchQueryDto } from '../src/admin/search.controller';
import { SEARCH_PERMISSIONS, SearchService } from '../src/admin/search.service';
import { shownInvoices, shownPayments } from '../src/admin/shown-invoices';
import { ANY_PERMISSIONS_METADATA_KEY, ApiAuthGuard, PERMISSIONS_METADATA_KEY, type AuthenticatedUser } from '../src/common/auth';

/**
 * The console's search for everything (the office, 2026-11-24): an invoice by
 * its number, a requisition, a purchase order, a vendor's bill, a stock item --
 * each only for an account that may read it. Names and addresses invented.
 */

const ORG = '61000000-0000-4000-8000-000000000001';
const EVERYTHING = [...new Set(Object.values(SEARCH_PERMISSIONS))];

const account = (permissions: string[], over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: '61000000-0000-4000-8000-000000000030',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Ada Lane',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: permissions as AuthenticatedUser['permissions'],
  mustChangePassword: false,
  principalType: 'USER',
  ...over,
});

/** The table each kind is read from. Technicians and users are both accounts. */
const TABLES = {
  inspection: 'inspection',
  job: 'job',
  property: 'propertywareBuilding',
  tenant: 'propertywareTenant',
  invoice: 'invoice',
  payment: 'invoicePayment',
  requisition: 'purchaseRequisition',
  purchaseOrder: 'purchaseOrder',
  stockItem: 'stockItem',
  vendor: 'vendor',
  technician: 'userProfile',
  user: 'userProfile',
} as const satisfies Record<SearchKind, string>;

function database() {
  const table = () => ({ findMany: jest.fn().mockResolvedValue([]) });
  return {
    // Which companies' books are read from Xero (2026-11-12): none here.
    xeroSettings: table(),
    inspection: table(),
    job: table(),
    propertywareBuilding: table(),
    propertywareTenant: table(),
    invoice: table(),
    invoicePayment: table(),
    purchaseRequisition: table(),
    purchaseOrder: table(),
    stockItem: table(),
    vendor: table(),
    userProfile: table(),
  };
}
type Database = ReturnType<typeof database>;
const searchOver = (db: Database) => new SearchService(db as never);
const asked = (db: Database, name: keyof Database) => db[name].findMany.mock.calls[0][0];
const reads = (db: Database) => Object.values(db).reduce((sum, entry) => sum + entry.findMany.mock.calls.length, 0);

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  number: '8439',
  jobNumber: '20600',
  clientName: '100 Example Way',
  totalCents: 3999,
  issuedOn: new Date('2026-10-21T00:00:00.000Z'),
  ...over,
});

describe('who is answered with what', () => {
  it('reads only the kinds the account may read', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue([invoice()]);

    const found = await searchOver(db).search(account(['invoices:read']), '8439');

    expect(found.groups.map((group) => group.kind)).toEqual(['invoice']);
    expect(db.invoice.findMany).toHaveBeenCalledTimes(1);
    expect(db.invoicePayment.findMany).toHaveBeenCalledTimes(1);
    for (const name of ['inspection', 'job', 'propertywareBuilding', 'propertywareTenant', 'purchaseRequisition', 'purchaseOrder', 'stockItem', 'vendor', 'userProfile'] as const)
      expect(db[name].findMany).not.toHaveBeenCalled();
  });

  it('reads nothing for an account with no permission at all', async () => {
    const db = database();
    expect(await searchOver(db).search(account([]), 'example')).toEqual({ groups: [] });
    expect(reads(db)).toBe(0);
  });

  it('asks each kind for the permission its own list asks for', () => {
    expect(SEARCH_PERMISSIONS).toEqual({
      inspection: 'inspections:read',
      job: 'inspections:read',
      property: 'properties:read',
      tenant: 'properties:read',
      invoice: 'invoices:read',
      payment: 'invoices:read',
      requisition: 'purchasing:request',
      purchaseOrder: 'purchasing:request',
      stockItem: 'inventory:read',
      vendor: 'inventory:read',
      technician: 'technicians:read',
      user: 'users:read',
    });
  });

  it('keeps every read inside the office of whoever asked', async () => {
    const db = database();
    await searchOver(db).search(account(EVERYTHING), 'example');

    for (const kind of SEARCH_KINDS.filter((entry) => entry !== 'technician' && entry !== 'user'))
      expect(asked(db, TABLES[kind]).where.organizationId).toBe(ORG);
    // Accounts belong to an office through their membership or their role.
    const [technicians, users] = db.userProfile.findMany.mock.calls.map(([args]) => args.where);
    expect(technicians.memberships.some.organizationId).toBe(ORG);
    expect(users.OR[0].memberships.some.organizationId).toBe(ORG);
    expect(users.OR[1].roleAssignments.some.organizationId).toBe(ORG);
  });

  it('lists the kinds in one order, and leaves out those with nothing found', async () => {
    const db = database();
    db.stockItem.findMany.mockResolvedValue([{ id: 'item-1', code: 'FLT-0012', name: 'Filter 16x25x1', unit: 'each', active: true }]);
    db.invoice.findMany.mockResolvedValue([invoice()]);

    const found = await searchOver(db).search(account(EVERYTHING), 'example');

    expect(found.groups.map((group) => group.kind)).toEqual(['invoice', 'stockItem']);
  });
});

describe('an invoice', () => {
  it('is found by its number wherever the digits fall, in any capitals, with or without the #', async () => {
    const db = database();
    await searchOver(db).search(account(['invoices:read']), '#inv-0042');

    const where = asked(db, 'invoice').where;
    expect(where.AND[0]).toEqual(shownInvoices([]));
    expect(where.AND[1].OR).toEqual(
      expect.arrayContaining([
        { number: { contains: 'inv-0042', mode: 'insensitive' } },
        { jobNumber: { contains: 'inv-0042', mode: 'insensitive' } },
        { clientName: { contains: 'inv-0042', mode: 'insensitive' } },
      ]),
    );
  });

  it('shows only the books the Invoices page shows', async () => {
    const db = database();
    db.xeroSettings.findMany.mockResolvedValue([{ xeroTenantId: 'tenant-a' }]);
    await searchOver(db).search(account(['invoices:read']), '8439');

    expect(asked(db, 'invoice').where.AND[0]).toEqual(shownInvoices(['tenant-a']));
    expect(asked(db, 'invoicePayment').where.AND[0]).toEqual(shownPayments(['tenant-a']));
    // Read once, for the invoices and the payments both.
    expect(db.xeroSettings.findMany).toHaveBeenCalledTimes(1);
  });

  it('puts the number typed whole ahead of the longer numbers that hold it', async () => {
    const db = database();
    db.invoice.findMany.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, index) => invoice({ id: `longer-${index}`, number: `${index + 1}8439` })),
      invoice({ id: 'starts', number: '84390' }),
      invoice({ id: 'whole', number: '8439' }),
    ]);

    const [group] = (await searchOver(db).search(account(['invoices:read']), '#8439')).groups;

    expect(group.hits).toHaveLength(SEARCH_HITS_PER_KIND);
    expect(group.hits.slice(0, 3).map((entry) => entry.id)).toEqual(['whole', 'starts', 'longer-0']);
    expect(group.hits[0]).toEqual({
      id: 'whole',
      targetId: 'whole',
      title: 'Invoice #8439 · 100 Example Way',
      detail: '$39.99 · Oct 21, 2026 · Job #20600',
    });
  });

  it('needs every word typed, each found somewhere', async () => {
    const db = database();
    await searchOver(db).search(account(['invoices:read']), 'example way');

    // The books, then one clause a word; "way" in either spelling.
    const [, example, way] = asked(db, 'invoice').where.AND;
    expect(example.OR).toContainEqual({ clientName: { contains: 'example', mode: 'insensitive' } });
    expect(way.OR).toEqual(expect.arrayContaining([{ clientName: { contains: 'way', mode: 'insensitive' } }, { clientName: { contains: 'wy', mode: 'insensitive' } }]));
  });

  it('brings its payments, by reference or by the invoice they paid', async () => {
    const db = database();
    db.invoicePayment.findMany.mockResolvedValue([
      { id: 'pay-1', reference: 'CHK-1044', amountCents: 3999, paidOn: new Date('2026-11-02T00:00:00.000Z'), method: 'CHECK', invoice: { number: '8439', clientName: '100 Example Way' } },
    ]);

    const found = await searchOver(db).search(account(['invoices:read']), 'chk-1044');

    expect(asked(db, 'invoicePayment').where.AND[1].OR).toEqual([
      { reference: { contains: 'chk-1044', mode: 'insensitive' } },
      { invoice: { is: { number: { contains: 'chk-1044', mode: 'insensitive' } } } },
      { invoice: { is: { clientName: { contains: 'chk-1044', mode: 'insensitive' } } } },
    ]);
    expect(found.groups[0]).toEqual({
      kind: 'payment',
      hits: [{ id: 'pay-1', targetId: 'pay-1', title: 'Payment $39.99 · 100 Example Way', detail: 'Nov 2, 2026 · Check · CHK-1044 · Invoice #8439' }],
    });
  });
});

describe('purchasing', () => {
  it("shows a requisitioner their own requisitions, and the orders made from them, and nobody else's", async () => {
    const db = database();
    const requester = account(['purchasing:request']);
    await searchOver(db).search(requester, 'PR-00043');

    expect(visibleRequisitions(requester)).toEqual({ requestedById: requester.id });
    expect(asked(db, 'purchaseRequisition').where.AND[0]).toEqual(visibleRequisitions(requester));
    expect(asked(db, 'purchaseOrder').where.AND[0]).toEqual(visiblePurchaseOrders(requester));
    expect(asked(db, 'purchaseOrder').where.AND[0].OR[0]).toEqual({ requisition: { requestedById: requester.id } });
  });

  it('shows whoever approves or orders everything submitted, and never another person’s draft', async () => {
    const db = database();
    const approver = account(['purchasing:request', 'purchasing:approve']);
    await searchOver(db).search(approver, 'PR-00043');

    expect(asked(db, 'purchaseRequisition').where.AND[0]).toEqual({ OR: [{ requestedById: approver.id }, { status: { not: 'DRAFT' } }] });
    expect(asked(db, 'purchaseOrder').where.AND[0]).toEqual({});
  });

  it("finds an order by its number, its vendor, its requisition or the number on the vendor's bill", async () => {
    const db = database();
    db.purchaseOrder.findMany.mockResolvedValue([
      { id: 'po-1', number: 'PO-0009', status: 'PARTLY_RECEIVED', vendor: { name: 'Example Supply Co' }, bill: { billNumber: 'B-7781' }, requisition: { number: 'PR-00043' } },
    ]);

    const found = await searchOver(db).search(account(['purchasing:request', 'purchasing:order']), 'b-7781');

    expect(asked(db, 'purchaseOrder').where.AND[1].OR).toEqual([
      { number: { contains: 'b-7781', mode: 'insensitive' } },
      { vendor: { is: { name: { contains: 'b-7781', mode: 'insensitive' } } } },
      { bill: { is: { billNumber: { contains: 'b-7781', mode: 'insensitive' } } } },
      { requisition: { number: { contains: 'b-7781', mode: 'insensitive' } } },
    ]);
    expect(found.groups.at(-1)).toEqual({
      kind: 'purchaseOrder',
      hits: [{ id: 'po-1', targetId: 'po-1', title: 'PO-0009 · Example Supply Co', detail: 'Partly received · Bill B-7781 · From PR-00043' }],
    });
  });

  it('names a draft that has no number yet', async () => {
    const db = database();
    db.purchaseRequisition.findMany.mockResolvedValue([{ id: 'pr-1', number: null, status: 'DRAFT', reason: 'Filters for December', requestedBy: { displayName: 'Ada Lane' } }]);

    const found = await searchOver(db).search(account(['purchasing:request']), 'filters');

    expect(found.groups[0].hits[0]).toMatchObject({ title: 'Draft requisition · Filters for December', detail: 'Draft · Ada Lane' });
  });
});

describe('stock', () => {
  it('finds an item by its code or its name, and a vendor by number, name or contact', async () => {
    const db = database();
    db.stockItem.findMany.mockResolvedValue([{ id: 'item-1', code: 'FLT-0012', name: 'Filter 16x25x1', unit: 'box', active: false }]);
    db.vendor.findMany.mockResolvedValue([{ id: 'vendor-1', number: 'V-00003', name: 'Example Supply Co', contactName: 'Sam Reed', active: true }]);

    const found = await searchOver(db).search(account(['inventory:read']), 'flt-0012');

    expect(asked(db, 'stockItem').where.AND[0].OR).toEqual([
      { code: { contains: 'flt-0012', mode: 'insensitive' } },
      { name: { contains: 'flt-0012', mode: 'insensitive' } },
    ]);
    expect(found.groups).toEqual([
      { kind: 'stockItem', hits: [{ id: 'item-1', targetId: 'item-1', title: 'FLT-0012 · Filter 16x25x1', detail: 'Counted by the box · No longer in use' }] },
      // A vendor has no page of its own: nothing to open but the list.
      { kind: 'vendor', hits: [{ id: 'vendor-1', targetId: null, title: 'Example Supply Co', detail: 'V-00003 · Sam Reed' }] },
    ]);
  });
});

describe('the records it always found', () => {
  it('finds inspections as their own list does, and says what each is', async () => {
    const db = database();
    db.inspection.findMany.mockResolvedValue([
      {
        id: 'insp-1',
        inspectionType: 'MOVE_OUT',
        scheduledAt: new Date('2026-11-24T00:00:00.000Z'),
        propertywareBuilding: { name: '100 Example Way' },
        propertywareUnit: { name: 'Unit B' },
        property: null,
        assignments: [{ technician: { displayName: 'Lee Park' } }],
      },
      { id: 'insp-2', inspectionType: 'HVAC', scheduledAt: new Date('2026-11-20T00:00:00.000Z'), propertywareBuilding: null, propertywareUnit: null, property: null, assignments: [] },
    ]);

    const found = await searchOver(db).search(account(['inspections:read']), '#20625');

    // Jobber's job number, whole: the rule the inspections list searches by.
    expect(asked(db, 'inspection').where.AND[0].OR).toContainEqual({ jobberJobNumber: '20625' });
    expect(found.groups[0].hits).toEqual([
      { id: 'insp-1', targetId: 'insp-1', title: '100 Example Way · Unit B', detail: 'Move out · Nov 24, 2026 · Lee Park' },
      { id: 'insp-2', targetId: 'insp-2', title: 'Property snapshot', detail: 'Hvac · Nov 20, 2026 · Unassigned' },
    ]);
  });

  it('finds the job itself by its number, as well as the visits on it', async () => {
    const db = database();
    db.job.findMany.mockResolvedValue([{ id: 'job-1', number: 'J-00042', title: 'Make ready', propertywareBuilding: { name: '100 Example Way' }, propertywareUnit: null }]);

    const found = await searchOver(db).search(account(['inspections:read']), 'j-00042');

    expect(asked(db, 'job').where.AND[0].OR).toContainEqual({ number: { contains: 'j-00042', mode: 'insensitive' } });
    expect(found.groups).toEqual([{ kind: 'job', hits: [{ id: 'job-1', targetId: 'job-1', title: 'J-00042 · Make ready', detail: '100 Example Way' }] }]);
  });

  it('shows the properties under management, and opens a tenant at their property', async () => {
    const db = database();
    db.propertywareTenant.findMany.mockResolvedValue([
      { id: 'tenant-1', leaseName: 'Robin Vale', addressLine1: '100 Example Way', city: 'Houston', building: { id: 'building-1' } },
      { id: 'tenant-2', leaseName: 'Robin Vance', addressLine1: null, city: null, building: null },
    ]);

    const found = await searchOver(db).search(account(['properties:read']), 'robin');

    expect(asked(db, 'propertywareBuilding').where).toMatchObject({ organizationId: ORG, isActive: true });
    // A property whose portfolio was closed is not on the Properties list either.
    expect(asked(db, 'propertywareBuilding').where.AND[0]).toEqual({ OR: [{ portfolioId: null }, { portfolio: { isActive: true } }] });
    expect(asked(db, 'propertywareTenant').where).toMatchObject({ organizationId: ORG, isActive: true });
    expect(found.groups[0].hits).toEqual([
      { id: 'tenant-1', targetId: 'building-1', title: 'Robin Vale', detail: '100 Example Way · Houston' },
      { id: 'tenant-2', targetId: null, title: 'Robin Vance', detail: '' },
    ]);
  });

  it('keeps somebody who is only a technician out of the users', async () => {
    const db = database();
    await searchOver(db).search(account(['technicians:read', 'users:read']), 'lee');

    const [technicians, users] = db.userProfile.findMany.mock.calls.map(([args]) => args.where);
    expect(technicians.memberships.some.role).toBe(UserRole.INSPECTION_TECHNICIAN);
    expect(users.OR[0].memberships.some.role.in).not.toContain(UserRole.INSPECTION_TECHNICIAN);
  });
});

describe('what one search costs', () => {
  it('is one read a kind and one for the books, however much matches, and five hits a kind', async () => {
    const db = database();
    // A busy office: every table answers with as many rows as it was asked for.
    const many = (take: number) => Array.from({ length: take }, (_, index) => `${index}`);
    db.inspection.findMany.mockImplementation(async ({ take }) =>
      many(take).map((id) => ({ id, inspectionType: 'OCCUPIED', scheduledAt: new Date('2026-11-24T00:00:00.000Z'), propertywareBuilding: { name: 'A' }, propertywareUnit: null, property: null, assignments: [] })),
    );
    db.job.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, number: `J-${id}`, title: 'T', propertywareBuilding: { name: 'A' }, propertywareUnit: null })));
    db.propertywareBuilding.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, name: 'A', addressLine1: null, city: null })));
    db.propertywareTenant.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, leaseName: 'A', addressLine1: null, city: null, building: null })));
    db.invoice.findMany.mockImplementation(async ({ take }) => many(take).map((id) => invoice({ id, number: `9${id}` })));
    db.invoicePayment.findMany.mockImplementation(async ({ take }) =>
      many(take).map((id) => ({ id, reference: null, amountCents: 1, paidOn: new Date('2026-11-02T00:00:00.000Z'), method: 'CASH', invoice: { number: null, clientName: 'A' } })),
    );
    db.purchaseRequisition.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, number: `PR-${id}`, status: 'SUBMITTED', reason: 'R', requestedBy: { displayName: 'A' } })));
    db.purchaseOrder.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, number: `PO-${id}`, status: 'SENT', vendor: null, bill: null, requisition: { number: null } })));
    db.stockItem.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, code: `C-${id}`, name: 'N', unit: 'each', active: true })));
    db.vendor.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, number: `V-${id}`, name: 'N', contactName: null, active: true })));
    db.userProfile.findMany.mockImplementation(async ({ take }) => many(take).map((id) => ({ id, displayName: 'A', email: 'a@example.com' })));

    const found = await searchOver(db).search(account(EVERYTHING), 'a');

    expect(found.groups.map((group) => group.kind)).toEqual([...SEARCH_KINDS]);
    for (const group of found.groups) expect(group.hits).toHaveLength(SEARCH_HITS_PER_KIND);
    // Twelve kinds and the companies' books: thirteen reads of the console's own database, and nothing else.
    expect(reads(db)).toBe(SEARCH_KINDS.length + 1);
    // No table is ever asked for more than a handful of rows.
    for (const entry of Object.values(db).filter((table) => table !== db.xeroSettings))
      for (const [args] of entry.findMany.mock.calls) expect(args.take).toBeLessThanOrEqual(20);
  });

  it('asks nothing when nothing searchable was typed', async () => {
    const db = database();
    expect(await searchOver(db).search(account(EVERYTHING), '# --')).toEqual({ groups: [] });
    expect(reads(db)).toBe(0);
  });
});

describe('the route', () => {
  const controllerOver = (service: { search: jest.Mock }) => new SearchController(service as never);

  it('is open to anybody signed in, the service deciding what each may read', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SearchController)).toEqual([ApiAuthGuard]);
    expect(Reflect.getMetadata(PERMISSIONS_METADATA_KEY, SearchController)).toBeUndefined();
    expect(Reflect.getMetadata(ANY_PERMISSIONS_METADATA_KEY, SearchController)).toBeUndefined();
  });

  it('answers nobody who has still to change their password', () => {
    const service = { search: jest.fn() };
    expect(() => controllerOver(service).search({ user: account(EVERYTHING, { mustChangePassword: true }) } as never, { q: 'example' })).toThrow(
      'A password change is required',
    );
    expect(service.search).not.toHaveBeenCalled();
  });

  it('passes on what was typed, for whoever typed it', async () => {
    const service = { search: jest.fn().mockResolvedValue({ groups: [] }) };
    const user = account(['invoices:read']);
    await controllerOver(service).search({ user } as never, { q: '8439' });
    expect(service.search).toHaveBeenCalledWith(user, '8439');
  });

  it('refuses a single letter, a paragraph, and nothing at all', async () => {
    const problems = async (q: unknown) => (await validate(plainToInstance(SearchQueryDto, { q }))).length;
    expect(await problems('  84  ')).toBe(0);
    expect(await problems(' a ')).toBe(1);
    expect(await problems('x'.repeat(121))).toBe(1);
    expect(await problems(undefined)).toBe(1);
  });
});
