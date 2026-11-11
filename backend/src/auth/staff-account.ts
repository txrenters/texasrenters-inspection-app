import { UserRole } from '@prisma/client';

/**
 * Whether an account is office staff: someone who uses the console.
 *
 * The same line `AccessService` draws with `CONSOLE_ROLES` — a console
 * membership, or any custom role — less the property-owner label, because an
 * owner reading a report is not staff. A pure technician is not staff either:
 * the phone is their app, and the console refuses them.
 *
 * Kept here, not imported from admin/, so sign-in does not depend on the
 * user-management module.
 */
const NOT_STAFF: ReadonlySet<UserRole> = new Set([
  UserRole.INSPECTION_TECHNICIAN,
  UserRole.PROPERTY_OWNER_READ_ONLY,
]);

/** What `isStaffAccount` reads. Select it inside `withSystemTenant`: both relations are tenant-scoped. */
export const STAFF_ACCOUNT_SELECT = {
  memberships: { select: { organizationId: true, role: true } },
  roleAssignments: { select: { organizationId: true } },
} as const;

export interface StaffAccountShape {
  memberships: { organizationId: string; role: UserRole }[];
  roleAssignments: { organizationId: string }[];
}

export function isStaffAccount(account: StaffAccountShape) {
  return (
    account.memberships.some((membership) => !NOT_STAFF.has(membership.role)) ||
    account.roleAssignments.length > 0
  );
}

/** The organization a staff account's audit rows belong to. */
export function staffOrganizationOf(account: StaffAccountShape): string | undefined {
  return (
    account.memberships.find((membership) => !NOT_STAFF.has(membership.role))?.organizationId ??
    account.roleAssignments[0]?.organizationId ??
    account.memberships[0]?.organizationId
  );
}
