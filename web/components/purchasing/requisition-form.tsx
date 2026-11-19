'use client';

import {
  MOST_REQUISITION_LINES,
  MOST_REQUISITION_QUOTES,
  REQUISITION_STATUS_LABEL,
  formatMoney,
  parseMoney,
  requisitionSubmitProblem,
  requisitionTotalCents,
  stockStatus,
  type RequisitionChoices,
  type RequisitionDetail,
  type RequisitionLine,
  type RequisitionLineInput,
  type SaveRequisitionInput,
} from '@texasrenters/shared';
import { ListPlusIcon, ScanBarcodeIcon, SendIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';

import { ScanField } from '@/components/inventory/scan-field';
import { AttachmentsFactBox } from '@/components/purchasing/attachments-factbox';
import { FactBox, FastTab, FieldRow, FieldValue, Ribbon, RibbonButton, RibbonGroup } from '@/components/purchasing/nav-kit';
import { ItemCodePicker, ItemLookupDialog, type PickerItem } from '@/components/purchasing/item-picker';
import { approverFor } from '@/components/purchasing/requisition-parts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { businessToday } from '@/lib/clock';
import { EMPTY, formatCount, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The purchase requisition as its author fills it in, laid out as classic NAV
 * (2026-11-20, approved on the canvas): a ribbon, the General FastTab with
 * "Label:" beside each field, the Lines grid, the quotes, and FactBoxes down
 * the right that follow the line the cursor is on.
 *
 * A line's item code is a dropdown: type part of a code or a description, or
 * scan a label, and Enter takes it. Picking an item fills the rest of the line
 * from it -- description, location, unit, cost, expected date, vendor and
 * department -- in yellow until it is changed. Everything is matched in the
 * rows the page already holds; nothing is asked of the server while typing.
 *
 * Saved whole: a save replaces its lines and quotes. It only prepares the
 * request; what may be submitted, and who approves it, the server decides.
 */

const NONE = 'none';
const chosen = (value: string) => (value === NONE ? null : value);
const whole = (value: string) => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value.trim()) : null);
const money = (value: string) => (value.trim() ? parseMoney(value) : null);
const dollars = (cents: number) => (cents / 100).toFixed(2);
/** An amount for a field that may hold none. */
const dollars0 = (cents: number | null | undefined) => (cents == null ? '' : dollars(cents));

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

let made = 0;
const key = () => `row-${(made += 1)}`;

/** The line type an item is, or the office's first: Item. */
function firstType(choices: RequisitionChoices): string {
  const types = choices.lineTypes ?? [];
  return (types.find((type) => type.code === 'ITEM') ?? types[0])?.id ?? NONE;
}

