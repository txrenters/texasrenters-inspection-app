'use client';

import {
  MOST_REQUISITION_LINES,
  MOST_REQUISITION_QUOTES,
  REQUISITION_STATUS_LABEL,
  FACT_BOXES,
  approvalStepFor,
  approvalStepRange,
  factBoxesFor,
  formatMoney,
  orderGroups,
  parseMoney,
  requisitionSubmitProblem,
  requisitionTotalCents,
  stockStatus,
  type FactBoxKey,
  type RequisitionChoices,
  type RequisitionDetail,
  type RequisitionFieldKey,
  type RequisitionLine,
  type RequisitionLineInput,
  type SaveRequisitionInput,
} from '@texasrenters/shared';
import { ChevronDownIcon, FilterIcon, ListPlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useId, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import { ScanField } from '@/components/inventory/scan-field';
import { AttachmentsFactBox } from '@/components/purchasing/attachments-factbox';
import { ItemCodePicker, ItemLookupDialog, type PickerItem } from '@/components/purchasing/item-picker';
import { DocumentTitle, FactBox, FastTab, FieldRow, FieldValue } from '@/components/purchasing/nav-kit';
import { CommentsTab, LinksFactBox, NotesFactBox } from '@/components/purchasing/requisition-attached';
import { CategoriesDialog, CopyDocumentDialog, DeleteDialog, NoteDialog } from '@/components/purchasing/requisition-dialogs';
import { approverFor } from '@/components/purchasing/requisition-parts';
import { RequisitionRibbon } from '@/components/purchasing/requisition-ribbon';
import { CELL, CELL_INPUT, CELL_TEXT, RowNumber, Sheet, SheetBody, SheetHead, sheetKeys, type SheetColumn } from '@/components/purchasing/sheet-grid';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { businessToday } from '@/lib/clock';
import { EMPTY, formatCount, formatDateTime, formatDay } from '@/lib/format';
import { useRequisitionSiblings, type RequisitionStep } from '@/lib/purchasing-queries';
import { cn } from '@/lib/utils';

/**
 * The purchase requisition as one NAV document (2026-11-20, finished to the
 * canvas the office approved): the ribbon with every group, the number under
 * it, the General FastTab with "Label:" beside each field, the Lines as a
 * spreadsheet, totals, quotes, comments and history, and FactBoxes down the
 * right that follow the line the cursor is on.
 *
 * The same page reads a requisition sent for approval (`readOnly`): the same
 * General, grid and FactBoxes with nothing to type in, and the ribbon's
 * decisions for whoever may take them.
 *
 * A line's item code is a dropdown: type part of a code or a description, or
 * scan a label, and Enter takes it. Picking an item fills the rest of the line
 * from it in yellow until it is changed. A new requisition starts with one
 * blank line, and blank lines are never saved. Everything is matched in the
 * rows the page already holds; nothing is asked of the server while typing.
 *
 * Saved whole: a save replaces its lines and quotes. What may be submitted,
 * and who decides, the server says.
 */

const NONE = 'none';
const ALL = 'all';
const chosen = (value: string) => (value === NONE ? null : value);
const whole = (value: string) => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value.trim()) : null);
const money = (value: string) => (value.trim() ? parseMoney(value) : null);
const dollars = (cents: number) => (cents / 100).toFixed(2);
/** An amount for a field that may hold none. */
const dollars0 = (cents: number | null | undefined) => (cents == null ? '' : dollars(cents));
const LEAVE = 'What you changed here since it was last saved is lost.';

/** The fields a picked item fills, marked until somebody changes them. */
type Filled = 'description' | 'place' | 'quantity' | 'cost' | 'expected' | 'vendor' | 'department';

interface LineDraft {
  key: string;
  /** A line type's id; NONE when the office has none. */
  typeId: string;
  /** An item's id; NONE while none is picked. */
  itemId: string;
  description: string;
  placeId: string;
  quantity: string;
  cost: string;
  expectedOn: string;
  vendorId: string;
  departmentId: string;
  notes: string;
  filled: Filled[];
}
interface QuoteDraft {
  key: string;
  vendorId: string;
  total: string;
  delivery: string;
  chosen: boolean;
}

/** A line as the grid shows it, typed or read: what Find and Filter look at. */
interface LineView {
  key: string;
  type: string;
  code: string;
  description: string;
  place: string;
  vendor: string;
  notes: string;
}

let made = 0;
const key = () => `row-${(made += 1)}`;

/** The line type an item is, or the office's first: Item. */
function firstType(choices: RequisitionChoices): string {
  const types = choices.lineTypes ?? [];
  return (types.find((type) => type.code === 'ITEM') ?? types[0])?.id ?? NONE;
}

/** A line with nothing in it: the spreadsheet's next row, never saved. */
const isBlank = (line: LineDraft) => line.itemId === NONE && !line.quantity.trim() && !line.cost.trim() && !line.notes.trim() && !line.description.trim();

/** State that marks the page changed when it is set, so leaving it can ask first. */
function useTracked<T>(initial: T | (() => T), mark: () => void): [T, Dispatch<SetStateAction<T>>] {
  const [value, set] = useState(initial);
  return [
    value,
    (next) => {
      mark();
      set(next);
    },
  ];
}

const LINE_COLUMNS: readonly SheetColumn[] = [
  { key: 'type', label: 'Type', width: 'w-28' },
  { key: 'item', label: 'Item Code', width: 'w-44' },
  { key: 'description', label: 'Description', width: 'w-60' },
  { key: 'place', label: 'Location Code', width: 'w-36' },
  { key: 'quantity', label: 'Quantity', numeric: true, width: 'w-24' },
  { key: 'unit', label: 'Unit of Measure', width: 'w-28' },
  { key: 'cost', label: 'Direct Unit Cost', numeric: true, width: 'w-32' },
  { key: 'amount', label: 'Line Amount', numeric: true, width: 'w-32' },
  { key: 'expected', label: 'Expected Receipt Date', width: 'w-40' },
  { key: 'vendor', label: 'Vendor No.', width: 'w-44' },
  { key: 'notes', label: 'Notes', width: 'w-56' },
  { key: 'department', label: 'Department Code', width: 'w-36' },
];

/** The decisions an opened requisition's ribbon takes, the page's to make. */
export interface RequisitionDecisions {
  step: (step: RequisitionStep, note?: string) => Promise<unknown>;
  makeOrder?: () => void;
  ordering?: boolean;
  error?: Error | null;
}

