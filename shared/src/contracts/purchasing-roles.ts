/**
 * Purchasing Setup, part 5b (2026-11-21): the roles and who holds them, as the
 * approved PurchasingSetup board draws them.
 *
 * Each purchasing role is a real Role on the console's Roles page, marked with
 * which purchasing role it is; Setup makes it, with the permissions below, the
 * first time somebody is given it, and the office may change its permissions
 * on the Roles page. Each person also has the companies they act for (all, or
 * some) and, as an approver, their own limit.
 *
 * A company limit restricts what a person ACTS on -- making requisitions,
 * approving (when the office says so), ordering, receiving, bills -- never
 * what they can read. Nothing here calls anything billed.
 */
import { formatMoney } from './invoices.js';
import { approvalStepFor, approvalStepFromCents, type ApprovalStep } from './purchasing-setup.js';

export const PURCHASING_ROLES = [
  { key: 'REQUISITIONER', label: 'Requisitioner', permissions: ['purchasing:request'] },
  { key: 'PURCHASER', label: 'Purchaser', permissions: ['purchasing:request', 'purchasing:order'] },
  { key: 'APPROVER', label: 'Approver', permissions: ['purchasing:request', 'purchasing:approve'] },
  { key: 'STOCK_KEEPER', label: 'Stock keeper', permissions: ['inventory:read', 'inventory:manage', 'inventory:withdraw', 'inventory:count'] },
  { key: 'RECEIVER', label: 'Receiver', permissions: ['purchasing:request', 'purchasing:receive', 'inventory:read'] },
  { key: 'CODE_ADMIN', label: 'Code admin', permissions: ['purchasing:request', 'purchasing:codes'] },
  { key: 'BILL_PAYER', label: 'Bill payer', permissions: ['purchasing:request', 'purchasing:bills'] },
  { key: 'PURCHASING_ADMIN', label: 'Purchasing admin', permissions: ['purchasing:request', 'purchasing:setup'] },
] as const;
export type PurchasingRoleKey = (typeof PURCHASING_ROLES)[number]['key'];
export const PURCHASING_ROLE_KEYS = PURCHASING_ROLES.map((role) => role.key) as readonly PurchasingRoleKey[];
export const isPurchasingRoleKey = (value: string): value is PurchasingRoleKey => (PURCHASING_ROLE_KEYS as readonly string[]).includes(value);
export const purchasingRole = (key: PurchasingRoleKey) => PURCHASING_ROLES.find((role) => role.key === key)!;

/**
 * What a Purchasing admin may hand out from Setup: a role made only of
 * purchasing and inventory permissions. A role the office has widened on the
 * Roles page beyond these is given from the Users page, by whoever may.
 */
export const isSetupGrantablePermission = (permission: string) => permission.startsWith('purchasing:') || permission.startsWith('inventory:');

/** How a person holds a purchasing role: through the role itself, or its permissions through another role (an Admin, a system admin). */
export type PurchasingRoleHold = 'ROLE' | 'OTHER' | null;

export interface PurchasingPersonRow {
  id: string;
  name: string;
  /** The requisitioner ID: "ESAAVEDRA". */
  code: string;
  roles: Record<PurchasingRoleKey, PurchasingRoleHold>;
  /** A system admin holds everything, and is changed nowhere in the console. */
  systemAdmin: boolean;
  /** The caller: nobody changes their own row. */
  you: boolean;
  /** The companies they act for, by Xero tenant; empty is every company. */
  companyTenantIds: string[];
  /** As an approver: any amount, or up to a limit; neither, the approval steps decide. */
  approvesAnyAmount: boolean;
  approvalLimitCents: number | null;
}

export interface PurchasingRoleColumn {
  key: PurchasingRoleKey;
  label: string;
  /** The Role on the Roles page that is this purchasing role; null until somebody is first given it. */
  roleId: string | null;
  roleName: string | null;
  permissions: string[];
  /** Whether the caller may give or take it here: only purchasing and inventory permissions, and Purchasing admin only by a system admin. */
  grantable: boolean;
}

