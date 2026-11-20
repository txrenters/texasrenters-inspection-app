import type { Prisma } from '@prisma/client';
import {
  DEFAULT_APPROVAL_LIMIT_CENTS,
  DEFAULT_FILE_RULES,
  DEFAULT_QUOTES_ABOVE_LIMIT,
  DEFAULT_CODE_KEEPERS,
  DOCUMENT_SERIES,
  FILE_GROUP_KEYS,
  FILE_REMOVALS,
  KEEPER_ROLES,
  codeList,
  completePageLayout,
  defaultSeries,
  formatDocumentNumber,
  keepsList,
  stepsFromLimit,
  type ApprovalStep,
  type ApprovalStepApprover,
  type CodeKeepers,
  type CodeListKey,
  type DocumentSeriesKind,
  type DocumentSeriesSetting,
  type FileGroup,
  type FileRemoval,
  type PurchasingApprovals,
  type PurchasingSettings,
  type PurchasingStanding,
  type RequisitionPageLayout,
  type RequisitionFileRules,
} from '@texasrenters/shared';

import { ApplicationError } from '../common/errors';

/**
 * What Purchasing Setup keeps (2026-11-20, part 5a), read by every service
 * that is held to it: the approval steps and file rules a requisition and an
 * order answer to, the office's switches, and its document numbers.
 *
 * An office that never saved steps reads as it did before Setup -- its limit
 * and quotes as two steps -- and a series without a prefix writes its numbers
 * as before.
 */

type Db = Prisma.TransactionClient;

const SETTINGS_SELECT = {
  approvalLimitCents: true,
  quotesAboveLimit: true,
  emailApprovers: true,
  reapproveChangedOrders: true,
  fileGroups: true,
  fileMaxBytes: true,
  filesMax: true,
  quoteFileAboveCents: true,
  fileRemoval: true,
  approverOwnCompaniesOnly: true,
  codeKeepers: true,
  requisitionPage: true,
} as const;

type SettingsRow = Prisma.PurchasingSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>;

function stepsOf(row: SettingsRow | null, saved: { upToCents: number | null; approver: string; quotesNeeded: number; reminderDays: number | null }[]): ApprovalStep[] {
  if (saved.length)
    return saved.map((step) => ({ upToCents: step.upToCents, approver: step.approver as ApprovalStepApprover, quotesNeeded: step.quotesNeeded, reminderDays: step.reminderDays }));
  return stepsFromLimit(row?.approvalLimitCents ?? DEFAULT_APPROVAL_LIMIT_CENTS, row?.quotesAboveLimit ?? DEFAULT_QUOTES_ABOVE_LIMIT);
}

function filesOf(row: SettingsRow | null): RequisitionFileRules {
  if (!row) return { ...DEFAULT_FILE_RULES, groups: [...DEFAULT_FILE_RULES.groups] };
  return {
    groups: FILE_GROUP_KEYS.filter((group) => row.fileGroups.includes(group)) as FileGroup[],
    maxBytes: row.fileMaxBytes,
    maxFiles: row.filesMax,
    quoteFileAboveCents: row.quoteFileAboveCents,
    removal: (FILE_REMOVALS as readonly string[]).includes(row.fileRemoval) ? (row.fileRemoval as FileRemoval) : 'UNTIL_SENT',
  };
}

/** Who keeps each code list: the office's choices, the rest as before Setup. */
function keepersOf(row: SettingsRow | null): CodeKeepers {
  const saved = (row?.codeKeepers ?? {}) as Record<string, unknown>;
  const keepers = { ...DEFAULT_CODE_KEEPERS };
  for (const list of Object.keys(keepers) as CodeListKey[]) {
    const role = saved[list];
    if (typeof role === 'string' && (KEEPER_ROLES as readonly string[]).includes(role)) keepers[list] = role as CodeKeepers[CodeListKey];
  }
  return keepers;
}

/** Everything Setup keeps for approvals, files, code lists and the requisition page, in one read. */
export async function readPurchasingSetup(
  db: Pick<Db, 'purchasingSettings' | 'purchasingApprovalStep'>,
  organizationId: string,
): Promise<{ settings: PurchasingSettings; approvals: PurchasingApprovals; keepers: CodeKeepers }> {
  const [row, saved] = await Promise.all([
    db.purchasingSettings.findUnique({ where: { organizationId }, select: SETTINGS_SELECT }),
    db.purchasingApprovalStep.findMany({ where: { organizationId }, orderBy: { position: 'asc' }, select: { upToCents: true, approver: true, quotesNeeded: true, reminderDays: true } }),
  ]);
  const steps = stepsOf(row, saved);
  return {
    settings: { steps, files: filesOf(row), page: completePageLayout(row?.requisitionPage as Partial<RequisitionPageLayout> | null) },
    keepers: keepersOf(row),
    approvals: {
      steps,
      approverOwnCompaniesOnly: row?.approverOwnCompaniesOnly ?? true,
      emailApprovers: row?.emailApprovers ?? false,
      reapproveChangedOrders: row?.reapproveChangedOrders ?? false,
    },
  };
}