export function RequisitionForm({
  choices,
  requisition,
  start,
  onSave,
  pending,
  error,
  onDiscard,
  readOnly = false,
  decisions,
  onPrint,
  permissions = [],
}: {
  choices: RequisitionChoices;
  /** The requisition being changed or read; none for a new one. */
  requisition?: RequisitionDetail;
  /** Items to begin a new one with, from the Reorder list. The company is theirs; one of another company is left off. */
  start?: { itemId: string; quantity: number }[];
  /** Saves it, and submits it when asked. Resolves once done; a refusal is shown from `error`. */
  onSave: (input: SaveRequisitionInput, submit: boolean) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
  /** Delete: a new one is dropped; a saved draft is cancelled, kept with its number. */
  onDiscard: () => void;
  /** @deprecated The ribbon says Delete now. */
  discardLabel?: string;
  /** Read, not changed: one sent for approval, or somebody else's. */
  readOnly?: boolean;
  decisions?: RequisitionDecisions;
  /** Print...: the requisition as it was last saved, as a PDF (2026-11-20, part 4). None for a new one. */
  onPrint?: () => void;
  /** What the person may do: Purchasing Setup can show a FactBox to some roles only (2026-11-21). */
  permissions?: readonly string[];
}) {
  const ids = useId();
  const router = useRouter();
  const siblings = useRequisitionSiblings();
  const itemOf = new Map(choices.items.map((item) => [item.id, item]));
  const lineTypes = choices.lineTypes ?? [];
  const typeOf = new Map(lineTypes.map((type) => [type.id, type]));
  const placeOf = new Map(choices.places.map((place) => [place.id, place]));
  const vendorOf = (vendorId: string | null | undefined) => choices.vendors.find((option) => option.id === vendorId);
  const can = requisition?.can;
  const editing = !readOnly;
  // The page as Purchasing Setup lays it out (2026-11-21): the fields shown, the fields required, the FactBoxes in order.
  const page = choices.settings.page;
  const required = (field: RequisitionFieldKey) => page.fields[field].required;
  /** A field the office hides still shows what a requisition already holds in it. */
  const showsField = (field: RequisitionFieldKey, holds: unknown) => page.fields[field].shown || Boolean(holds);

  const [changed, setChanged] = useState(false);
  const mark = () => setChanged(true);

  // A new one begun from the Reorder list is for the company of the first item on it.
  const begun = requisition ? [] : (start ?? []).flatMap((line) => choices.items.filter((item) => item.id === line.itemId).map((item) => ({ item, quantity: line.quantity })));
  const begunFor = begun[0]?.item.companyTenantId;
  const [company, setCompany] = useTracked(requisition?.company?.tenantId ?? (requisition ? NONE : (begunFor ?? choices.companies[0]?.tenantId ?? NONE)), mark);
  const [neededBy, setNeededBy] = useTracked(requisition?.neededBy ?? '', mark);
  const [place, setPlace] = useTracked(requisition?.deliverTo?.id ?? (requisition ? NONE : (choices.places[0]?.id ?? NONE)), mark);
  const [requestCode, setRequestCode] = useTracked(requisition?.requestCode?.id ?? NONE, mark);
  const [costCenter, setCostCenter] = useTracked(requisition?.costCenter?.id ?? NONE, mark);
  const [documentDate, setDocumentDate] = useTracked(requisition?.documentDate ?? businessToday(), mark);
  const [reason, setReason] = useTracked(requisition?.reason ?? '', mark);
  const [moreShown, setMoreShown] = useState(Boolean(requisition?.reason));

  /** A line for an item: what the office usually orders, at its usual price or what one cost on average, and the rest from the item and General. */
  const filledLine = (item: PickerItem, quantity: number | null, base: Partial<LineDraft> = {}, previous?: LineDraft): LineDraft => {
    const filled: Filled[] = ['description'];
    const costCents = item.priceCents ?? item.averageCostCents;
    if (typeof costCents === 'number') filled.push('cost');
    // A quantity somebody asked for (a scan, "Add everything that is low") is theirs; the reorder quantity is the item's.
    if (!quantity && item.reorderQuantity) filled.push('quantity');
    const placeId = base.placeId && base.placeId !== NONE ? base.placeId : place;
    if (placeId !== NONE) filled.push('place');
    if (neededBy) filled.push('expected');
    if (item.usualVendorId) filled.push('vendor');
    const departmentId = previous?.departmentId ?? NONE;
    if (departmentId !== NONE) filled.push('department');
    return {
      key: base.key ?? key(),
      typeId: item.lineTypeId ?? base.typeId ?? firstType(choices),
      itemId: item.id,
      description: item.name,
      placeId,
      quantity: quantity ? String(quantity) : item.reorderQuantity ? String(item.reorderQuantity) : '',
      cost: dollars0(costCents),
      expectedOn: neededBy,
      vendorId: item.usualVendorId ?? NONE,
      departmentId,
      notes: base.notes ?? '',
      filled,
    };
  };
  const blankLine = (previous?: LineDraft): LineDraft => ({
    key: key(),
    typeId: firstType(choices),
    itemId: NONE,
    description: '',
    placeId: place,
    quantity: '',
    cost: '',
    expectedOn: neededBy,
    vendorId: NONE,
    departmentId: previous?.departmentId ?? NONE,
    notes: '',
    filled: [],
  });

  const [lines, setLines] = useTracked<LineDraft[]>(() => {
    const drafted = requisition?.lines.map((line) => draftOf(line, choices)) ?? begun.filter(({ item }) => item.companyTenantId === begunFor).map(({ item, quantity }) => ({ ...filledLine(item, quantity), filled: [] as Filled[] }));
    // The spreadsheet's next row, ready to type in.
    return readOnly ? drafted : [...drafted, blankLine(drafted.at(-1))];
  }, mark);
  const [quotes, setQuotes] = useTracked<QuoteDraft[]>(
    () => requisition?.quotes.map((quote) => ({ key: key(), vendorId: quote.vendor.id, total: dollars(quote.totalCents), delivery: quote.delivery ?? '', chosen: quote.chosen })) ?? [],
    mark,
  );
  /** The line the cursor is on, and the item the dropdown is on: the FactBoxes follow them. */
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<PickerItem | null>(null);
  const [advancedFor, setAdvancedFor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dialog, setDialog] = useState<'copy' | 'categories' | 'delete' | 'send-back' | 'reject' | 'reopen' | null>(null);
  const [shown, setShown] = useState({ notes: Boolean(requisition?.notes.length), links: Boolean(requisition?.links.length), comments: Boolean(requisition?.comments.length) });
  const [finding, setFinding] = useState<string | null>(null);
  const [filtering, setFiltering] = useState<{ type: string; place: string; vendor: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaveTo, setLeaveTo] = useState<(() => void) | null>(null);

  const companyId = chosen(company);
  const companyRow = choices.companies.find((option) => option.tenantId === companyId);
  const offered = choices.items.filter((item) => item.companyTenantId === companyId);
  const used = new Set(lines.flatMap((line) => (line.itemId !== NONE ? [line.itemId] : [])));
  const setLine = (lineKey: string, change: Partial<LineDraft>, field?: Filled) =>
    setLines((rows) => rows.map((row) => (row.key === lineKey ? { ...row, ...change, filled: field ? row.filled.filter((one) => one !== field) : row.filled } : row)));
  const setQuote = (quoteKey: string, change: Partial<QuoteDraft>) => setQuotes((rows) => rows.map((row) => (row.key === quoteKey ? { ...row, ...change } : row)));
  /** What a line may take: its company's items of its type, none already on another line. */
  const offeredFor = (line: LineDraft) => offered.filter((item) => (item.id === line.itemId || !used.has(item.id)) && (line.typeId === NONE || !item.lineTypeId || item.lineTypeId === line.typeId));

  const pickFor = (line: LineDraft, item: PickerItem) => {
    const index = lines.findIndex((row) => row.key === line.key);
    setLines((rows) => {
      const next = rows.map((row) => (row.key === line.key ? filledLine(item, null, row, rows[index - 1]) : row));
      // Filling the last row opens the next one, as a spreadsheet's does.
      return next.at(-1)!.itemId !== NONE && next.length < MOST_REQUISITION_LINES ? [...next, blankLine(next.at(-1))] : next;
    });
    setCurrentKey(line.key);
  };
  /** Lines for items, after the lines already filled, keeping one blank row at the end. */
  const addItems = (picked: { item: PickerItem; quantity: number | null }[]) =>
    setLines((rows) => {
      const kept = rows.filter((row) => !isBlank(row));
      const added = picked.filter(({ item }) => !kept.some((row) => row.itemId === item.id)).map(({ item, quantity }) => filledLine(item, quantity, {}, kept.at(-1)));
      const all = [...kept, ...added].slice(0, MOST_REQUISITION_LINES - 1);
      return [...all, blankLine(all.at(-1))];
    });
  /** A scanned label: one more of an item already asked for, else a new line for it. */
  const scan = (item: { id: string; code: string }): string | void => {
    const on = lines.find((line) => line.itemId === item.id);
    if (on) return setLine(on.key, { quantity: String((whole(on.quantity) ?? 0) + 1) });
    const picked = itemOf.get(item.id);
    if (!picked) return;
    if (lines.filter((line) => !isBlank(line)).length >= MOST_REQUISITION_LINES) return `A requisition holds ${MOST_REQUISITION_LINES} lines.`;
    addItems([{ item: picked, quantity: null }]);
  };
  const low = offered.filter((item) => !used.has(item.id) && stockStatus(item.onHand, item.reorderLevel) !== 'ENOUGH');

  function changeCompany(next: string) {
    setCompany(next);
    // Its items are its own company's: lines for another company's items would be refused.
    setLines((rows) => rows.filter((row) => row.itemId === NONE || itemOf.get(row.itemId)?.companyTenantId === chosen(next)));
  }

  /** Copy Document: another requisition's lines, and its General if asked. */
  function copyFrom(from: RequisitionDetail, options: { general: boolean; replace: boolean }): string | null {
    const target = options.general && from.company ? from.company.tenantId : companyId;
    const taken = from.lines.filter((line) => line.item && itemOf.get(line.item.id)?.companyTenantId === target);
    if (!taken.length) return `${from.number ?? 'That requisition'} has no line this requisition's company buys.`;
    if (options.general) {
      if (from.company) setCompany(from.company.tenantId);
      setPlace(from.deliverTo?.id ?? NONE);
      setRequestCode(from.requestCode?.id ?? NONE);
      setCostCenter(from.costCenter?.id ?? NONE);
      setNeededBy(from.neededBy ?? '');
    }
    setLines((rows) => {
      const kept = options.replace ? [] : rows.filter((row) => !isBlank(row));
      const copied = taken.filter((line) => !kept.some((row) => row.itemId === line.item!.id)).map((line) => draftOf(line, choices));
      const all = [...kept, ...copied].slice(0, MOST_REQUISITION_LINES - 1);
      return [...all, blankLine(all.at(-1))];
    });
    const left = from.lines.length - taken.length;
    setNotice(`Copied ${formatCount(taken.length)} ${taken.length === 1 ? 'line' : 'lines'} from ${from.number ?? 'the requisition'}${left ? `; ${formatCount(left)} for another company left out` : ''}.`);
    return null;
  }

  // What the form holds, as the request; a row with something in it but not finished is null. Blank rows are not lines.
  const parse = (line: LineDraft): RequisitionLineInput | null => {
    const quantity = whole(line.quantity);
    const cost = money(line.cost);
    const item = itemOf.get(line.itemId);
    if (line.itemId === NONE || quantity === null || cost === null || cost < 0) return null;
    const description = line.description.trim();
    return {
      itemId: line.itemId,
      quantity,
      estimatedUnitCostCents: cost,
      // The item's own name is not kept twice: a line given none reads as its item.
      description: description && description !== item?.name ? description : null,
      placeId: chosen(line.placeId),
      expectedOn: line.expectedOn || null,
      vendorId: chosen(line.vendorId),
      departmentId: chosen(line.departmentId),
      notes: line.notes.trim() || null,
    };
  };
  const parsedLines = lines.filter((line) => !isBlank(line)).map(parse);
  const parsedQuotes = quotes.map((quote) => {
    const total = money(quote.total);
    return quote.vendorId !== NONE && total !== null && total >= 0 ? { vendorId: quote.vendorId, totalCents: total, delivery: quote.delivery.trim() || null, chosen: quote.chosen } : null;
  });
  const complete = parsedLines.every(Boolean) && parsedQuotes.every(Boolean);
  const input: SaveRequisitionInput = {
    xeroTenantId: companyId,
    neededBy: neededBy || null,
    deliverToPlaceId: chosen(place),
    requestCodeId: chosen(requestCode),
    costCenterId: chosen(costCenter),
    documentDate: documentDate || null,
    reason: reason.trim(),
    lines: parsedLines.flatMap((line) => (line ? [line] : [])),
    quotes: parsedQuotes.flatMap((quote) => (quote ? [quote] : [])),
  };
  // A requisition sent for approval reads its own figures.
  const reading = readOnly && requisition ? requisition : null;
  const shownLines: readonly { itemId: string | null; quantity: number; vendorId: string | null }[] = reading
    ? reading.lines.map((line) => ({ itemId: line.item?.id ?? null, quantity: line.quantity, vendorId: line.vendor?.id ?? null }))
    : input.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, vendorId: line.vendorId ?? null }));
  const totalCents = reading ? reading.estimatedTotalCents : requisitionTotalCents(input.lines);
  const totalQuantity = shownLines.reduce((sum, line) => sum + line.quantity, 0);
  // With the files attached so far: above the office's amount, the quote must be one of them.
  const problem = complete ? requisitionSubmitProblem({ ...input, files: requisition?.files ?? [] }, choices.settings) : 'Finish or delete the lines that are not filled in.';
  // The approval step its amount falls in (Purchasing Setup, 2026-11-20): who approves it and the quotes it needs.
  const stepIndex = choices.settings.steps.indexOf(approvalStepFor(totalCents, choices.settings.steps));
  const step = choices.settings.steps[stepIndex]!;
  const overLimit = step.quotesNeeded > 0;
  // The vendors it is ordered from, one purchase order each (2026-11-20): a line's own, else the chosen quote's.
  const chosenVendorId = reading ? (reading.quotes.find((quote) => quote.chosen)?.vendor.id ?? null) : (quotes.find((quote) => quote.chosen)?.vendorId || null);
  const vendorsNamed = orderGroups(shownLines, chosenVendorId).filter((group) => group.vendorId).length;
  const showsDepartment = showsField('LINE_DEPARTMENT', reading ? reading.lines.some((line) => line.department) : lines.some((line) => line.departmentId !== NONE));
  const showsNotes = showsField('LINE_NOTES', reading ? reading.lines.some((line) => line.notes) : lines.some((line) => line.notes.trim()));
  const lineColumns = LINE_COLUMNS.flatMap((column) =>
    column.key === 'department'
      ? showsDepartment
        ? [{ ...column, required: required('LINE_DEPARTMENT') }]
        : []
      : column.key === 'notes'
        ? showsNotes
          ? [{ ...column, required: required('LINE_NOTES') }]
          : []
        : [column],
  );
  const boxes = factBoxesFor(page, permissions);

  const save = (submit: boolean) => {
    if (pending || !complete || (submit && problem)) return;
    void onSave(input, submit)
      .then(() => setChanged(false))
      .catch(() => undefined);
  };
  /** Leaving with changes not saved asks first; without, it just goes. */
  const leave = (then: () => void) => (changed ? setLeaveTo(() => then) : then());
  const go = (href: string) => leave(() => router.push(href));
  const toggle = (which: 'notes' | 'links' | 'comments') => {
    const on = !shown[which];
    setShown((now) => ({ ...now, [which]: !now[which] }));
    if (on) window.setTimeout(() => document.getElementById(`${ids}-${which}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const sibling = (step: 1 | -1) => async () => {
    if (!requisition) return;
    setNotice(null);
    const next = await siblings(requisition.id, step).catch(() => null);
    if (next) go(`/purchasing/requisitions/${next}`);
    else setNotice(step === 1 ? 'This is the last requisition on the list.' : 'This is the first requisition on the list.');
  };
  const decide = (step: RequisitionStep, note?: string) => decisions?.step(step, note) ?? Promise.resolve();

  // The FactBoxes: the item the dropdown is on, else the current line's.
  const current = lines.find((line) => line.key === currentKey);
  const currentRead = readOnly ? requisition?.lines.find((line) => line.id === currentKey) : undefined;
  const shownItem = highlighted ?? (current ? itemOf.get(current.itemId) : currentRead?.item ? itemOf.get(currentRead.item.id) : undefined);
  const shownPlace = choices.places.find((option) => option.id === (current?.placeId && current.placeId !== NONE ? current.placeId : (currentRead?.place?.id ?? place)));
  const advancedLine = lines.find((line) => line.key === advancedFor);
  // Vendor Statistics: the current line's vendor, else its item's usual vendor, else the chosen quote's.
  const lineVendorId = highlighted ? null : current ? chosen(current.vendorId) : (currentRead?.vendor?.id ?? null);
  const statsVendor = vendorOf(lineVendorId ?? shownItem?.usualVendorId ?? chosenVendorId);
  const vendorStats = statsVendor ? choices.vendorStats?.[statsVendor.id] : undefined;

  // Find and Filter look at what each row shows.
  const viewOf = (line: LineDraft): LineView => {
    const item = itemOf.get(line.itemId);
    const vendor = vendorOf(chosen(line.vendorId));
    return { key: line.key, type: typeOf.get(line.typeId)?.name ?? '', code: item?.code ?? '', description: line.description, place: placeOf.get(line.placeId)?.code ?? '', vendor: vendor?.number ?? vendor?.name ?? '', notes: line.notes };
  };
  const readView = (line: RequisitionLine): LineView => ({
    key: line.id,
    type: line.lineType?.name ?? '',
    code: line.item?.code ?? '',
    description: line.description ?? line.item?.name ?? '',
    place: line.place?.code ?? line.place?.name ?? '',
    vendor: line.vendor?.number ?? line.vendor?.name ?? '',
    notes: line.notes ?? '',
  });
  // The blank next row is never counted, and never hidden.
  const views = readOnly ? (requisition?.lines ?? []).map(readView) : lines.filter((line) => !isBlank(line)).map(viewOf);
  const words = (finding ?? '').trim().toLowerCase();
  const passes = (view: LineView) =>
    (!words || `${view.code} ${view.description} ${view.notes} ${view.vendor}`.toLowerCase().includes(words)) &&
    (!filtering || ((filtering.type === ALL || view.type === filtering.type) && (filtering.place === ALL || view.place === filtering.place) && (filtering.vendor === ALL || view.vendor === filtering.vendor)));
  const visible = new Set(views.filter(passes).map((view) => view.key));
  const narrowed = Boolean(words) || Boolean(filtering && (filtering.type !== ALL || filtering.place !== ALL || filtering.vendor !== ALL));
  const distinct = (field: keyof LineView) => [...new Set(views.map((view) => view[field]).filter(Boolean))];

  const deleteLine = (lineKey: string) =>
    setLines((rows) => {
      const left = rows.filter((row) => row.key !== lineKey);
      return left.length && isBlank(left.at(-1)!) ? left : [...left, blankLine(left.at(-1))];
    });
  const move = (lineKey: string, by: -1 | 1) =>
    setLines((rows) => {
      const at = rows.findIndex((row) => row.key === lineKey);
      const to = at + by;
      if (at < 0 || to < 0 || to >= rows.length) return rows;
      const next = [...rows];
      [next[at], next[to]] = [next[to]!, next[at]!];
      return next;
    });
  const insertAbove = (lineKey: string) =>
    setLines((rows) => {
      if (rows.length >= MOST_REQUISITION_LINES) return rows;
      const at = rows.findIndex((row) => row.key === lineKey);
      return [...rows.slice(0, at), blankLine(rows[at - 1]), ...rows.slice(at)];
    });
  const addLine = () => setLines((rows) => (rows.length >= MOST_REQUISITION_LINES ? rows : [...rows, blankLine(rows.at(-1))]));

  const deciding = Boolean(can && (can.approve || can.sendBack || can.reject || can.approveBlocked));
  const title = requisition?.number ?? (requisition ? 'Draft requisition' : 'New Requisition');
  const generalValue = (label: string | null | undefined) => <FieldValue>{label || EMPTY}</FieldValue>;

  // Why it cannot be sent yet: in Requisition Statistics, or above the FactBoxes when the office hides that one.
  const sendNotes = (
    <>
      {editing ? <p className="text-muted-foreground text-xs">You asked for it, so you cannot approve it yourself.</p> : null}
      {editing && problem ? (
        <p className="text-warning mt-2 text-xs font-medium" role="status">
          {problem}
        </p>
      ) : null}
      {error ? (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
  const openedBoxes = (
    <>
      {shown.notes ? <NotesFactBox id={`${ids}-notes`} requisition={requisition} /> : null}
      {shown.links ? <LinksFactBox id={`${ids}-links`} requisition={requisition} /> : null}
    </>
  );
  const factBox: Record<FactBoxKey, ReactNode> = {
    STATISTICS: (
      <FactBox
        facts={[
          { label: 'Lines', value: formatCount(shownLines.length) },
          { label: 'Total (USD)', value: formatMoney(totalCents) },
          { label: 'Approval Step', value: approvalStepRange(choices.settings.steps, stepIndex) },
          { label: 'Who Approves', value: approverFor(totalCents, choices.settings) },
          { label: 'Quotes Needed', value: step.quotesNeeded ? String(step.quotesNeeded) : 'None' },
          { label: 'Vendors', value: formatCount(vendorsNamed) },
          // One live order a vendor since 2026-11-20: each one, with the vendor it went to.
          ...(requisition?.orders ?? []).map((order, index, orders) => ({
            label: orders.length > 1 ? `Purchase Order ${index + 1}` : 'Purchase Order',
            value: (
              <Link className="underline underline-offset-4" href={`/purchasing/orders/${order.id}`}>
                {order.number ?? 'Draft order'}
                {order.vendor ? ` · ${order.vendor.number ? `${order.vendor.number} ` : ''}${order.vendor.name}` : ' · vendor to choose'}
              </Link>
            ),
          })),
        ]}
        title="Requisition Statistics"
      >
        {sendNotes}
      </FactBox>
    ),
    ATTACHMENTS: (
      <>
        <AttachmentsFactBox requisition={requisition} />
        {openedBoxes}
      </>
    ),
    LINE_DETAILS: (
      <FactBox
        facts={[
          { label: 'Item Code', value: shownItem?.code ?? EMPTY },
          { label: 'Type', value: (shownItem?.lineTypeId && typeOf.get(shownItem.lineTypeId)?.name) || EMPTY },
          { label: 'Keeps Stock', value: shownItem?.lineTypeId ? (typeOf.get(shownItem.lineTypeId)?.keepsStock === false ? 'No' : 'Yes') : EMPTY },
          { label: 'Usual Vendor', value: vendorOf(shownItem?.usualVendorId)?.number ?? vendorOf(shownItem?.usualVendorId)?.name ?? EMPTY },
          { label: 'Usual Price', value: shownItem?.priceCents != null ? formatMoney(shownItem.priceCents) : EMPTY },
          { label: 'Last Ordered', value: shownItem?.lastOrdered ?? EMPTY },
        ]}
        title="Line Details"
      />
    ),
    ITEM_AVAILABILITY: (
      <FactBox
        facts={[
          { label: 'On Hand, All', value: shownItem ? formatCount(shownItem.onHand) : EMPTY },
          { label: `On Hand, ${shownPlace?.code ?? shownPlace?.name ?? 'here'}`, value: shownItem && shownPlace ? formatCount(shownItem.held.find((level) => level.placeId === shownPlace.id)?.quantity ?? 0) : EMPTY },
          { label: 'On Open Orders', value: shownItem ? formatCount(shownItem.onOrder) : EMPTY },
          { label: 'Reorder Level', value: shownItem ? formatCount(shownItem.reorderLevel) : EMPTY },
        ]}
        title="Item Availability"
      />
    ),
    VENDOR_STATISTICS: (
      <FactBox
        facts={[
          { label: 'Vendor No.', value: statsVendor ? (statsVendor.number ?? EMPTY) : EMPTY },
          { label: 'Name', value: statsVendor?.name ?? EMPTY },
          { label: 'Open Orders', value: statsVendor ? formatCount(vendorStats?.openOrders ?? 0) : EMPTY },
          { label: 'Open Amount', value: statsVendor ? formatMoney(vendorStats?.openCents ?? 0) : EMPTY },
          { label: 'Ordered This Year', value: statsVendor ? formatMoney(vendorStats?.orderedThisYearCents ?? 0) : EMPTY },
          { label: 'Last Order', value: vendorStats?.lastOrder ? `${vendorStats.lastOrder.number} · ${formatDay(vendorStats.lastOrder.on)}` : statsVendor ? 'None yet' : EMPTY },
        ]}
        title="Vendor Statistics"
      />
    ),
  };
  const following = boxes.filter((box) => box === 'LINE_DETAILS' || box === 'ITEM_AVAILABILITY' || box === 'VENDOR_STATISTICS').map((box) => FACT_BOXES.find((one) => one.key === box)!.label);
  const companyLabel = (tenantId: string | null) => {
    const row = choices.companies.find((option) => option.tenantId === tenantId) ?? (requisition?.company?.tenantId === tenantId ? requisition?.company : undefined);
    return row ? (row.purchaserCode ? `${row.purchaserCode} · ${row.name}` : row.name) : 'No company';
  };

  return (
    <div className="grid gap-3">
      <RequisitionRibbon
        busy={pending || Boolean(decisions?.ordering)}
        deciding={deciding}
        onAddLow={editing && low.length ? () => addItems(low.map((item) => ({ item, quantity: null }))) : undefined}
        onCancelApproval={can?.recall ? () => void decide('recall').catch(() => undefined) : undefined}
        onCopyDocument={editing ? () => setDialog('copy') : undefined}
        onDelete={editing || can?.cancel ? () => setDialog('delete') : undefined}
        onGoTo={() => go('/purchasing')}
        onMakeOrder={can?.order && decisions?.makeOrder ? decisions.makeOrder : undefined}
        onNew={() => go('/purchasing/requisitions/new')}
        onNext={requisition ? () => void sibling(1)() : undefined}
        onPrevious={requisition ? () => void sibling(-1)() : undefined}
        onPrint={requisition ? onPrint : undefined}
        onReject={can?.reject ? () => setDialog('reject') : undefined}
        onRelease={can?.approve ? () => void decide('approve').catch(() => undefined) : undefined}
        onReopen={can?.reopen ? () => setDialog('reopen') : undefined}
        onSave={editing && complete ? () => save(false) : undefined}
        onScan={editing ? () => setScanning(!scanning) : undefined}
        onSelectFromCategories={editing ? () => setDialog('categories') : undefined}
        onSendApproval={editing && !problem ? () => save(true) : undefined}
        onSendBack={can?.sendBack ? () => setDialog('send-back') : undefined}
        onToggle={toggle}
        orderHint={can?.order ? 'Makes a draft purchase order for each vendor on this requisition that has none yet.' : undefined}
        releaseHint={can?.approveBlocked ?? undefined}
        saveHint={editing && !complete ? 'Finish or delete the lines that are not filled in.' : undefined}
        saving={pending}
        scanning={scanning}
        sendHint={editing ? (problem ?? undefined) : 'Sent already.'}
        shown={shown}
      />

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <DocumentTitle>{title}</DocumentTitle>
        <span className="text-muted-foreground text-sm">{REQUISITION_STATUS_LABEL[requisition?.status ?? 'DRAFT']}</span>
      </div>
      {notice ? (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {decisions?.error && !editing ? (
        <Alert variant="destructive">
          <AlertDescription>{decisions.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 gap-3">
          <FastTab title="General">
            <div className="grid gap-x-6 @2xl:grid-cols-2">
              <div>
                <FieldRow label="No.">
                  <FieldValue>{requisition?.number ?? <span className="text-muted-foreground">Given when it is saved</span>}</FieldValue>
                </FieldRow>
                <FieldRow label="Requisitioner ID">{generalValue(requisition?.requestedBy.code ?? choices.me?.code)}</FieldRow>
                <FieldRow label="Requisitioner Name">{generalValue(requisition?.requestedBy.name ?? choices.me?.name)}</FieldRow>
                <FieldRow htmlFor={editing ? `${ids}-company` : undefined} label="Purchaser Code" required={editing && required('COMPANY')}>
                  {editing ? (
                    <Pick
                      id={`${ids}-company`}
                      label="Purchaser Code"
                      none="No company"
                      onChange={changeCompany}
                      options={choices.companies.map((option) => ({ value: option.tenantId, label: option.purchaserCode ? `${option.purchaserCode} · ${option.name}` : option.name }))}
                      value={company}
                    />
                  ) : (
                    generalValue(companyLabel(requisition?.company?.tenantId ?? null))
                  )}
                </FieldRow>
                {showsField('REQUEST_CODE', editing ? requestCode !== NONE : requisition?.requestCode) ? (
                  <FieldRow htmlFor={editing ? `${ids}-request` : undefined} label="Request Code" required={editing && required('REQUEST_CODE')}>
                    {editing ? (
                      <Pick id={`${ids}-request`} label="Request Code" none="None" onChange={setRequestCode} options={(choices.requestCodes ?? []).map((code) => ({ value: code.id, label: `${code.code} · ${code.name}` }))} value={requestCode} />
                    ) : (
                      generalValue(requisition?.requestCode ? `${requisition.requestCode.code} · ${requisition.requestCode.name}` : null)
                    )}
                  </FieldRow>
                ) : null}
                <FieldRow hint={editing ? 'Each new line goes here.' : undefined} htmlFor={editing ? `${ids}-place` : undefined} label="Location Code" required={editing && required('LOCATION')}>
                  {editing ? (
                    <Pick id={`${ids}-place`} label="Location Code" none="Not decided" onChange={setPlace} options={choices.places.map((option) => ({ value: option.id, label: option.code ? `${option.code} · ${option.name}` : option.name }))} value={place} />
                  ) : (
                    generalValue(requisition?.deliverTo ? (requisition.deliverTo.code ? `${requisition.deliverTo.code} · ${requisition.deliverTo.name}` : requisition.deliverTo.name) : null)
                  )}
                </FieldRow>
                {showsField('COST_CENTER', editing ? costCenter !== NONE : requisition?.costCenter) ? (
                  <FieldRow htmlFor={editing ? `${ids}-cost-center` : undefined} label="Cost Center Code" required={editing && required('COST_CENTER')}>
                    {editing ? (
                      <Pick id={`${ids}-cost-center`} label="Cost Center Code" none="None" onChange={setCostCenter} options={(choices.costCenters ?? []).map((code) => ({ value: code.id, label: `${code.code} · ${code.name}` }))} value={costCenter} />
                    ) : (
                      generalValue(requisition?.costCenter ? `${requisition.costCenter.code} · ${requisition.costCenter.name}` : null)
                    )}
                  </FieldRow>
                ) : null}
              </div>
              <div>
                <FieldRow label="Requisition Date">{generalValue(formatDay(requisition?.requisitionDate ?? businessToday()))}</FieldRow>
                {/* Hidden, a new one's document date is still today's. */}
                {showsField('DOCUMENT_DATE', requisition?.documentDate) ? (
                  <FieldRow htmlFor={editing ? `${ids}-document` : undefined} label="Document Date" required={editing && required('DOCUMENT_DATE')}>
                    {editing ? (
                      <Input className="h-8" id={`${ids}-document`} onChange={(event) => setDocumentDate(event.target.value)} type="date" value={documentDate} />
                    ) : (
                      generalValue(requisition?.documentDate ? formatDay(requisition.documentDate) : null)
                    )}
                  </FieldRow>
                ) : null}
                {showsField('EXPECTED_RECEIPT', editing ? neededBy : requisition?.neededBy) ? (
                  <FieldRow
                    hint={editing ? 'Each new line expects it then.' : undefined}
                    htmlFor={editing ? `${ids}-expected` : undefined}
                    label="Expected Receipt Date"
                    required={editing && required('EXPECTED_RECEIPT')}
                  >
                    {editing ? (
                      <Input aria-label="Expected Receipt Date" className="h-8" id={`${ids}-expected`} onChange={(event) => setNeededBy(event.target.value)} type="date" value={neededBy} />
                    ) : (
                      generalValue(requisition?.neededBy ? formatDay(requisition.neededBy) : null)
                    )}
                  </FieldRow>
                ) : null}
                <FieldRow label="Status">{generalValue(REQUISITION_STATUS_LABEL[requisition?.status ?? 'DRAFT'])}</FieldRow>
                <FieldRow label="Approval Step">{generalValue(approvalStepRange(choices.settings.steps, stepIndex))}</FieldRow>
                <FieldRow label="Approved By">
                  {generalValue(requisition && ['APPROVED', 'ORDERED', 'CLOSED'].includes(requisition.status) ? requisition.decidedBy : null)}
                </FieldRow>
              </div>
            </div>
            {moreShown ? (
              <FieldRow htmlFor={editing ? `${ids}-reason` : undefined} label="Why it is needed">
                {editing ? (
                  <Textarea aria-label="Why it is needed" id={`${ids}-reason`} maxLength={2000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
                ) : (
                  <FieldValue>
                    <span className="whitespace-pre-wrap">{requisition?.reason || EMPTY}</span>
                  </FieldValue>
                )}
              </FieldRow>
            ) : null}
            <div className="mt-1 flex justify-end">
              <Button className="h-6 px-1 text-xs" onClick={() => setMoreShown(!moreShown)} type="button" variant="link">
                <ChevronDownIcon aria-hidden="true" className={cn('size-3.5', moreShown ? 'rotate-180' : '')} />
                {moreShown ? 'Show fewer fields' : 'Show more fields'}
              </Button>
            </div>
          </FastTab>

          <FastTab title="Lines">
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                {editing ? (
                  <>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button className="h-7 px-2" type="button" variant="ghost">
                          Line <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem disabled={!current} onSelect={() => current && insertAbove(current.key)}>
                          Insert New Line Above
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!current} onSelect={() => current && move(current.key, -1)}>
                          Move Line Up
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!current} onSelect={() => current && move(current.key, 1)}>
                          Move Line Down
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem disabled={!current} onSelect={() => current && deleteLine(current.key)}>
                          Delete Line
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button className="h-7 px-2" type="button" variant="ghost">
                          Functions <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onSelect={() => setDialog('copy')}>Copy Document...</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog('categories')}>Select From Item Categories...</DropdownMenuItem>
                        <DropdownMenuItem disabled={!low.length} onSelect={() => addItems(low.map((item) => ({ item, quantity: null })))}>
                          Add Everything That Is Low
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setLines((rows) => [...rows.filter((row) => !isBlank(row)), blankLine(rows.filter((row) => !isBlank(row)).at(-1))])}>Delete Empty Lines</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button className="h-7 px-2" disabled={lines.length >= MOST_REQUISITION_LINES} onClick={addLine} type="button" variant="ghost">
                      <ListPlusIcon aria-hidden="true" />
                      Add New Line
                    </Button>
                    <Button className="h-7 px-2" disabled={!current} onClick={() => current && deleteLine(current.key)} type="button" variant="ghost">
                      <Trash2Icon aria-hidden="true" />
                      Delete Line
                    </Button>
                  </>
                ) : null}
                <Button aria-pressed={finding !== null} className={cn('h-7 px-2', finding !== null ? 'bg-accent' : '')} onClick={() => setFinding(finding === null ? '' : null)} type="button" variant="ghost">
                  <SearchIcon aria-hidden="true" />
                  Find
                </Button>
                <Button
                  aria-pressed={filtering !== null}
                  className={cn('h-7 px-2', filtering !== null ? 'bg-accent' : '')}
                  onClick={() => setFiltering(filtering === null ? { type: ALL, place: ALL, vendor: ALL } : null)}
                  type="button"
                  variant="ghost"
                >
                  <FilterIcon aria-hidden="true" />
                  Filter
                </Button>
              </div>
              {finding !== null ? <Input aria-label="Find in the lines" autoFocus className="h-8 max-w-sm" onChange={(event) => setFinding(event.target.value)} placeholder="Item code, description, notes or vendor" value={finding} /> : null}
              {filtering ? (
                <div className="grid max-w-3xl gap-2 sm:grid-cols-3">
                  <Pick label="Filter by type" none={undefined} onChange={(type) => setFiltering({ ...filtering, type })} options={[{ value: ALL, label: 'Every type' }, ...distinct('type').map((value) => ({ value, label: value }))]} value={filtering.type} />
                  <Pick label="Filter by location" onChange={(placeCode) => setFiltering({ ...filtering, place: placeCode })} options={[{ value: ALL, label: 'Every location' }, ...distinct('place').map((value) => ({ value, label: value }))]} value={filtering.place} />
                  <Pick label="Filter by vendor" onChange={(vendor) => setFiltering({ ...filtering, vendor })} options={[{ value: ALL, label: 'Every vendor' }, ...distinct('vendor').map((value) => ({ value, label: value }))]} value={filtering.vendor} />
                </div>
              ) : null}
              {narrowed ? (
                <p className="text-muted-foreground text-xs" role="status">
                  Showing {formatCount(visible.size)} of {formatCount(views.length)} {views.length === 1 ? 'line' : 'lines'}.{' '}
                  <Button
                    className="h-auto p-0 text-xs"
                    onClick={() => {
                      setFinding(null);
                      setFiltering(null);
                    }}
                    type="button"
                    variant="link"
                  >
                    Show them all
                  </Button>
                </p>
              ) : null}
              {scanning && editing ? (
                <ScanField
                  className="max-w-md"
                  hint="Scan a label to add the item. Scan it again for one more."
                  id={`${ids}-scan`}
                  items={offered}
                  missing={(code) => (choices.items.some((item) => item.code === code) ? `${code} is bought for another company.` : `No item has the code ${code}.`)}
                  onItem={scan}
                />
              ) : null}

              <Sheet label="Lines" className="min-w-[96rem]">
                <SheetHead columns={editing ? lineColumns : lineColumns.map((column) => ({ ...column, required: false }))} />
                {editing ? (
                  <SheetBody onKeyDown={sheetKeys(() => (lines.at(-1) && !isBlank(lines.at(-1)!) ? addLine() : undefined))}>
                    {lines.map((line, index) => {
                      if (!isBlank(line) && !visible.has(line.key)) return null;
                      const item = itemOf.get(line.itemId);
                      const parsed = isBlank(line) ? null : parse(line);
                      const name = item?.name ?? `line ${index + 1}`;
                      const fill = (field: Filled) => (line.filled.includes(field) ? 'bg-warning/15' : '');
                      return (
                        <tr className={cn(line.key === currentKey ? 'bg-accent/40' : 'hover:bg-muted/40')} key={line.key} onFocusCapture={() => setCurrentKey(line.key)}>
                          <RowNumber current={line.key === currentKey} n={index + 1} />
                          <td className={CELL}>
                            <Pick
                              cell
                              label={`Type of line ${index + 1}`}
                              onChange={(typeId) => setLine(line.key, { typeId, ...(item?.lineTypeId && item.lineTypeId !== typeId ? { itemId: NONE } : {}) })}
                              options={lineTypes.map((type) => ({ value: type.id, label: type.name }))}
                              value={line.typeId}
                            />
                          </td>
                          <td className={CELL}>
                            <ItemCodePicker
                              canMakeItemCodes={Boolean(choices.canMakeItemCodes)}
                              companyCode={companyRow?.purchaserCode ?? companyRow?.name ?? 'The'}
                              id={`${ids}-item-${line.key}`}
                              items={offeredFor(line)}
                              label={`Item on line ${index + 1}`}
                              onAdvanced={() => setAdvancedFor(line.key)}
                              onHighlight={setHighlighted}
                              onPick={(picked) => pickFor(line, picked)}
                              value={item ?? null}
                              variant="cell"
                            />
                          </td>
                          <td className={cn(CELL, fill('description'))}>
                            <input aria-label={`Description of ${name}`} className={CELL_INPUT} maxLength={200} onChange={(event) => setLine(line.key, { description: event.target.value }, 'description')} value={line.description} />
                          </td>
                          <td className={cn(CELL, fill('place'))}>
                            <Pick cell label={`Location of ${name}`} none="None" onChange={(placeId) => setLine(line.key, { placeId }, 'place')} options={choices.places.map((option) => ({ value: option.id, label: option.code ?? option.name }))} value={line.placeId} />
                          </td>
                          <td className={cn(CELL, fill('quantity'))}>
                            <input aria-label={`Quantity of ${name}`} className={cn(CELL_INPUT, 'text-right tabular-nums')} inputMode="numeric" onChange={(event) => setLine(line.key, { quantity: event.target.value }, 'quantity')} value={line.quantity} />
                          </td>
                          <td className={cn(CELL_TEXT, 'text-muted-foreground')}>{item?.unit ?? ''}</td>
                          <td className={cn(CELL, fill('cost'))}>
                            <input aria-label={`Direct unit cost of ${name}`} className={cn(CELL_INPUT, 'text-right tabular-nums')} inputMode="decimal" onChange={(event) => setLine(line.key, { cost: event.target.value }, 'cost')} placeholder={isBlank(line) ? '' : '0.00'} value={line.cost} />
                          </td>
                          <td className={cn(CELL_TEXT, 'text-right tabular-nums')}>{parsed ? formatMoney(parsed.quantity * parsed.estimatedUnitCostCents) : ''}</td>
                          <td className={cn(CELL, fill('expected'))}>
                            <input aria-label={`Expected receipt date of ${name}`} className={CELL_INPUT} onChange={(event) => setLine(line.key, { expectedOn: event.target.value }, 'expected')} type="date" value={line.expectedOn} />
                          </td>
                          <td className={cn(CELL, fill('vendor'))}>
                            <Pick cell label={`Vendor of ${name}`} none="None" onChange={(vendorId) => setLine(line.key, { vendorId }, 'vendor')} options={choices.vendors.map((option) => ({ value: option.id, label: option.number ? `${option.number} · ${option.name}` : option.name }))} value={line.vendorId} />
                          </td>
                          {showsNotes ? (
                            <td className={CELL}>
                              <input aria-label={`Notes on ${name}`} className={CELL_INPUT} maxLength={1000} onChange={(event) => setLine(line.key, { notes: event.target.value })} value={line.notes} />
                            </td>
                          ) : null}
                          {showsDepartment ? (
                            <td className={cn(CELL, fill('department'))}>
                              <Pick cell label={`Department of ${name}`} none="None" onChange={(departmentId) => setLine(line.key, { departmentId }, 'department')} options={(choices.departments ?? []).map((code) => ({ value: code.id, label: code.code }))} value={line.departmentId} />
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </SheetBody>
                ) : (
                  <SheetBody onKeyDown={sheetKeys()}>
                    {(requisition?.lines ?? []).map((line, index) =>
                      visible.has(line.id) ? (
                        <tr className={cn(line.id === currentKey ? 'bg-accent/40' : 'hover:bg-muted/40')} key={line.id} onClick={() => setCurrentKey(line.id)}>
                          <RowNumber current={line.id === currentKey} n={index + 1} />
                          <td className={CELL_TEXT}>{line.lineType?.name ?? EMPTY}</td>
                          <td className={cn(CELL_TEXT, 'font-mono font-semibold')}>{line.item?.code ?? EMPTY}</td>
                          <td className={CELL_TEXT}>{line.description ?? line.item?.name}</td>
                          <td className={CELL_TEXT}>{line.place?.code ?? line.place?.name ?? EMPTY}</td>
                          <td className={cn(CELL_TEXT, 'text-right tabular-nums')}>{formatCount(line.quantity)}</td>
                          <td className={cn(CELL_TEXT, 'text-muted-foreground')}>{line.item?.unit ?? ''}</td>
                          <td className={cn(CELL_TEXT, 'text-right tabular-nums')}>{dollars(line.estimatedUnitCostCents)}</td>
                          <td className={cn(CELL_TEXT, 'text-right tabular-nums')}>{formatMoney(line.quantity * line.estimatedUnitCostCents)}</td>
                          <td className={CELL_TEXT}>{line.expectedOn ? formatDay(line.expectedOn) : EMPTY}</td>
                          <td className={CELL_TEXT}>{line.vendor ? (line.vendor.number ?? line.vendor.name) : EMPTY}</td>
                          {showsNotes ? (
                            <td className={cn(CELL_TEXT, 'max-w-56 truncate')} title={line.notes ?? undefined}>
                              {line.notes ?? ''}
                            </td>
                          ) : null}
                          {showsDepartment ? <td className={CELL_TEXT}>{line.department?.code ?? EMPTY}</td> : null}
                        </tr>
                      ) : null,
                    )}
                  </SheetBody>
                )}
              </Sheet>

              <div className="grid gap-x-6 pt-1 @2xl:grid-cols-2">
                <div>
                  <FieldRow label="Lines">
                    <FieldValue>{formatCount(shownLines.length)}</FieldValue>
                  </FieldRow>
                  <FieldRow label="Total Quantity">
                    <FieldValue>{formatCount(totalQuantity)}</FieldValue>
                  </FieldRow>
                </div>
                <div>
                  <FieldRow label="Total Excl. Tax (USD)">
                    <FieldValue>
                      <span className="tabular-nums">{dollars(totalCents)}</span>
                    </FieldValue>
                  </FieldRow>
                  <FieldRow label="Total Tax (USD)">
                    <FieldValue>
                      <span className="tabular-nums" title="A requisition is estimated before tax; the purchase order adds the sales tax.">
                        {dollars(0)}
                      </span>
                    </FieldValue>
                  </FieldRow>
                  <FieldRow label="Total Incl. Tax (USD)">
                    <FieldValue>
                      <span className="font-semibold tabular-nums">{dollars(totalCents)}</span>
                    </FieldValue>
                  </FieldRow>
                </div>
              </div>
              {editing ? (
                <p className="text-muted-foreground text-xs">
                  <span className="bg-warning/15 rounded-sm px-1.5">Yellow</span> = filled in from the item code once it was picked (description, location, quantity, unit cost, expected date, vendor, department). Each can still be
                  changed. Only codes of the line&rsquo;s type and the requisition&rsquo;s company are offered. ↑ ↓ move between lines; a blank line is not saved.
                </p>
              ) : null}
            </div>
          </FastTab>

          <FastTab defaultOpen={quotes.length > 0 || overLimit} title="Quotes">
            {editing ? (
              <div className="grid gap-3">
                <p className="text-muted-foreground text-xs">
                  {step.quotesNeeded
                    ? `At this amount, ${step.quotesNeeded} ${step.quotesNeeded === 1 ? 'is' : 'are'} needed, with one chosen.`
                    : 'Optional at this amount. With any, one is chosen.'}
                </p>
                {quotes.map((quote, index) => (
                  <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]" key={quote.key}>
                    <FieldRow htmlFor={`${quote.key}-vendor`} label="Vendor">
                      <Pick id={`${quote.key}-vendor`} label="Vendor" none="Choose a vendor" onChange={(vendorId) => setQuote(quote.key, { vendorId })} options={choices.vendors.map((option) => ({ value: option.id, label: option.name }))} value={quote.vendorId} />
                    </FieldRow>
                    <Input aria-label={`Total of quote ${index + 1}`} className="h-8" inputMode="decimal" onChange={(event) => setQuote(quote.key, { total: event.target.value })} placeholder="Total" value={quote.total} />
                    <Input aria-label={`Delivery of quote ${index + 1}`} className="h-8" maxLength={80} onChange={(event) => setQuote(quote.key, { delivery: event.target.value })} placeholder="Delivery: 3 days" value={quote.delivery} />
                    {quote.chosen ? (
                      <Badge className="mb-1.5" variant="success">
                        Chosen
                      </Badge>
                    ) : (
                      <Button aria-label={`Choose quote ${index + 1}`} onClick={() => setQuotes((rows) => rows.map((row) => ({ ...row, chosen: row.key === quote.key })))} size="sm" type="button" variant="outline">
                        Choose
                      </Button>
                    )}
                    <Button aria-label={`Remove quote ${index + 1}`} onClick={() => setQuotes((rows) => rows.filter((row) => row.key !== quote.key))} size="sm" type="button" variant="outline">
                      Remove
                    </Button>
                  </div>
                ))}
                {choices.vendors.length ? (
                  <Button
                    className="justify-self-start"
                    disabled={quotes.length >= MOST_REQUISITION_QUOTES}
                    onClick={() => setQuotes((rows) => [...rows, { key: key(), vendorId: NONE, total: '', delivery: '', chosen: rows.length === 0 }])}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Add a quote
                  </Button>
                ) : (
                  <p className="text-muted-foreground text-xs">Add the vendor on Inventory, under Vendors, to record its quote.</p>
                )}
              </div>
            ) : requisition?.quotes.length ? (
              <Sheet label="Quotes">
                <SheetHead columns={[{ key: 'vendor', label: 'Vendor' }, { key: 'total', label: 'Total', numeric: true }, { key: 'delivery', label: 'Delivery' }, { key: 'chosen', label: 'Chosen' }]} />
                <SheetBody>
                  {requisition.quotes.map((quote, index) => (
                    <tr key={quote.id}>
                      <RowNumber n={index + 1} />
                      <td className={CELL_TEXT}>{quote.vendor.name}</td>
                      <td className={cn(CELL_TEXT, 'text-right tabular-nums')}>{formatMoney(quote.totalCents)}</td>
                      <td className={CELL_TEXT}>{quote.delivery ?? EMPTY}</td>
                      <td className={CELL_TEXT}>{quote.chosen ? <Badge variant="success">Chosen</Badge> : ''}</td>
                    </tr>
                  ))}
                </SheetBody>
              </Sheet>
            ) : (
              <p className="text-muted-foreground text-sm">No quotes.</p>
            )}
          </FastTab>

          {shown.comments ? <CommentsTab id={`${ids}-comments`} requisition={requisition} /> : null}

          {requisition ? (
            <FastTab defaultOpen={readOnly} title="History">
              <ol aria-label="History, newest first" className="grid gap-2.5">
                {requisition.history.map((entry, index) => (
                  <li className="grid gap-0.5 text-sm" key={`${entry.at}-${index}`}>
                    <span>
                      {entry.by} {entry.what}
                    </span>
                    <span className="text-muted-foreground text-xs">{formatDateTime(entry.at)}</span>
                  </li>
                ))}
              </ol>
            </FastTab>
          ) : null}
        </div>

        <aside className="grid gap-3">
          {boxes.includes('STATISTICS') ? null : <div className="px-1">{sendNotes}</div>}
          {boxes.map((box) => (
            <Fragment key={box}>{factBox[box]}</Fragment>
          ))}
          {/* Opened from the ribbon: beside Attachments, or last when the office hides Attachments. */}
          {boxes.includes('ATTACHMENTS') ? null : openedBoxes}
          {following.length ? (
            <p className="text-muted-foreground px-1 text-xs">
              {following.length === 1 ? `${following[0]} follows` : `${following.slice(0, -1).join(', ')} and ${following.at(-1)} follow`} the line the cursor is on, and the item the dropdown is on.
            </p>
          ) : null}
        </aside>
      </div>

      {advancedLine ? (
        <ItemLookupDialog
          categories={choices.categories ?? []}
          companyName={companyRow?.name ?? 'no company'}
          items={offeredFor(advancedLine)}
          lineTypes={lineTypes}
          onClose={() => setAdvancedFor(null)}
          onPick={(picked) => {
            pickFor(advancedLine, picked);
            setAdvancedFor(null);
          }}
          vendors={choices.vendors}
        />
      ) : null}
      <AlertDialog onOpenChange={(open) => (open ? undefined : setLeaveTo(null))} open={leaveTo !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>{LEAVE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const then = leaveTo;
                setLeaveTo(null);
                setChanged(false);
                then?.();
              }}
            >
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {dialog === 'copy' ? <CopyDocumentDialog currentId={requisition?.id} onClose={() => setDialog(null)} onCopy={copyFrom} /> : null}
      {dialog === 'categories' ? (
        <CategoriesDialog categories={choices.categories ?? []} items={offered.filter((item) => !used.has(item.id))} onAdd={(picked) => addItems(picked)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteDialog
          name={requisition?.number ?? 'this requisition'}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setChanged(false);
            if (editing) onDiscard();
            else void decide('cancel').catch(() => undefined);
          }}
          saved={Boolean(requisition)}
        />
      ) : null}
      {dialog === 'send-back' ? (
        <NoteDialog
          confirmLabel="Send Back"
          description={`Back to ${requisition?.requestedBy.name ?? 'whoever asked'} to change, with your note.`}
          onClose={() => setDialog(null)}
          onConfirm={(note) => decide('send-back', note)}
          required
          title="Send it back"
        />
      ) : null}
      {dialog === 'reject' ? (
        <NoteDialog
          confirmLabel="Reject"
          danger
          description="Nothing is bought. Whoever asked reads your note."
          onClose={() => setDialog(null)}
          onConfirm={(note) => decide('reject', note)}
          required
          title="Reject it"
        />
      ) : null}
      {dialog === 'reopen' ? (
        <NoteDialog
          confirmLabel="Reopen"
          description="Back to its requester to change. Its approval is cleared, so it is approved again before an order is made."
          onClose={() => setDialog(null)}
          onConfirm={(note) => decide('reopen', note || undefined)}
          required={false}
          title={`Reopen ${requisition?.number ?? 'it'}`}
        />
      ) : null}
    </div>
  );
}

/** A saved line as the form holds it: nothing marked, as nobody has just picked it. */
function draftOf(line: RequisitionLine, choices: RequisitionChoices): LineDraft {
  const item = line.item ? choices.items.find((option) => option.id === line.item!.id) : undefined;
  return {
    key: key(),
    typeId: item?.lineTypeId ?? firstType(choices),
    itemId: line.item?.id ?? NONE,
    description: line.description ?? line.item?.name ?? '',
    placeId: line.place?.id ?? NONE,
    quantity: String(line.quantity),
    cost: dollars(line.estimatedUnitCostCents),
    expectedOn: line.expectedOn ?? '',
    vendorId: line.vendor?.id ?? NONE,
    departmentId: line.department?.id ?? NONE,
    notes: line.notes ?? '',
    filled: [],
  };
}

/** A NAV-style dropdown: a list to choose from, with "none" first where none may be chosen. `cell`: drawn as a cell of the grid. */
function Pick({ id, label, value, onChange, options, none, cell }: { id?: string; label: string; value: string; onChange: (value: string) => void; options: readonly { value: string; label: string }[]; none?: string; cell?: boolean }) {
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger
        aria-label={label}
        className={cn(
          'w-full',
          cell
            ? // A cell reads as its words, as the canvas draws it; its ▾ shows on hover and while it is being changed.
              'focus-visible:ring-primary h-8 rounded-none border-0 bg-transparent px-2 shadow-none focus-visible:ring-2 focus-visible:ring-inset dark:bg-transparent [&>svg]:opacity-0 hover:[&>svg]:opacity-100 focus-visible:[&>svg]:opacity-100 data-[state=open]:[&>svg]:opacity-100'
            : 'h-8',
        )}
        id={id}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {none ? <SelectItem value={NONE}>{none}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** On hand, marked when it is at or below the item's reorder level. */
export function StockFigure({ onHand, reorderLevel }: { onHand: number; reorderLevel: number }) {
  const status = stockStatus(onHand, reorderLevel);
  if (status === 'ENOUGH') return <>{formatCount(onHand)}</>;
  return <Badge variant={status === 'OUT' ? 'destructive' : 'warning'}>{formatCount(onHand)}</Badge>;
}
