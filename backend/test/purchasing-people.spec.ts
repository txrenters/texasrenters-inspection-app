import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AddPurchasingPersonInput, SavePurchasingPersonInput, SetPurchasingRoleInput } from '@texasrenters/shared';

import { AddPurchasingPersonDto, PurchasingSetupController, SavePurchasingPersonDto, SetPurchasingRoleDto } from '../src/admin/purchasing-setup.controller';
import { PurchasingPeopleService } from '../src/admin/purchasing-people.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Purchasing Setup, part 5b (2026-11-21): the roles and who holds them, each
 * person's companies and approver limit. Every name, code and figure invented.
 */

const ORG = '80000000-0000-4000-8000-000000000001';
const THMP = 'tenant-thmp';
const CCP = 'tenant-ccp';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caller = (n: number, roles: UserRole[] = [UserRole.PROPERTY_ADMIN]): AuthenticatedUser =>
  ({ id: id(n), authUserId: `auth-${n}`, organizationId: ORG, displayName: 'Sample Admin', roles, permissions: ['purchasing:request', 'purchasing:setup'], mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const ADMIN = caller(1);
const SYSTEM = caller(2, [UserRole.SYSTEM_ADMIN]);

type Row = Record<string, unknown>;

function office() {
  const people = [
    { id: id(1), displayName: 'Sample Admin', isActive: true, legacy: [UserRole.PROPERTY_ADMIN] },
    { id: id(2), displayName: 'Sample System', isActive: true, legacy: [UserRole.SYSTEM_ADMIN] },
    { id: id(3), displayName: 'Pat Sample', isActive: true, legacy: [UserRole.PROPERTY_ADMIN] },
    { id: id(4), displayName: 'Lee Sample', isActive: true, legacy: [UserRole.PROPERTY_ADMIN] },
    { id: id(5), displayName: 'Gone Sample', isActive: false, legacy: [UserRole.PROPERTY_ADMIN] },
  ];
  // An office Admin role holding purchasing through the back door, and Pat already given it.
  const roles: Row[] = [{ id: id(50), name: 'Admin', permissions: ['users:manage', 'purchasing:request', 'purchasing:approve'], purchasingRole: null }];
  const assignments: Row[] = [{ id: id(60), userProfileId: id(3), roleId: id(50) }];
  const persons: Row[] = [];
  const audits: Row[] = [];
  const memberRows = (userProfileId?: string) =>
    people
      .filter((person) => !userProfileId || person.id === userProfileId)
      .flatMap((person) =>
        person.legacy.map((role) => ({
          role,
          userProfile: {
            id: person.id,
            displayName: person.displayName,
            isActive: person.isActive,
            roleAssignments: assignments.filter((one) => one.userProfileId === person.id).map((one) => ({ roleId: one.roleId, role: { permissions: roles.find((role) => role.id === one.roleId)!.permissions } })),
          },
        })),
      );
  const db = {
    organizationMember: { findMany: jest.fn(async ({ where }: { where: { userProfileId?: string } }) => memberRows(where.userProfileId)) },
    role: {
      findMany: jest.fn(async () => roles.filter((role) => role.purchasingRole)),
      findFirst: jest.fn(async ({ where }: { where: Row }) => roles.find((role) => (where.purchasingRole ? role.purchasingRole === where.purchasingRole : role.name === where.name)) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const role = { id: id(70 + roles.length), ...data };
        roles.push(role);
        return role;
      }),
    },
    userRoleAssignment: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => assignments.find((one) => one.userProfileId === where.userProfileId && one.roleId === where.roleId) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => assignments.push({ id: id(80 + assignments.length), ...data })),
      deleteMany: jest.fn(async ({ where }: { where: Row }) => {
        for (let index = assignments.length - 1; index >= 0; index -= 1) if (assignments[index]!.userProfileId === where.userProfileId && assignments[index]!.roleId === where.roleId) assignments.splice(index, 1);
      }),
    },
    // The departments an approver may be given (2026-11-21).
    purchasingCode: {
      findMany: jest.fn(async () => [{ id: id(61), code: 'MAINT', name: 'Maintenance' }]),
      count: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((one) => one === id(61)).length),
    },
    purchasingPerson: {
      findMany: jest.fn(async () => persons),
      findUnique: jest.fn(async ({ where }: { where: { organizationId_userProfileId: { userProfileId: string } } }) => persons.find((row) => row.userProfileId === where.organizationId_userProfileId.userProfileId) ?? null),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        const found = persons.find((row) => row.userProfileId === create.userProfileId);
        if (found) Object.assign(found, update);
        else persons.push({ companyTenantIds: [], approvesAnyAmount: false, approvalLimitCents: null, ...create });
      }),
      create: jest.fn(async ({ data }: { data: Row }) => persons.push({ companyTenantIds: [], approvesAnyAmount: false, approvalLimitCents: null, ...data })),
    },
    xeroOrganisation: {
      findMany: jest.fn(async () => [
        { xeroTenantId: CCP, name: 'Crystal Creek Pest', purchaserCode: 'CCP' },
        { xeroTenantId: THMP, name: 'Texas Home Maintenance Pros', purchaserCode: 'THMP' },
      ]),
      count: jest.fn(async ({ where }: { where: { xeroTenantId: { in: string[] } } }) => where.xeroTenantId.in.filter((tenant) => [THMP, CCP].includes(tenant)).length),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  const client: unknown = Object.assign(db, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) });
  return { roles, assignments, persons, audits, service: new PurchasingPeopleService(client as never) };
}