export function RequisitionForm({
  choices,
  requisition,
  start,
  onSave,
  pending,
  error,
  onDiscard,
  discardLabel,
}: {
  choices: RequisitionChoices;
  /** The requisition being changed; none for a new one. */
  requisition?: RequisitionDetail;
  /** Items to begin a new one with, from the Reorder list. The company is theirs; one of another company is left off. */
  start?: { itemId: string; quantity: number }[];
  /** Saves it, and submits it when asked. Resolves once done; a refusal is shown from `error`. */
  onSave: (input: SaveRequisitionInput, submit: boolean) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
  onDiscard: () => void;
  discardLabel: string;
}) {
  const ids = useId();
  const itemOf = new Map(choices.items.map((item) => [item.id, item]));
  const lineTypes = choices.lineTypes ?? [];
  const typeOf = new Map(lineTypes.map((type) => [type.id, type]));

  // A new one begun from the Reorder list is for the company of the first item on it.
  const begun = requisition ? [] : (start ?? []).flatMap((line) => choices.items.filter((item) => item.id === line.itemId).map((item) => ({ item, quantity: line.quantity })));
  const begunFor = begun[0]?.item.companyTenantId;
  const [company, setCompany] = useState(requisition?.company?.tenantId ?? (requisition ? NONE : (begunFor ?? choices.companies[0]?.tenantId ?? NONE)));
  const [neededBy, setNeededBy] = useState(requisition?.neededBy ?? '');
  const [place, setPlace] = useState(requisition?.deliverTo?.id ?? (requisition ? NONE : (choices.places[0]?.id ?? NONE)));
  const [requestCode, setRequestCode] = useState(requisition?.requestCode?.id ?? NONE);
  const [costCenter, setCostCenter] = useState(requisition?.costCenter?.id ?? NONE);
  const [documentDate, setDocumentDate] = useState(requisition?.documentDate ?? businessToday());
  const [reason, setReason] = useState(requisition?.reason ?? '');
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

  const [lines, setLines] = useState<LineDraft[]>(
    () =>
      requisition?.lines.map((line) => draftOf(line, choices)) ??
      begun.filter(({ item }) => item.companyTenantId === begunFor).map(({ item, quantity }) => ({ ...filledLine(item, quantity), filled: [] })),
  );
  const [quotes, setQuotes] = useState<QuoteDraft[]>(
    () => requisition?.quotes.map((quote) => ({ key: key(), vendorId: quote.vendor.id, total: dollars(quote.totalCents), delivery: quote.delivery ?? '', chosen: quote.chosen })) ?? [],
  );
  /** The line the cursor is on, and the item the dropdown is on: the FactBoxes follow them. */
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<PickerItem | null>(null);
  const [advancedFor, setAdvancedFor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

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
    setLines((rows) => rows.map((row) => (row.key === line.key ? filledLine(item, null, row, rows[index - 1]) : row)));
    setCurrentKey(line.key);
  };
  const newLine = (): LineDraft => ({ key: key(), typeId: firstType(choices), itemId: NONE, description: '', placeId: place, quantity: '', cost: '', expectedOn: neededBy, vendorId: NONE, departmentId: lines.at(-1)?.departmentId ?? NONE, notes: '', filled: [] });
  /** A scanned label: one more of an item already asked for, else a new line for it. */
  const scan = (item: { id: string; code: string }): string | void => {
    const on = lines.find((line) => line.itemId === item.id);
    if (on) return setLine(on.key, { quantity: String((whole(on.quantity) ?? 0) + 1) });
    const picked = itemOf.get(item.id);
    if (!picked) return;
    const empty = lines.find((line) => line.itemId === NONE);
    if (empty) return pickFor(empty, picked);
    if (lines.length >= MOST_REQUISITION_LINES) return `A requisition holds ${MOST_REQUISITION_LINES} lines.`;
    setLines((rows) => [...rows, filledLine(picked, null, {}, rows.at(-1))]);
  };
  const low = offered.filter((item) => !used.has(item.id) && stockStatus(item.onHand, item.reorderLevel) !== 'ENOUGH');

  function changeCompany(next: string) {
    setCompany(next);
    // Its items are its own company's: lines for another company's items would be refused.
    setLines((rows) => rows.filter((row) => row.itemId === NONE || itemOf.get(row.itemId)?.companyTenantId === chosen(next)));
  }

  // What the form holds, as the request; null while any row is unfinished.
  const parsedLines = lines.map((line): RequisitionLineInput | null => {
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
  });
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
  const totalCents = requisitionTotalCents(input.lines);
  const problem = complete ? requisitionSubmitProblem(input, choices.settings) : 'Finish or delete the lines that are not filled in.';
  const overLimit = totalCents > choices.settings.approvalLimitCents;
  const vendorsNamed = new Set(input.lines.flatMap((line) => (line.vendorId ? [line.vendorId] : []))).size;

  const save = (submit: boolean) => {
    if (pending || !complete || (submit && problem)) return;
    void onSave(input, submit).catch(() => undefined);
  };

  // The FactBoxes: the item the dropdown is on, else the current line's.
  const current = lines.find((line) => line.key === currentKey);
  const shownItem = highlighted ?? (current ? itemOf.get(current.itemId) : undefined);
  const shownPlace = choices.places.find((option) => option.id === (current?.placeId !== NONE ? current?.placeId : place));
  const vendorOf = (vendorId: string | null | undefined) => choices.vendors.find((option) => option.id === vendorId);
  const advancedLine = lines.find((line) => line.key === advancedFor);

  return (
    <div className="grid gap-3">
      <Ribbon label="Requisition actions">
        <RibbonGroup caption="Manage">
          <div className="grid">
            <RibbonButton busy={pending} disabled={!complete} label="Save" onClick={() => save(false)} />
            <RibbonButton disabled={pending} label={discardLabel} onClick={onDiscard} tone="danger" />
          </div>
        </RibbonGroup>
        <RibbonGroup caption="Request Approval">
          <RibbonButton busy={pending} disabled={Boolean(problem)} icon={SendIcon} label="Send Approval Request" onClick={() => save(true)} />
        </RibbonGroup>
        <RibbonGroup caption="Prepare">
          <div className="grid">
            <RibbonButton disabled={!low.length} label="Add Everything That Is Low" onClick={() => setLines((rows) => [...rows.filter((row) => row.itemId !== NONE), ...low.map((item) => filledLine(item, null, {}, rows.at(-1)))].slice(0, MOST_REQUISITION_LINES))} />
            <RibbonButton icon={undefined} label={scanning ? 'Stop Scanning' : 'Scan Items'} onClick={() => setScanning(!scanning)} />
          </div>
        </RibbonGroup>
      </Ribbon>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 gap-3">
          <FastTab
            action={
              <Button className="h-6 px-1 text-xs" onClick={() => setMoreShown(!moreShown)} type="button" variant="link">
                {moreShown ? 'Show fewer fields' : 'Show more fields'}
              </Button>
            }
            title="General"
          >
            <div className="grid gap-x-6 @2xl:grid-cols-2">
              <div>
                <FieldRow label="No.">
                  <FieldValue>{requisition?.number ?? <span className="text-muted-foreground">Given when it is saved</span>}</FieldValue>
                </FieldRow>
                <FieldRow label="Requisitioner ID">
                  <FieldValue>{requisition?.requestedBy.code ?? choices.me?.code ?? EMPTY}</FieldValue>
                </FieldRow>
                <FieldRow label="Requisitioner Name">
                  <FieldValue>{requisition?.requestedBy.name ?? choices.me?.name ?? EMPTY}</FieldValue>
                </FieldRow>
                <FieldRow htmlFor={`${ids}-company`} label="Purchaser Code">
                  <Pick
                    id={`${ids}-company`}
                    label="Purchaser Code"
                    none="No company"
                    onChange={changeCompany}
                    options={choices.companies.map((option) => ({ value: option.tenantId, label: option.purchaserCode ? `${option.purchaserCode} · ${option.name}` : option.name }))}
                    value={company}
                  />
                </FieldRow>
                <FieldRow htmlFor={`${ids}-request`} label="Request Code">
                  <Pick id={`${ids}-request`} label="Request Code" none="None" onChange={setRequestCode} options={(choices.requestCodes ?? []).map((code) => ({ value: code.id, label: `${code.code} · ${code.name}` }))} value={requestCode} />
                </FieldRow>
                <FieldRow htmlFor={`${ids}-place`} hint="Each new line goes here." label="Location Code">
                  <Pick id={`${ids}-place`} label="Location Code" none="Not decided" onChange={setPlace} options={choices.places.map((option) => ({ value: option.id, label: option.code ? `${option.code} · ${option.name}` : option.name }))} value={place} />
                </FieldRow>
                <FieldRow htmlFor={`${ids}-cost-center`} label="Cost Center Code">
                  <Pick id={`${ids}-cost-center`} label="Cost Center Code" none="None" onChange={setCostCenter} options={(choices.costCenters ?? []).map((code) => ({ value: code.id, label: `${code.code} · ${code.name}` }))} value={costCenter} />
                </FieldRow>
              </div>
              <div>
                <FieldRow label="Requisition Date">
                  <FieldValue>{formatDay(requisition?.requisitionDate ?? businessToday())}</FieldValue>
                </FieldRow>
                <FieldRow htmlFor={`${ids}-document`} label="Document Date">
                  <Input className="h-8" id={`${ids}-document`} onChange={(event) => setDocumentDate(event.target.value)} type="date" value={documentDate} />
                </FieldRow>
                <FieldRow htmlFor={`${ids}-expected`} hint="Each new line expects it then." label="Expected Receipt Date">
                  <Input aria-label="Expected Receipt Date" className="h-8" id={`${ids}-expected`} onChange={(event) => setNeededBy(event.target.value)} type="date" value={neededBy} />
                </FieldRow>
                <FieldRow label="Status">
                  <FieldValue>{REQUISITION_STATUS_LABEL[requisition?.status ?? 'DRAFT']}</FieldValue>
                </FieldRow>
                <FieldRow label="Approval Limit">
                  <FieldValue>{formatMoney(choices.settings.approvalLimitCents)}</FieldValue>
                </FieldRow>
              </div>
            </div>
            {moreShown ? (
              <FieldRow htmlFor={`${ids}-reason`} label="Why it is needed">
                <Textarea aria-label="Why it is needed" id={`${ids}-reason`} maxLength={2000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
              </FieldRow>
            ) : null}
          </FastTab>

          <FastTab title="Lines">
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Button className="h-7 px-1.5" disabled={lines.length >= MOST_REQUISITION_LINES} onClick={() => setLines((rows) => [...rows, newLine()])} type="button" variant="ghost">
                  <ListPlusIcon aria-hidden="true" />
                  Add New Line
                </Button>
                <Button className="h-7 px-1.5" disabled={!current} onClick={() => current && setLines((rows) => rows.filter((row) => row.key !== current.key))} type="button" variant="ghost">
                  <Trash2Icon aria-hidden="true" />
                  Delete Line
                </Button>
                <Button className="h-7 px-1.5" onClick={() => setScanning(!scanning)} type="button" variant="ghost">
                  <ScanBarcodeIcon aria-hidden="true" />
                  {scanning ? 'Stop scanning' : 'Scan'}
                </Button>
              </div>
              {scanning ? (
                <ScanField
                  className="max-w-md"
                  hint="Scan a label to add the item. Scan it again for one more."
                  id={`${ids}-scan`}
                  items={offered}
                  missing={(code) => (choices.items.some((item) => item.code === code) ? `${code} is bought for another company.` : `No item has the code ${code}.`)}
                  onItem={scan}
                />
              ) : null}
              {lines.length ? (
                <div className="overflow-x-auto rounded-sm border">
                  <Table aria-label="Lines" className="min-w-[88rem] text-sm">
                    {/* Static: this box scrolls sideways at every width, and a sticky header inside it is shoved down over the first line (see components/ui/table.tsx). */}
                    <TableHeader className="lg:static">
                      <TableRow>
                        <TableHead className="w-28">Type</TableHead>
                        <TableHead className="w-40">Item Code</TableHead>
                        <TableHead className="w-56">Description</TableHead>
                        <TableHead className="w-36">Location Code</TableHead>
                        <TableHead className="w-20 text-right">Quantity</TableHead>
                        <TableHead className="w-16">UoM</TableHead>
                        <TableHead className="w-28 text-right">Direct Unit Cost</TableHead>
                        <TableHead className="w-28 text-right">Line Amount</TableHead>
                        <TableHead className="w-36">Expected Receipt Date</TableHead>
                        <TableHead className="w-40">Vendor No.</TableHead>
                        <TableHead className="w-48">Notes</TableHead>
                        <TableHead className="w-36">Department Code</TableHead>
                        <TableHead className="w-10">
                          <span className="sr-only">Delete</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line, index) => {
                        const item = itemOf.get(line.itemId);
                        const parsed = parsedLines[index];
                        const name = item?.name ?? `line ${index + 1}`;
                        const fill = (field: Filled) => (line.filled.includes(field) ? 'bg-warning/15' : '');
                        return (
                          <TableRow className={cn(line.key === currentKey ? 'bg-accent/50' : '')} key={line.key} onFocusCapture={() => setCurrentKey(line.key)}>
                            <TableCell className="p-1">
                              <Pick
                                compact
                                label={`Type of line ${index + 1}`}
                                onChange={(typeId) => setLine(line.key, { typeId, ...(item?.lineTypeId && item.lineTypeId !== typeId ? { itemId: NONE } : {}) })}
                                options={lineTypes.map((type) => ({ value: type.id, label: type.name }))}
                                value={line.typeId}
                              />
                            </TableCell>
                            <TableCell className="p-1">
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
                              />
                            </TableCell>
                            <TableCell className={cn('p-1', fill('description'))}>
                              <Input aria-label={`Description of ${name}`} className="h-8" maxLength={200} onChange={(event) => setLine(line.key, { description: event.target.value }, 'description')} value={line.description} />
                            </TableCell>
                            <TableCell className={cn('p-1', fill('place'))}>
                              <Pick compact label={`Location of ${name}`} none="None" onChange={(placeId) => setLine(line.key, { placeId }, 'place')} options={choices.places.map((option) => ({ value: option.id, label: option.code ?? option.name }))} value={line.placeId} />
                            </TableCell>
                            <TableCell className={cn('p-1', fill('quantity'))}>
                              <Input aria-label={`Quantity of ${name}`} className="h-8 text-right" inputMode="numeric" onChange={(event) => setLine(line.key, { quantity: event.target.value }, 'quantity')} value={line.quantity} />
                            </TableCell>
                            <TableCell className="text-muted-foreground p-1">{item?.unit ?? ''}</TableCell>
                            <TableCell className={cn('p-1', fill('cost'))}>
                              <Input aria-label={`Direct unit cost of ${name}`} className="h-8 text-right" inputMode="decimal" onChange={(event) => setLine(line.key, { cost: event.target.value }, 'cost')} placeholder="0.00" value={line.cost} />
                            </TableCell>
                            <TableCell className="p-1 text-right font-mono tabular-nums">{parsed ? formatMoney(parsed.quantity * parsed.estimatedUnitCostCents) : ''}</TableCell>
                            <TableCell className={cn('p-1', fill('expected'))}>
                              <Input aria-label={`Expected receipt date of ${name}`} className="h-8" onChange={(event) => setLine(line.key, { expectedOn: event.target.value }, 'expected')} type="date" value={line.expectedOn} />
                            </TableCell>
                            <TableCell className={cn('p-1', fill('vendor'))}>
                              <Pick compact label={`Vendor of ${name}`} none="None" onChange={(vendorId) => setLine(line.key, { vendorId }, 'vendor')} options={choices.vendors.map((option) => ({ value: option.id, label: option.number ? `${option.number} · ${option.name}` : option.name }))} value={line.vendorId} />
                            </TableCell>
                            <TableCell className="p-1">
                              <Input aria-label={`Notes on ${name}`} className="h-8" maxLength={1000} onChange={(event) => setLine(line.key, { notes: event.target.value })} value={line.notes} />
                            </TableCell>
                            <TableCell className={cn('p-1', fill('department'))}>
                              <Pick compact label={`Department of ${name}`} none="None" onChange={(departmentId) => setLine(line.key, { departmentId }, 'department')} options={(choices.departments ?? []).map((code) => ({ value: code.id, label: code.code }))} value={line.departmentId} />
                            </TableCell>
                            <TableCell className="p-1">
                              <Button aria-label={`Delete line ${index + 1}`} className="size-8" onClick={() => setLines((rows) => rows.filter((row) => row.key !== line.key))} size="icon" type="button" variant="ghost">
                                <Trash2Icon />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No lines yet. Add a new line and type or pick an item code.</p>
              )}
              <div className="grid gap-x-6 border-t pt-2 @2xl:grid-cols-2">
                <div>
                  <FieldRow label="Lines">
                    <FieldValue>{formatCount(input.lines.length)}</FieldValue>
                  </FieldRow>
                  <FieldRow label="Total Quantity">
                    <FieldValue>{formatCount(input.lines.reduce((sum, line) => sum + line.quantity, 0))}</FieldValue>
                  </FieldRow>
                </div>
                <div>
                  <FieldRow label="Estimated Total (USD)">
                    <FieldValue>
                      <span className="font-semibold tabular-nums">{formatMoney(totalCents)}</span>
                    </FieldValue>
                  </FieldRow>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                <span className="bg-warning/15 rounded-sm px-1.5">Yellow</span> = filled in from the item code when it was picked. Each can still be changed. Only the requisition&rsquo;s company&rsquo;s item codes of the
                line&rsquo;s type are offered; something with no code yet is added on Inventory first, by whoever keeps the stock.
              </p>
            </div>
          </FastTab>

          <FastTab defaultOpen={quotes.length > 0 || overLimit} title="Quotes">
            <div className="grid gap-3">
              <p className="text-muted-foreground text-xs">
                Optional up to {formatMoney(choices.settings.approvalLimitCents)}. Above it, {choices.settings.quotesAboveLimit} are needed, with one chosen.
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
          </FastTab>
        </div>

        <aside className="grid gap-3">
          <FactBox
            facts={[
              { label: 'Lines', value: formatCount(input.lines.length) },
              { label: 'Total (USD)', value: formatMoney(totalCents) },
              { label: 'Approval Limit', value: formatMoney(choices.settings.approvalLimitCents) },
              { label: 'Who Approves', value: approverFor(totalCents, choices.settings) },
              { label: 'Quotes Needed', value: overLimit ? String(choices.settings.quotesAboveLimit) : 'None' },
              { label: 'Vendors', value: formatCount(vendorsNamed) },
            ]}
            title="Requisition Statistics"
          >
            <p className="text-muted-foreground text-xs">You asked for it, so you cannot approve it yourself.</p>
            {problem ? (
              <p className="text-warning mt-2 text-xs font-medium" role="status">
                {problem}
              </p>
            ) : null}
            {error ? (
              <Alert className="mt-2" variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            ) : null}
          </FactBox>
          <AttachmentsFactBox requisition={requisition} />
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
          <FactBox
            facts={[
              { label: 'On Hand, All', value: shownItem ? formatCount(shownItem.onHand) : EMPTY },
              { label: `On Hand, ${shownPlace?.code ?? shownPlace?.name ?? 'here'}`, value: shownItem && shownPlace ? formatCount(shownItem.held.find((level) => level.placeId === shownPlace.id)?.quantity ?? 0) : EMPTY },
              { label: 'On Open Orders', value: shownItem ? formatCount(shownItem.onOrder) : EMPTY },
              { label: 'Reorder Level', value: shownItem ? formatCount(shownItem.reorderLevel) : EMPTY },
            ]}
            title="Item Availability"
          />
          <p className="text-muted-foreground px-1 text-xs">Line Details and Item Availability follow the line the cursor is on, and the item the dropdown is on.</p>
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

/** A NAV-style dropdown: a list to choose from, with "none" first where none may be chosen. */
function Pick({ id, label, value, onChange, options, none, compact }: { id?: string; label: string; value: string; onChange: (value: string) => void; options: readonly { value: string; label: string }[]; none?: string; compact?: boolean }) {
  return (
    <Select onValueChange={onChange} value={value}>
      <SelectTrigger aria-label={label} className={cn('w-full', compact ? 'h-8' : 'h-8')} id={id}>
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
