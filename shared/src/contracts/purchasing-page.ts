/**
 * Purchasing Setup, part 5c (2026-11-21), as the approved PurchasingSetup
 * board draws it: who makes and changes each code list, and the requisition
 * page -- which fields it shows and requires, and its FactBoxes, in their
 * order, and who sees each.
 *
 * Decided with the office: who keeps a list is enforced everywhere in the
 * console, starting as it was before Setup; and no field is required until
 * the office ticks it. Nothing here calls anything billed.
 *
 * This file imports nothing from purchasing.ts, which imports it.
 */
import { PURCHASING_ROLE_KEYS, type PurchasingRoleKey } from './purchasing-roles.js';

// ── What marks a purchasing role ─────────────────────────────────────────────

/**
 * The one permission each purchasing role is known by, wherever it comes
 * from: who keeps a code list, and who sees a FactBox, are decided by it.
 */
export const ROLE_PERMISSION: Record<PurchasingRoleKey, string> = {
  REQUISITIONER: 'purchasing:request',
  PURCHASER: 'purchasing:order',
  APPROVER: 'purchasing:approve',
  PURCHASING_MANAGER: 'purchasing:approve-orders',
  STOCK_KEEPER: 'inventory:manage',
  RECEIVER: 'purchasing:receive',
  CODE_ADMIN: 'purchasing:codes',
  BILL_PAYER: 'purchasing:bills',
  PURCHASING_ADMIN: 'purchasing:setup',
};
export const holdsRole = (permissions: readonly string[], role: PurchasingRoleKey) => permissions.includes(ROLE_PERMISSION[role]);

// ── Who makes each code list ─────────────────────────────────────────────────

/** The roles the board offers for keeping a list. */
export const KEEPER_ROLES = ['STOCK_KEEPER', 'CODE_ADMIN', 'PURCHASER', 'PURCHASING_ADMIN'] as const satisfies readonly PurchasingRoleKey[];
export type KeeperRole = (typeof KEEPER_ROLES)[number];
/** Whoever may keep any list holds one of these: the routes' first check, before the list's own. */
export const KEEPER_PERMISSIONS = KEEPER_ROLES.map((role) => ROLE_PERMISSION[role]);

export const REQUISITION_FIELDS = [
  { key: 'REQUEST_CODE', label: 'Request Code', line: false, missing: 'Choose the request code.' },
  // The department it is for, whose approvers approve it (2026-11-21).
  { key: 'DEPARTMENT', label: 'Department Code', line: false, missing: 'Choose the department it is for.' },
  { key: 'COST_CENTER', label: 'Cost Center Code', line: false, missing: 'Choose the cost center code.' },
  { key: 'DOCUMENT_DATE', label: 'Document Date', line: false, missing: 'Give the document date.' },
  { key: 'EXPECTED_RECEIPT', label: 'Expected Receipt Date', line: false, missing: 'Give the expected receipt date.' },
  { key: 'LINE_DEPARTMENT', label: 'Line: Department Code', line: true, missing: 'Choose a department code on every line.' },
  { key: 'LINE_NOTES', label: 'Line: Notes', line: true, missing: 'Write a note on every line.' },
  { key: 'LOCATION', label: 'Location Code', line: false, missing: 'Choose where it is delivered.' },
  { key: 'COMPANY', label: 'Purchaser Code', line: false, missing: 'Choose the company it is for.' },
] as const;
export type RequisitionFieldKey = (typeof REQUISITION_FIELDS)[number]['key'];
export const REQUISITION_FIELD_KEYS = REQUISITION_FIELDS.map((field) => field.key) as readonly RequisitionFieldKey[];
/** The fields the board's "The requisition page" lists; Location and Purchaser Code are set from the Codes section. */
export const PAGE_FIELD_KEYS: readonly RequisitionFieldKey[] = ['REQUEST_CODE', 'DEPARTMENT', 'COST_CENTER', 'DOCUMENT_DATE', 'EXPECTED_RECEIPT', 'LINE_DEPARTMENT', 'LINE_NOTES'];

/**
 * Each code list, who kept it before Setup, and what it is on the
 * requisition: a field the office requires or not, or fixed.
 */