describe('the roles and who holds them', () => {
  it('lists whoever holds purchasing -- by the role itself, or through another -- and offers the rest of the office to add', async () => {
    const { service } = office();
    const seen = await service.people(ADMIN);
    expect(seen.people.map((person) => [person.name, person.code, person.systemAdmin, person.you])).toEqual([
      ['Pat Sample', 'PSAMPLE', false, false],
      ['Sample System', 'SSYSTEM', true, false],
    ]);
    // Pat approves through the office's Admin role, not through Setup's Approver role.
    expect(seen.people[0]!.roles).toMatchObject({ REQUISITIONER: 'OTHER', APPROVER: 'OTHER', PURCHASER: null });
    expect(seen.people[1]!.roles).toMatchObject({ PURCHASING_ADMIN: 'OTHER', STOCK_KEEPER: 'OTHER' });
    expect(seen.candidates.map((person) => person.name)).toEqual(['Lee Sample', 'Sample Admin']);
    expect(seen.roles.map((role) => [role.label, role.roleId, role.grantable])).toEqual([
      ['Requisitioner', null, true],
      ['Purchaser', null, true],
      ['Approver', null, true],
      ['Purchasing manager', null, true],
      ['Stock keeper', null, true],
      ['Receiver', null, true],
      ['Code admin', null, true],
      ['Bill payer', null, true],
      ['Purchasing admin', null, false],
    ]);
  });

  it('makes the role on the Roles page the first time it is given, gives and takes it, and audits each change', async () => {
    const { service, roles, assignments, audits } = office();
    await service.setRole(ADMIN, id(4), 'APPROVER', true);
    expect(roles.at(-1)).toMatchObject({ name: 'Approver', permissions: ['purchasing:request', 'purchasing:approve'], purchasingRole: 'APPROVER' });
    expect(assignments.at(-1)).toMatchObject({ organizationId: ORG, userProfileId: id(4), roleId: roles.at(-1)!.id });
    expect(audits).toEqual([expect.objectContaining({ action: 'PURCHASING_SETUP_CHANGED', actorUserId: ADMIN.id, metadata: { section: 'people', person: id(4), role: 'APPROVER', from: false, to: true } })]);

    // Given again: nothing written. Taken away: one more entry.
    await service.setRole(ADMIN, id(4), 'APPROVER', true);
    expect(audits).toHaveLength(1);
    const seen = await service.setRole(ADMIN, id(4), 'APPROVER', false);
    expect(assignments.filter((one) => one.userProfileId === id(4))).toEqual([]);
    expect(audits).toHaveLength(2);
    // Lee was added by being given a role, and stays on the list with none.
    expect(seen.roles.find((role) => role.key === 'APPROVER')).toMatchObject({ roleId: roles.at(-1)!.id, roleName: 'Approver' });
  });

  it('names a new role beside one already called the same', async () => {
    const { service, roles } = office();
    roles.push({ id: id(51), name: 'Purchaser', permissions: ['dashboard:read'], purchasingRole: null });
    await service.setRole(ADMIN, id(4), 'PURCHASER', true);
    expect(roles.at(-1)).toMatchObject({ name: 'Purchaser (purchasing)', purchasingRole: 'PURCHASER' });
  });

  it('hands out purchasing and nothing else: never a widened role, never Purchasing admin but by a system admin, never to oneself or a system admin', async () => {
    const { service, roles, audits } = office();
    roles.push({ id: id(52), name: 'Approver', permissions: ['purchasing:approve', 'users:manage'], purchasingRole: 'APPROVER' });
    await expect(service.setRole(ADMIN, id(4), 'APPROVER', true)).rejects.toMatchObject({ code: 'PURCHASING_ROLE_NOT_GRANTABLE', message: 'The Approver role holds more than purchasing and inventory permissions, so it is given on the Users page.' });
    await expect(service.setRole(ADMIN, id(4), 'PURCHASING_ADMIN', true)).rejects.toMatchObject({ code: 'PURCHASING_ROLE_NOT_GRANTABLE', message: 'Only a system admin makes somebody a Purchasing admin.' });
    await expect(service.setRole(ADMIN, ADMIN.id, 'PURCHASER', true)).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
    await expect(service.setRole(ADMIN, id(2), 'PURCHASER', true)).rejects.toMatchObject({ code: 'SYSTEM_ADMIN_PROTECTED' });
    await expect(service.setRole(ADMIN, id(5), 'PURCHASER', true)).rejects.toMatchObject({ code: 'PURCHASING_PERSON_NOT_FOUND' });
    expect(audits).toEqual([]);

    await service.setRole(SYSTEM, id(4), 'PURCHASING_ADMIN', true);
    expect(roles.at(-1)).toMatchObject({ purchasingRole: 'PURCHASING_ADMIN', permissions: ['purchasing:request', 'purchasing:setup'] });
  });

  // 2026-11-21, the office: an approver approves the requisitions of the departments ticked for them.
  it("keeps an approver's departments, only of the office's department codes, and leaves them be when a save gives none", async () => {
    const { service } = office();
    const seen = await service.savePerson(ADMIN, id(3), { companyTenantIds: [], departmentIds: [id(61)], approvesAnyAmount: false, approvalLimitCents: null });
    expect(seen.departments).toEqual([{ id: id(61), code: 'MAINT', name: 'Maintenance' }]);
    expect(seen.people.find((person) => person.id === id(3))).toMatchObject({ departmentIds: [id(61)] });
    const kept = await service.savePerson(ADMIN, id(3), { companyTenantIds: [THMP], approvesAnyAmount: false, approvalLimitCents: null });
    expect(kept.people.find((person) => person.id === id(3))).toMatchObject({ departmentIds: [id(61)], companyTenantIds: [THMP] });
    await expect(service.savePerson(ADMIN, id(3), { companyTenantIds: [], departmentIds: [id(62)], approvesAnyAmount: false, approvalLimitCents: null })).rejects.toMatchObject({ code: 'PURCHASING_PERSON_INVALID' });
  });

  it("keeps a person's companies and limit -- any amount, or up to one, never both -- and audits what they were and became", async () => {
    const { service, persons, audits } = office();
    const input = (over: Partial<SavePurchasingPersonInput> = {}): SavePurchasingPersonInput => ({ companyTenantIds: [THMP], approvesAnyAmount: false, approvalLimitCents: 500000, ...over });
    const seen = await service.savePerson(ADMIN, id(3), input());
    expect(seen.people.find((person) => person.id === id(3))).toMatchObject({ companyTenantIds: [THMP], approvalLimitCents: 500000, approvesAnyAmount: false });
    expect(audits).toEqual([expect.objectContaining({ metadata: { section: 'people', person: id(3), from: { companyTenantIds: [], departmentIds: [], approvesAnyAmount: false, approvalLimitCents: null }, to: { ...input(), departmentIds: [] } } })]);
    await service.savePerson(ADMIN, id(3), input());
    expect(audits).toHaveLength(1);

    await expect(service.savePerson(ADMIN, id(3), input({ approvesAnyAmount: true }))).rejects.toMatchObject({ code: 'PURCHASING_PERSON_INVALID' });
    await expect(service.savePerson(ADMIN, id(3), input({ companyTenantIds: ['tenant-elsewhere'] }))).rejects.toMatchObject({ code: 'PURCHASING_PERSON_INVALID' });
    await expect(service.savePerson(ADMIN, ADMIN.id, input())).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
    expect(persons).toHaveLength(1);
  });

  it('adds a person to the list with no role, acting for every company', async () => {
    const { service } = office();
    const seen = await service.addPerson(ADMIN, { userProfileId: id(4) });
    expect(seen.people.find((person) => person.id === id(4))).toMatchObject({ companyTenantIds: [], approvalLimitCents: null, roles: { REQUISITIONER: null } });
    expect(seen.candidates.map((person) => person.name)).toEqual(['Sample Admin']);
  });
});

