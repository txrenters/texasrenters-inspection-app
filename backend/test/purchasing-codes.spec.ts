import { ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MACHINE_FORBIDDEN_PERMISSIONS, UserRole, type SavePurchaserCodeInput, type SavePurchasingCodeInput } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { PurchasingCodesController, SavePurchaserCodeDto, SavePurchasingCodeDto } from '../src/admin/purchasing-codes.controller';
import { PurchasingCodesService } from '../src/admin/purchasing-codes.service';

/**
 * Purchasing codes (2026-11-20, part 1 of the NAV-style requisition). Every
 * company, code and tracking option here is invented. The database's own
 * checks (capitals, unique in a list, one office) are run in migration checks;
 * this covers what the service decides and says.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const THMP = 'tenant-thmp';
const PEST = 'tenant-pest';

const admin = { id: id(800), authUserId: 'auth-1', organizationId: ORG, displayName: 'Code Admin', roles: [UserRole.SYSTEM_ADMIN], permissions: ['purchasing:codes'], mustChangePassword: false, principalType: 'USER' } as unknown as AuthenticatedUser;

type Row = Record<string, unknown>;
const unique = (target: string) => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target: [target] } });

function database(start: { lineTypes?: boolean } = {}) {
  const codes: Row[] =
    start.lineTypes === false
      ? []
      : [
          { id: id(1), organizationId: ORG, kind: 'LINE_TYPE', code: 'ITEM', name: 'Item', keepsStock: true, active: true },
          { id: id(2), organizationId: ORG, kind: 'LINE_TYPE', code: 'SERVICE', name: 'Service', keepsStock: false, active: true },
        ];
  const options: Row[] = [];
  const companies: Row[] = [
    {
      id: 'x1',
      organizationId: ORG,
      xeroTenantId: THMP,
      name: 'Example Home Services',
      purchaserCode: null,
      removedAt: null,
      trackingCategories: [
        { trackingCategoryId: 'cat-dept', name: 'Department', status: 'ACTIVE', options: [{ optionId: 'opt-maint', name: 'Maintenance', status: 'ACTIVE' }, { optionId: 'opt-old', name: 'Old', status: 'ARCHIVED' }] },
        { trackingCategoryId: 'cat-gone', name: 'Gone', status: 'ARCHIVED', options: [] },
      ],
    },
    { id: 'x2', organizationId: ORG, xeroTenantId: PEST, name: 'Example Pest', purchaserCode: 'PEST', removedAt: null, trackingCategories: null },
    { id: 'x3', organizationId: OTHER_ORG, xeroTenantId: 'tenant-theirs', name: 'Theirs', purchaserCode: null, removedAt: null, trackingCategories: [] },
  ];
  const stocked = new Set<string>();
  const audits: Row[] = [];
  const inOrg = (row: Row, where: Row) => row.organizationId === where.organizationId;

  const db = {
    purchasingCode: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => codes.find((row) => inOrg(row, where) && (where.id === undefined || row.id === where.id) && (where.kind === undefined || row.kind === where.kind)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        codes
          .filter((row) => inOrg(row, where) && (where.kind === undefined || row.kind === where.kind) && (where.active === undefined || row.active === where.active))
          .map((row) => ({ ...row, xeroOptions: options.filter((option) => option.codeId === row.id) })),
      ),
      count: jest.fn(async ({ where }: { where: Row & { id: { not: string } } }) => codes.filter((row) => inOrg(row, where) && row.kind === where.kind && row.active === where.active && row.id !== where.id.not).length),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        data.forEach((row, index) => codes.push({ id: id(50 + index), active: true, ...row }));
        return { count: data.length };
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (codes.some((row) => inOrg(row, data) && row.kind === data.kind && row.code === data.code)) throw unique('code');
        const row = { id: id(100 + codes.length), active: true, ...data };
        codes.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = codes.find((each) => each.id === where.id)!;
        if (data.code && codes.some((other) => other !== row && other.organizationId === row.organizationId && other.kind === row.kind && other.code === data.code)) throw unique('code');
        return Object.assign(row, data);
      }),
    },
    purchasingCodeXeroOption: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => options.push(...data)),
      deleteMany: jest.fn(async ({ where }: { where: Row }) => {
        for (let index = options.length - 1; index >= 0; index -= 1) if (options[index]!.codeId === where.codeId) options.splice(index, 1);
      }),
    },
    xeroOrganisation: {
      findMany: jest.fn(async ({ where }: { where: Row & { xeroTenantId?: { in: string[] } } }) => companies.filter((row) => inOrg(row, where) && (!where.xeroTenantId || where.xeroTenantId.in.includes(row.xeroTenantId as string)))),
      findFirst: jest.fn(async ({ where }: { where: Row }) => companies.find((row) => inOrg(row, where) && row.xeroTenantId === where.xeroTenantId) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = companies.find((each) => each.id === where.id)!;
        if (data.purchaserCode && companies.some((other) => other !== row && other.organizationId === row.organizationId && other.purchaserCode === data.purchaserCode)) throw unique('purchaserCode');
        return Object.assign(row, data);
      }),
    },
    stockItem: { groupBy: jest.fn(async () => [{ lineTypeId: id(1), _count: { _all: 12 } }]) },
    stockLevel: { findFirst: jest.fn(async ({ where }: { where: { item: { lineTypeId: string } } }) => (stocked.has(where.item.lineTypeId) ? { item: { code: 'FLT-16251' } } : null)) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  const client: unknown = Object.assign(db, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)) });
  return { codes, options, companies, audits, stocked, service: new PurchasingCodesService(client as never) };
}

describe('the lists', () => {
  it('start an office with Item and Service, and show how many item codes each type has', async () => {
    const { service, codes } = database({ lineTypes: false });
    const listed = await service.list(admin);
    expect(codes.map((row) => [row.code, row.keepsStock])).toEqual([
      ['ITEM', true],
      ['SERVICE', false],
    ]);
    expect(listed.codes.map((row) => row.code)).toEqual(['ITEM', 'SERVICE']);
  });

  it('show each company with the tracking options its Xero has in use, and nobody else\'s companies', async () => {
    const { service } = database();
    const { companies, codes } = await service.list(admin);
    expect(companies).toEqual([
      { xeroTenantId: THMP, name: 'Example Home Services', purchaserCode: null, trackingCategories: [{ id: 'cat-dept', name: 'Department', options: [{ id: 'opt-maint', name: 'Maintenance' }] }] },
      { xeroTenantId: PEST, name: 'Example Pest', purchaserCode: 'PEST', trackingCategories: [] },
    ]);
    expect(codes.find((row) => row.code === 'ITEM')!.used).toBe(12);
  });
});

describe('a new code', () => {
  it('is kept in capitals, on its own list, and audited', async () => {
    const { service, codes, audits } = database();
    await service.create(admin, { kind: 'REQUEST', code: ' restock ', name: '  Restock the  storeroom ' });
    expect(codes.at(-1)).toMatchObject({ kind: 'REQUEST', code: 'RESTOCK', name: 'Restock the storeroom', keepsStock: true });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASING_CODE_CREATED', metadata: { kind: 'REQUEST', code: 'RESTOCK' } });
    // The same letters on another list are another code.
    await service.create(admin, { kind: 'DEPARTMENT', code: 'RESTOCK', name: 'Restocking' });
    await expect(service.create(admin, { kind: 'REQUEST', code: 'RESTOCK', name: 'Again' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_TAKEN', message: 'RESTOCK is already on that list.' });
  });

  it('says what is wrong with one that will not do', async () => {
    const { service } = database();
    await expect(service.create(admin, { code: 'X', name: 'No list' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_INCOMPLETE' });
    await expect(service.create(admin, { kind: 'REQUEST', code: 'NOT/OK', name: 'Bad' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_INVALID' });
    await expect(service.create(admin, { kind: 'REQUEST', code: 'OK', name: '   ' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_INCOMPLETE' });
  });

  it('makes a line type that keeps no stock when asked', async () => {
    const { service, codes } = database();
    await service.create(admin, { kind: 'LINE_TYPE', code: 'FEE', name: 'Fee or charge', keepsStock: false });
    expect(codes.at(-1)).toMatchObject({ code: 'FEE', keepsStock: false });
  });
});

describe('matching a code to Xero tracking', () => {
  it('keeps the option a company\'s Xero has, and shows it by its name', async () => {
    const { service } = database();
    const listed = await service.create(admin, { kind: 'DEPARTMENT', code: 'MAINT', name: 'Maintenance', xero: [{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint' }] });
    expect(listed.codes.find((row) => row.code === 'MAINT')!.xero).toEqual([{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint', label: 'Department: Maintenance' }]);
  });

  it('refuses an option the catalog does not have in use, another office\'s company, two for one company, and a list that is not tracked', async () => {
    const { service } = database();
    const make = (xero: SavePurchasingCodeInput['xero'], kind: SavePurchasingCodeInput['kind'] = 'DEPARTMENT') => service.create(admin, { kind, code: 'D1', name: 'Dept', xero });
    await expect(make([{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-old' }])).rejects.toMatchObject({ code: 'XERO_TRACKING_NOT_FOUND' });
    await expect(make([{ xeroTenantId: 'tenant-theirs', trackingCategoryId: 'c', trackingOptionId: 'o' }])).rejects.toMatchObject({ code: 'COMPANY_NOT_FOUND' });
    await expect(make([{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint' }, { xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint' }])).rejects.toMatchObject({ code: 'PURCHASING_CODE_XERO_TWICE' });
    await expect(make([{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint' }], 'REQUEST')).rejects.toMatchObject({ code: 'PURCHASING_CODE_NOT_TRACKED' });
  });

  it('is replaced whole when changed, and taken away when sent empty', async () => {
    const { service, options } = database();
    await service.create(admin, { kind: 'COST_CENTER', code: 'CC1', name: 'Cost center', xero: [{ xeroTenantId: THMP, trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint' }] });
    const made = (await service.list(admin)).codes.find((row) => row.code === 'CC1')!;
    expect(options).toHaveLength(1);
    await service.update(admin, made.id, { xero: [] });
    expect(options).toHaveLength(0);
  });
});

describe('changing a code', () => {
  it('renames it, and keeps it on its list', async () => {
    const { service, codes, audits } = database();
    await service.update(admin, id(2), { code: 'svc', name: 'Service work' });
    expect(codes.find((row) => row.id === id(2))).toMatchObject({ code: 'SVC', name: 'Service work' });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASING_CODE_CHANGED', metadata: { changes: ['code SERVICE -> SVC', 'name'] } });
    await expect(service.update(admin, id(2), { kind: 'REQUEST' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_KIND_FIXED' });
    await expect(service.update(admin, id(2), { code: 'ITEM' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_TAKEN' });
  });

  it('keeps one line type in use, and keeps a type with stock on hand keeping stock', async () => {
    const { service, stocked } = database();
    await service.update(admin, id(2), { active: false });
    await expect(service.update(admin, id(1), { active: false })).rejects.toMatchObject({ code: 'LINE_TYPE_LAST' });
    stocked.add(id(1));
    await expect(service.update(admin, id(1), { keepsStock: false })).rejects.toMatchObject({ code: 'LINE_TYPE_HAS_STOCK' });
  });

  it('is not found in another office', async () => {
    const { service } = database();
    await expect(service.update({ ...admin, organizationId: OTHER_ORG } as AuthenticatedUser, id(1), { name: 'X' })).rejects.toMatchObject({ code: 'PURCHASING_CODE_NOT_FOUND' });
  });
});

describe('a company\'s purchaser code', () => {
  it('is set in capitals, refused when another company has it, and taken away with null', async () => {
    const { service, companies, audits } = database();
    await service.setPurchaserCode(admin, THMP, { purchaserCode: 'thmp' });
    expect(companies[0]).toMatchObject({ purchaserCode: 'THMP' });
    expect(audits.at(-1)).toMatchObject({ action: 'PURCHASER_CODE_CHANGED', metadata: { from: null, to: 'THMP' } });
    await expect(service.setPurchaserCode(admin, THMP, { purchaserCode: 'PEST' })).rejects.toMatchObject({ code: 'PURCHASER_CODE_TAKEN' });
    await service.setPurchaserCode(admin, THMP, { purchaserCode: null });
    expect(companies[0]).toMatchObject({ purchaserCode: null });
    await expect(service.setPurchaserCode(admin, 'tenant-theirs', { purchaserCode: 'X' })).rejects.toMatchObject({ code: 'COMPANY_NOT_FOUND' });
  });
});

describe('the routes', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown, metatype: new () => object) => pipe.transform(body, { type: 'body', metatype });

  it('name every field of their contracts, and nothing else', async () => {
    const code: Required<SavePurchasingCodeInput> = { kind: 'DEPARTMENT', code: 'maint', name: 'Maintenance', keepsStock: true, active: true, xero: [{ xeroTenantId: THMP, trackingCategoryId: 'c', trackingOptionId: 'o' }] };
    const purchaser: Required<SavePurchaserCodeInput> = { purchaserCode: 'THMP' };
    await expect(check(code, SavePurchasingCodeDto)).resolves.toBeDefined();
    await expect(check(purchaser, SavePurchaserCodeDto)).resolves.toBeDefined();
    await expect(check({ purchaserCode: null }, SavePurchaserCodeDto)).resolves.toBeDefined();
    await expect(check({ ...code, organizationId: OTHER_ORG }, SavePurchasingCodeDto)).rejects.toBeTruthy();
    await expect(check({ ...code, kind: 'SOMETHING' }, SavePurchasingCodeDto)).rejects.toBeTruthy();
  });

  it('need "Manage purchasing codes", which no API key may hold', () => {
    for (const handler of ['list', 'create', 'update', 'setPurchaserCode'] as const)
      expect(Reflect.getMetadata('permissions', PurchasingCodesController.prototype[handler])).toEqual(['purchasing:codes']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('purchasing:codes');
  });
});