export const CODE_LISTS = [
  { key: 'ITEMS', label: 'Item codes', keeper: 'STOCK_KEEPER', field: null, fixed: 'Required on every line' },
  { key: 'CATEGORIES', label: 'Item categories', keeper: 'STOCK_KEEPER', field: null, fixed: '—' },
  { key: 'LINE_TYPES', label: 'Line types (Item, Service, Lot)', keeper: 'CODE_ADMIN', field: null, fixed: 'Required on every line' },
  { key: 'UNITS', label: 'Units of measure', keeper: 'CODE_ADMIN', field: null, fixed: 'From the item code' },
  { key: 'REQUEST', label: 'Request codes', keeper: 'CODE_ADMIN', field: 'REQUEST_CODE', fixed: null },
  { key: 'DEPARTMENT', label: 'Department codes', keeper: 'CODE_ADMIN', field: 'LINE_DEPARTMENT', fixed: null },
  { key: 'COST_CENTER', label: 'Cost center codes', keeper: 'CODE_ADMIN', field: 'COST_CENTER', fixed: null },
  { key: 'PLACES', label: 'Location codes (places)', keeper: 'STOCK_KEEPER', field: 'LOCATION', fixed: null },
  { key: 'VENDORS', label: 'Vendor numbers', keeper: 'STOCK_KEEPER', field: null, fixed: 'From the item code' },
  // Always required (the office, 2026-11-24, codes come first): an order of no company reaches no books.
  { key: 'PURCHASER_CODES', label: 'Purchaser codes (companies)', keeper: 'CODE_ADMIN', field: null, fixed: 'Required' },
] as const satisfies readonly { key: string; label: string; keeper: KeeperRole; field: RequisitionFieldKey | null; fixed: string | null }[];
export type CodeListKey = (typeof CODE_LISTS)[number]['key'];
export const CODE_LIST_KEYS = CODE_LISTS.map((list) => list.key) as readonly CodeListKey[];
export const codeList = (key: CodeListKey) => CODE_LISTS.find((list) => list.key === key)!;

export type CodeKeepers = Record<CodeListKey, KeeperRole>;
/** As it was before Setup (the office's choice, 2026-11-21): stock lists by the stock keeper, purchasing codes by the code admin. */
export const DEFAULT_CODE_KEEPERS = Object.fromEntries(CODE_LISTS.map((list) => [list.key, list.keeper])) as CodeKeepers;
/** Whether a person may make and change a list, by the role the office gave it. */
export const keepsList = (permissions: readonly string[], keepers: CodeKeepers, list: CodeListKey) => holdsRole(permissions, keepers[list]);
/** Every list, and whether this person keeps it. */
export const listsKept = (permissions: readonly string[], keepers: CodeKeepers) => Object.fromEntries(CODE_LIST_KEYS.map((list) => [list, keepsList(permissions, keepers, list)])) as Record<CodeListKey, boolean>;

export function codeKeepersProblem(keepers: Record<string, string>): string | null {
  for (const list of CODE_LIST_KEYS) if (!(KEEPER_ROLES as readonly string[]).includes(keepers[list] ?? '')) return `Choose who keeps ${codeList(list).label.toLowerCase()}.`;
  return Object.keys(keepers).every((key) => (CODE_LIST_KEYS as readonly string[]).includes(key)) ? null : 'A code list Setup does not know.';
}

// ── The requisition page ─────────────────────────────────────────────────────

export const FACT_BOXES = [
  { key: 'STATISTICS', label: 'Requisition Statistics' },
  { key: 'ATTACHMENTS', label: 'Attachments' },
  { key: 'LINE_DETAILS', label: 'Line Details' },
  { key: 'ITEM_AVAILABILITY', label: 'Item Availability' },
  { key: 'VENDOR_STATISTICS', label: 'Vendor Statistics' },
] as const;
export type FactBoxKey = (typeof FACT_BOXES)[number]['key'];
export const FACT_BOX_KEYS = FACT_BOXES.map((box) => box.key) as readonly FactBoxKey[];

export interface RequisitionFieldSetting {
  shown: boolean;
  required: boolean;
}

export interface FactBoxSetting {
  key: FactBoxKey;
  shown: boolean;
  /** The roles that see it; empty is everybody. */
  audience: PurchasingRoleKey[];
}

export interface RequisitionPageLayout {
  fields: Record<RequisitionFieldKey, RequisitionFieldSetting>;
  /** In the order the page stacks them. */
  factBoxes: FactBoxSetting[];
}