/**
 * A person's standing in purchasing (Purchasing Setup, 2026-11-21): their
 * permissions, the companies Setup gives them (none set = every one) and their
 * approver limit. A limit set in Setup caps them even with "Approve any
 * amount"; with no row they stand as before Setup.
 */
export function standingOf(
  permissions: readonly string[],
  row: { companyTenantIds: string[]; approvesAnyAmount: boolean; approvalLimitCents: number | null } | null,
): PurchasingStanding {
  const approveAny = permissions.includes('purchasing:approve-any');
  return {
    permissions,
    companies: row?.companyTenantIds.length ? row.companyTenantIds : null,
    anyAmount: row ? row.approvesAnyAmount || (row.approvalLimitCents === null && approveAny) : approveAny,
    limitCents: row?.approvesAnyAmount ? null : (row?.approvalLimitCents ?? null),
  };
}

export async function readStanding(db: Pick<Db, 'purchasingPerson'>, person: { id: string; organizationId: string; permissions: readonly string[] }): Promise<PurchasingStanding> {
  const row = await db.purchasingPerson.findUnique({
    where: { organizationId_userProfileId: { organizationId: person.organizationId, userProfileId: person.id } },
    select: { companyTenantIds: true, approvesAnyAmount: true, approvalLimitCents: true },
  });
  return standingOf(person.permissions, row);
}

/**
 * A code list is made and changed only by whoever holds the role the office
 * chose for it in Setup (2026-11-21; it starts as before Setup).
 */
export async function assertKeeps(db: Pick<Db, 'purchasingSettings' | 'purchasingApprovalStep'>, user: { organizationId: string; permissions: readonly string[] }, list: CodeListKey) {
  const { keepers } = await readPurchasingSetup(db, user.organizationId);
  if (!keepsList(user.permissions, keepers, list))
    throw new ApplicationError(403, 'CODE_LIST_NOT_YOURS', `${codeList(list).label} are kept by somebody else here: Purchasing Setup says who.`);
}

/** The steps and file rules a requisition or order is held to. */
export async function readPurchasingSettings(db: Pick<Db, 'purchasingSettings' | 'purchasingApprovalStep'>, organizationId: string): Promise<PurchasingSettings> {
  return (await readPurchasingSetup(db, organizationId)).settings;
}

/** Each kind of document's prefix, digits and next number, in the board's order. */
export async function readDocumentSeries(db: Pick<Db, 'documentSeries'>, organizationId: string): Promise<DocumentSeriesSetting[]> {
  const saved = await db.documentSeries.findMany({ where: { organizationId }, select: { kind: true, next: true, prefix: true, digits: true } });
  return DOCUMENT_SERIES.map((series) => {
    const row = saved.find((one) => one.kind === series.kind);
    return { kind: series.kind, label: series.label, prefix: row?.prefix ?? series.prefix, digits: row?.digits ?? series.digits, next: row?.next ?? 1 };
  });
}

/**
 * The office's next number of a kind of document, written as Setup says --
 * "PR-00043" -- taken under the series row's lock: two given at once never
 * share one, and none is given twice.
 */
export async function nextDocumentCode(db: Pick<Db, '$queryRaw'>, organizationId: string, kind: DocumentSeriesKind): Promise<string> {
  const [taken] = await db.$queryRaw<{ taken: number; prefix: string | null; digits: number | null }[]>`
    INSERT INTO "DocumentSeries" ("organizationId", "kind", "next")
    VALUES (${organizationId}::uuid, ${kind}, 2)
    ON CONFLICT ("organizationId", "kind") DO UPDATE SET "next" = "DocumentSeries"."next" + 1
    RETURNING "next" - 1 AS taken, "prefix", "digits"`;
  const series = defaultSeries(kind);
  return formatDocumentNumber(taken!.prefix ?? series.prefix, taken!.digits ?? series.digits, Number(taken!.taken));
}