export interface PurchasingPeople {
  people: PurchasingPersonRow[];
  roles: PurchasingRoleColumn[];
  companies: { tenantId: string; name: string; purchaserCode: string | null }[];
  /** Active people of the office not on the list yet, for "Add a person". */
  candidates: { id: string; name: string }[];
}

export interface SetPurchasingRoleInput {
  held: boolean;
}

export interface SavePurchasingPersonInput {
  companyTenantIds: string[];
  approvesAnyAmount: boolean;
  approvalLimitCents: number | null;
}

export interface AddPurchasingPersonInput {
  userProfileId: string;
}

/** "THMP, CCP", or "All". */
export function companiesSaying(tenantIds: readonly string[], companies: readonly { tenantId: string; name: string; purchaserCode: string | null }[]): string {
  if (!tenantIds.length) return 'All';
  return tenantIds.map((tenantId) => companies.find((company) => company.tenantId === tenantId)).map((company) => company?.purchaserCode || company?.name || 'A company no longer connected').join(', ');
}

/** "any amount", "to $5,000.00", or blank when the steps decide. */
export function approverLimitSaying(person: Pick<PurchasingPersonRow, 'approvesAnyAmount' | 'approvalLimitCents'>): string {
  return person.approvesAnyAmount ? 'any amount' : person.approvalLimitCents !== null ? `to ${formatMoney(person.approvalLimitCents)}` : '';
}

// ── Standing: what a person may act on ───────────────────────────────────────

/**
 * Everything the purchasing rules need to know about one person: their
 * permissions, the companies they act for (null = every one) and their limit.
 */
export interface PurchasingStanding {
  permissions: readonly string[];
  companies: readonly string[] | null;
  /** May approve any amount: the "Approve any amount" permission, or "any amount" in Setup. */
  anyAmount: boolean;
  /** Never approves above this; null for no limit of their own. */
  limitCents: number | null;
}

/** Whether a person acts for a document's company. One with no company is acted on by anybody not limited. */
export function actsForCompany(standing: Pick<PurchasingStanding, 'companies'>, companyTenantId: string | null): boolean {
  if (!standing.companies) return true;
  return companyTenantId !== null && standing.companies.includes(companyTenantId);
}

/** Why a person limited to some companies cannot act on this one, in the office's words. */
export function companyRefusal(standing: Pick<PurchasingStanding, 'companies'>, companyTenantId: string | null, what: string): string | null {
  if (actsForCompany(standing, companyTenantId)) return null;
  return companyTenantId === null ? `You ${what} only for your own companies: choose one of them.` : `You ${what} only for your own companies, and this is another company's.`;
}

/**
 * Why this person cannot approve an amount, in the office's words; null when
 * they can. The same rule decides a requisition and a purchase order, on the
 * server and on the page:
 * - the company, when the office says approvers approve only for their own;
 * - their own limit, which they never go above;
 * - the step: any approver, an approver whose own limit reaches its top, or
 *   only somebody who may approve any amount.
 */
export function approvalRefusal(
  standing: PurchasingStanding,
  steps: readonly ApprovalStep[],
  totalCents: number,
  companyTenantId: string | null,
  ownCompaniesOnly: boolean,
): string | null {
  if (ownCompaniesOnly && !actsForCompany(standing, companyTenantId)) return companyRefusal(standing, companyTenantId, 'approve')!;
  if (!standing.anyAmount && standing.limitCents !== null && totalCents > standing.limitCents)
    return `At ${formatMoney(totalCents)} it is above your approval limit of ${formatMoney(standing.limitCents)}.`;
  const step = approvalStepFor(totalCents, steps);
  if (step.approver === 'ANY_AMOUNT' && !standing.anyAmount) return `At ${formatMoney(totalCents)} it needs somebody who may approve any amount.`;
  if (step.approver === 'APPROVER_LIMIT' && !standing.anyAmount && (standing.limitCents === null || step.upToCents === null || standing.limitCents < step.upToCents))
    return `At ${formatMoney(totalCents)} it needs an approver whose own limit is ${formatMoney(step.upToCents ?? approvalStepFromCents(steps, steps.indexOf(step)))} or more.`;
  return null;
}