/** As the page was before Setup: every field shown, none required; every FactBox for everybody -- Vendor Statistics, new, off until the office shows it. */
export const DEFAULT_PAGE_LAYOUT: RequisitionPageLayout = {
  fields: Object.fromEntries(REQUISITION_FIELD_KEYS.map((key) => [key, { shown: true, required: false }])) as Record<RequisitionFieldKey, RequisitionFieldSetting>,
  factBoxes: FACT_BOX_KEYS.map((key) => ({ key, shown: key !== 'VENDOR_STATISTICS', audience: [] })),
};

/** A saved layout, with anything it lacks taken from the defaults: a box added later appears at the end. */
export function completePageLayout(saved: Partial<RequisitionPageLayout> | null | undefined): RequisitionPageLayout {
  const fields = { ...DEFAULT_PAGE_LAYOUT.fields };
  for (const key of REQUISITION_FIELD_KEYS) {
    const one = saved?.fields?.[key];
    if (one && typeof one.shown === 'boolean' && typeof one.required === 'boolean') fields[key] = { shown: one.shown, required: one.shown && one.required };
  }
  const boxes = (saved?.factBoxes ?? []).filter((box, index, all) => FACT_BOX_KEYS.includes(box.key) && all.findIndex((one) => one.key === box.key) === index);
  for (const box of DEFAULT_PAGE_LAYOUT.factBoxes) if (!boxes.some((one) => one.key === box.key)) boxes.push(box);
  return { fields, factBoxes: boxes.map((box) => ({ key: box.key, shown: Boolean(box.shown), audience: (box.audience ?? []).filter((role) => PURCHASING_ROLE_KEYS.includes(role)) })) };
}

export function pageLayoutProblem(layout: RequisitionPageLayout): string | null {
  for (const key of REQUISITION_FIELD_KEYS) {
    const field = layout.fields[key];
    if (!field) return 'Every field is shown or hidden.';
    if (field.required && !field.shown) return `${REQUISITION_FIELDS.find((one) => one.key === key)!.label} is required, so it is shown.`;
  }
  if (layout.factBoxes.length !== FACT_BOX_KEYS.length || FACT_BOX_KEYS.some((key) => !layout.factBoxes.some((box) => box.key === key))) return 'Every FactBox is listed once.';
  if (layout.factBoxes.some((box) => box.audience.some((role) => !PURCHASING_ROLE_KEYS.includes(role)))) return 'A FactBox is seen by roles Setup knows.';
  return null;
}

/** The FactBoxes this person sees, in the page's order. */
export function factBoxesFor(layout: RequisitionPageLayout, permissions: readonly string[]): FactBoxKey[] {
  return layout.factBoxes.filter((box) => box.shown && (!box.audience.length || box.audience.some((role) => holdsRole(permissions, role)))).map((box) => box.key);
}

/** "Everybody", or "Stock keeper, Purchaser". */
export function audienceSaying(audience: readonly PurchasingRoleKey[], labels: Record<PurchasingRoleKey, string>): string {
  return audience.length ? audience.map((role) => labels[role]).join(', ') : 'Everybody';
}

/** What a requisition holds, as far as its fields go. */
export interface RequisitionFieldValues {
  requestCodeId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  documentDate?: string | null;
  neededBy?: string | null;
  deliverToPlaceId?: string | null;
  xeroTenantId?: string | null;
  lines: readonly { departmentId?: string | null; notes?: string | null }[];
}

/** The first required field a requisition leaves empty, in the office's words; null when none. */
export function missingFieldProblem(values: RequisitionFieldValues, layout: Pick<RequisitionPageLayout, 'fields'>): string | null {
  const given: Record<RequisitionFieldKey, boolean> = {
    REQUEST_CODE: Boolean(values.requestCodeId),
    DEPARTMENT: Boolean(values.departmentId),
    COST_CENTER: Boolean(values.costCenterId),
    DOCUMENT_DATE: Boolean(values.documentDate),
    EXPECTED_RECEIPT: Boolean(values.neededBy),
    LINE_DEPARTMENT: values.lines.every((line) => Boolean(line.departmentId)),
    LINE_NOTES: values.lines.every((line) => Boolean(line.notes?.trim())),
    LOCATION: Boolean(values.deliverToPlaceId),
    COMPANY: Boolean(values.xeroTenantId),
  };
  // The company is always required, whatever the layout says (the office, 2026-11-24): its bill goes to that company's books.
  const missing = REQUISITION_FIELDS.find((field) => (field.key === 'COMPANY' || layout.fields[field.key]?.required) && !given[field.key]);
  return missing?.missing ?? null;
}
