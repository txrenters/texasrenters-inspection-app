import { Inject, Injectable } from '@nestjs/common';
import { UserRole, type Prisma } from '@prisma/client';
import {
  PURCHASING_ROLES,
  isSetupGrantablePermission,
  purchasingRole,
  requisitionerCode,
  resolveEffectivePermissions,
  type AddPurchasingPersonInput,
  type PurchasingPeople,
  type PurchasingPersonRow,
  type PurchasingRoleColumn,
  type PurchasingRoleHold,
  type PurchasingRoleKey,
  type SavePurchasingPersonInput,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Purchasing Setup's roles and who holds them (2026-11-21, part 5b), as the
 * approved board draws them: a person by person matrix of the eight purchasing
 * roles, each person's companies and, as an approver, their own limit.
 *
 * Each purchasing role is a real Role on the Roles page, marked with which it
 * is; the first time somebody is given one, Setup makes it with its starting
 * permissions. Guarded so a Purchasing admin hands out purchasing and nothing
 * else:
 * - only a role made of purchasing and inventory permissions is given here;
 * - only a system admin makes somebody a Purchasing admin;
 * - nobody changes their own row, and a system admin's is changed nowhere.
 * Every change is audited with what it was and what it became.
 */

const MOST_CENTS = 2_000_000_000;
const ENTITY = 'PurchasingSettings';

const isSystemAdmin = (user: AuthenticatedUser) => user.roles.some((role) => String(role) === UserRole.SYSTEM_ADMIN);

@Injectable()
export class PurchasingPeopleService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async people(user: AuthenticatedUser): Promise<PurchasingPeople> {
    const organizationId = user.organizationId;
    const [members, roles, rows, companies] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId },
        select: {
          role: true,
          userProfile: {
            select: {
              id: true,
              displayName: true,
              isActive: true,
              roleAssignments: { where: { organizationId }, select: { roleId: true, role: { select: { permissions: true } } } },
            },
          },
        },
      }),
      this.prisma.role.findMany({ where: { organizationId, purchasingRole: { not: null } }, select: { id: true, name: true, permissions: true, purchasingRole: true } }),
      this.prisma.purchasingPerson.findMany({ where: { organizationId }, select: { userProfileId: true, companyTenantIds: true, approvesAnyAmount: true, approvalLimitCents: true } }),
      this.prisma.xeroOrganisation.findMany({ where: { organizationId, status: 'CONNECTED' }, select: { xeroTenantId: true, name: true, purchaserCode: true }, orderBy: { name: 'asc' } }),
    ]);
    const columns = this.columns(user, roles);
    const settingsOf = new Map(rows.map((row) => [row.userProfileId, row]));

    // One entry a person: a person may be a member under more than one legacy role.
    const byPerson = new Map<string, { id: string; name: string; active: boolean; legacy: string[]; roleIds: string[]; permissions: string[] }>();
    for (const { role, userProfile: person } of members) {
      const seen = byPerson.get(person.id) ?? {
        id: person.id,
        name: person.displayName,
        active: person.isActive,
        legacy: [],
        roleIds: person.roleAssignments.map((one) => one.roleId),
        permissions: person.roleAssignments.flatMap((one) => one.role.permissions),
      };
      seen.legacy.push(role);
      byPerson.set(person.id, seen);
    }

    const people: PurchasingPersonRow[] = [];
    const candidates: PurchasingPeople['candidates'] = [];
    for (const person of byPerson.values()) {
      if (!person.active) continue;
      const held = resolveEffectivePermissions(person.legacy, person.permissions) as string[];
      const systemAdmin = person.legacy.includes(UserRole.SYSTEM_ADMIN);
      const row = settingsOf.get(person.id) ?? null;
      const holds = Object.fromEntries(
        columns.map((column) => {
          const hold: PurchasingRoleHold =
            column.roleId && person.roleIds.includes(column.roleId) ? 'ROLE' : column.permissions.length && column.permissions.every((permission) => held.includes(permission)) ? 'OTHER' : null;
          return [column.key, hold];
        }),
      ) as Record<PurchasingRoleKey, PurchasingRoleHold>;
      // On the list: anybody who holds a purchasing permission, or has been added in Setup.
      const listed = row || held.some((permission) => permission.startsWith('purchasing:'));
      if (!listed) {
        candidates.push({ id: person.id, name: person.name });
        continue;
      }
      people.push({
        id: person.id,
        name: person.name,
        code: requisitionerCode(person.name),
        roles: holds,
        systemAdmin,
        you: person.id === user.id,
        companyTenantIds: row?.companyTenantIds ?? [],
        approvesAnyAmount: row?.approvesAnyAmount ?? false,
        approvalLimitCents: row?.approvalLimitCents ?? null,
      });
    }
    people.sort((a, b) => a.name.localeCompare(b.name));
    candidates.sort((a, b) => a.name.localeCompare(b.name));
    return {
      people,
      roles: columns,
      companies: companies.map((company) => ({ tenantId: company.xeroTenantId, name: company.name, purchaserCode: company.purchaserCode })),
      candidates,
    };
  }

  /** Gives a person a purchasing role, or takes it away. The Role is made the first time it is given. */
  async setRole(user: AuthenticatedUser, personId: string, key: PurchasingRoleKey, held: boolean): Promise<PurchasingPeople> {
    const organizationId = user.organizationId;
    await this.assertChangeable(user, personId);
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.role.findFirst({ where: { organizationId, purchasingRole: key }, select: { id: true, name: true, permissions: true } });
      const [column] = this.columns(user, existing ? [{ ...existing, purchasingRole: key }] : []).filter((one) => one.key === key);
      if (!column!.grantable)
        throw new ApplicationError(
          403,
          'PURCHASING_ROLE_NOT_GRANTABLE',
          key === 'PURCHASING_ADMIN' && !isSystemAdmin(user)
            ? 'Only a system admin makes somebody a Purchasing admin.'
            : `The ${column!.roleName ?? column!.label} role holds more than purchasing and inventory permissions, so it is given on the Users page.`,
        );
      const roleId = existing?.id ?? (await this.makeRole(tx, organizationId, key));
      const had = Boolean(await tx.userRoleAssignment.findFirst({ where: { organizationId, userProfileId: personId, roleId }, select: { id: true } }));
      if (had === held) return;
      if (held) await tx.userRoleAssignment.create({ data: { organizationId, userProfileId: personId, roleId } });
      else await tx.userRoleAssignment.deleteMany({ where: { organizationId, userProfileId: personId, roleId } });
      await this.audit(tx, user, { person: personId, role: key, from: had, to: held });
    });
    return this.people(user);
  }

  /** A person's companies and approver limit. */
  async savePerson(user: AuthenticatedUser, personId: string, input: SavePurchasingPersonInput): Promise<PurchasingPeople> {
    const organizationId = user.organizationId;
    await this.assertChangeable(user, personId);
    if (input.approvesAnyAmount && input.approvalLimitCents !== null) throw new ApplicationError(400, 'PURCHASING_PERSON_INVALID', 'An approver approves any amount, or up to a limit: not both.');
    if (input.approvalLimitCents !== null && (!Number.isSafeInteger(input.approvalLimitCents) || input.approvalLimitCents <= 0 || input.approvalLimitCents > MOST_CENTS))
      throw new ApplicationError(400, 'PURCHASING_PERSON_INVALID', 'An approval limit is a dollar amount above zero.');
    const tenantIds = [...new Set(input.companyTenantIds)];
    if (tenantIds.length) {
      const known = await this.prisma.xeroOrganisation.count({ where: { organizationId, xeroTenantId: { in: tenantIds }, status: 'CONNECTED' } });
      if (known !== tenantIds.length) throw new ApplicationError(400, 'PURCHASING_PERSON_INVALID', 'A company chosen is not connected to this office.');
    }
    const to = { companyTenantIds: tenantIds, approvesAnyAmount: input.approvesAnyAmount, approvalLimitCents: input.approvalLimitCents };
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.purchasingPerson.findUnique({
        where: { organizationId_userProfileId: { organizationId, userProfileId: personId } },
        select: { companyTenantIds: true, approvesAnyAmount: true, approvalLimitCents: true },
      });
      const from = { companyTenantIds: before?.companyTenantIds ?? [], approvesAnyAmount: before?.approvesAnyAmount ?? false, approvalLimitCents: before?.approvalLimitCents ?? null };
      const same =
        before &&
        from.approvesAnyAmount === to.approvesAnyAmount &&
        from.approvalLimitCents === to.approvalLimitCents &&
        [...from.companyTenantIds].sort().join() === [...to.companyTenantIds].sort().join();
      if (same) return;
      await tx.purchasingPerson.upsert({ where: { organizationId_userProfileId: { organizationId, userProfileId: personId } }, create: { organizationId, userProfileId: personId, ...to }, update: to });
      await this.audit(tx, user, { person: personId, from, to });
    });
    return this.people(user);
  }

  /** "Add a person": somebody of the office not on the list yet, with no role and every company until Setup says otherwise. */
  async addPerson(user: AuthenticatedUser, input: AddPurchasingPersonInput): Promise<PurchasingPeople> {
    const organizationId = user.organizationId;
    await this.assertChangeable(user, input.userProfileId);
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.purchasingPerson.findUnique({ where: { organizationId_userProfileId: { organizationId, userProfileId: input.userProfileId } }, select: { userProfileId: true } });
      if (found) return;
      await tx.purchasingPerson.create({ data: { organizationId, userProfileId: input.userProfileId } });
      await this.audit(tx, user, { person: input.userProfileId, added: true });
    });
    return this.people(user);
  }

  // ── Guards ──────────────────────────────────────────────────────────────

  /** The columns, with what each holds and whether the caller may give it here. */
  private columns(user: AuthenticatedUser, roles: { id: string; name: string; permissions: string[]; purchasingRole: string | null }[]): PurchasingRoleColumn[] {
    return PURCHASING_ROLES.map((role) => {
      const found = roles.find((one) => one.purchasingRole === role.key);
      const permissions = found ? found.permissions : [...role.permissions];
      return {
        key: role.key,
        label: role.label,
        roleId: found?.id ?? null,
        roleName: found?.name ?? null,
        permissions,
        grantable: permissions.every(isSetupGrantablePermission) && (role.key !== 'PURCHASING_ADMIN' || isSystemAdmin(user)),
      };
    });
  }

  /** An active person of this office, not the caller, and not a system admin. */
  private async assertChangeable(user: AuthenticatedUser, personId: string) {
    if (personId === user.id) throw new ApplicationError(409, 'CANNOT_MODIFY_SELF', 'You cannot change your own purchasing roles, companies or limit.');
    const memberships = await this.prisma.organizationMember.findMany({ where: { organizationId: user.organizationId, userProfileId: personId }, select: { role: true, userProfile: { select: { isActive: true } } } });
    if (!memberships.length || !memberships[0]!.userProfile.isActive) throw new ApplicationError(404, 'PURCHASING_PERSON_NOT_FOUND', 'That person is not an active member of this office.');
    if (memberships.some((membership) => membership.role === UserRole.SYSTEM_ADMIN))
      throw new ApplicationError(409, 'SYSTEM_ADMIN_PROTECTED', 'A system admin holds everything, and is changed nowhere in the console.');
  }

  /** The Role that is this purchasing role, made with its starting permissions; named after it, or beside a name already taken. */
  private async makeRole(db: Prisma.TransactionClient, organizationId: string, key: PurchasingRoleKey): Promise<string> {
    const role = purchasingRole(key);
    const taken = await db.role.findFirst({ where: { organizationId, name: role.label }, select: { id: true } });
    const created = await db.role.create({
      data: {
        organizationId,
        name: taken ? `${role.label} (purchasing)` : role.label,
        description: 'Made by Purchasing Setup. Its permissions can be changed here on the Roles page.',
        permissions: [...role.permissions],
        purchasingRole: key,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async audit(db: Prisma.TransactionClient, user: AuthenticatedUser, change: object) {
    const metadata = JSON.parse(JSON.stringify({ section: 'people', ...change })) as Prisma.InputJsonObject;
    await db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action: 'PURCHASING_SETUP_CHANGED', entityType: ENTITY, entityId: user.organizationId, metadata } });
  }
}