describe('the people routes', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown, metatype: new () => object) => pipe.transform(value, { type: 'body', metatype });

  it('name every field, refuse one they do not know, and need a Purchasing admin', async () => {
    const person: Required<SavePurchasingPersonInput> = { companyTenantIds: [THMP], departmentIds: [id(61)], approvesAnyAmount: false, approvalLimitCents: 500000 };
    const role: Required<SetPurchasingRoleInput> = { held: true };
    const add: Required<AddPurchasingPersonInput> = { userProfileId: id(4) };
    await expect(check(person, SavePurchasingPersonDto)).resolves.toBeDefined();
    await expect(check(role, SetPurchasingRoleDto)).resolves.toBeDefined();
    await expect(check(add, AddPurchasingPersonDto)).resolves.toBeDefined();
    await expect(check({ ...person, permissions: ['users:manage'] }, SavePurchasingPersonDto)).rejects.toBeDefined();
    await expect(check({ ...person, approvalLimitCents: 0 }, SavePurchasingPersonDto)).rejects.toBeDefined();
    for (const route of ['readPeople', 'addPerson', 'savePerson', 'setRole'])
      expect(Reflect.getMetadata('permissions', (PurchasingSetupController.prototype as unknown as Record<string, object>)[route]!)).toEqual(['purchasing:setup']);
  });
});
