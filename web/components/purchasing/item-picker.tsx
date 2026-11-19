'use client';

import { formatMoney, normalizeStockCode, stockStatus, type RequisitionChoices } from '@texasrenters/shared';
import { ChevronDownIcon, SearchIcon } from 'lucide-react';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Choosing an item code for a requisition line (2026-11-20), as NAV does it:
 * type part of a code or of a description and the matching codes drop down,
 * with what is on hand and what one costs; Enter takes the one marked. A code
 * typed whole, or scanned, is taken as it is. "Advanced..." opens the whole
 * Item Codes list to search and filter. Everything is matched in the rows the
 * page already holds: nothing is asked of the server while typing.
 */

export type PickerItem = RequisitionChoices['items'][number];

/** The items whose code or description has what was typed, codes first. Every item when nothing was. */
export function matchingItems(items: readonly PickerItem[], typed: string): PickerItem[] {
  const words = typed.trim().toLowerCase();
  if (!words) return [...items];
  const byCode = items.filter((item) => item.code.toLowerCase().includes(words));
  const byName = items.filter((item) => !byCode.includes(item) && item.name.toLowerCase().includes(words));
  return [...byCode, ...byName];
}

/** "*filter*" anywhere, "filter*" at the start, "*filter" at the end, "filter" anywhere: NAV's filter wildcards. */
export function wildcard(pattern: string): (value: string) => boolean {
  const text = pattern.trim().toLowerCase();
  if (!text) return () => true;
  const core = text.replace(/^\*+|\*+$/g, '');
  if (text.startsWith('*') === text.endsWith('*') || !text.includes('*')) return (value) => value.toLowerCase().includes(core);
  return text.endsWith('*') ? (value) => value.toLowerCase().startsWith(core) : (value) => value.toLowerCase().endsWith(core);
}

/** The part of a text that matched, marked. */
function Marked({ text, words }: { text: string; words: string }) {
  const at = words ? text.toLowerCase().indexOf(words.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-warning/30 text-foreground rounded-[2px]">{text.slice(at, at + words.length)}</mark>
      {text.slice(at + words.length)}
    </>
  );
}

const MOST_SHOWN = 50;

/** What one costs: the usual price, else what one cost on average; nothing when neither is known. */
const costText = (item: PickerItem) => {
  const cents = item.priceCents ?? item.averageCostCents;
  return cents === null ? '' : formatMoney(cents);
};

export function ItemCodePicker({
  id,
  label,
  items,
  value,
  onPick,
  onAdvanced,
  canMakeItemCodes,
  companyCode,
  onHighlight,
}: {
  id: string;
  label: string;
  /** The items this line may take: its company's, of its type, and none already on another line. */
  items: readonly PickerItem[];
  /** The item on the line now. */
  value: PickerItem | null;
  onPick: (item: PickerItem) => void;
  onAdvanced: () => void;
  canMakeItemCodes: boolean;
  /** The company's purchaser code, for the dropdown's heading. */
  companyCode: string;
  /** The item the dropdown is on, for the FactBoxes. */
  onHighlight?: (item: PickerItem | null) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [marked, setMarked] = useState(0);
  const listId = useId();
  const words = typed ?? '';
  const shown = useMemo(() => matchingItems(items, words).slice(0, MOST_SHOWN), [items, words]);
  const total = matchingItems(items, words).length;
  const current = shown[Math.min(marked, shown.length - 1)] ?? null;

  const show = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setTyped(null);
      onHighlight?.(null);
    }
  };
  const mark = (index: number) => {
    setMarked(index);
    onHighlight?.(shown[index] ?? null);
  };
  const take = (item: PickerItem) => {
    onPick(item);
    show(false);
  };

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return show(true);
      mark(Math.max(0, Math.min(shown.length - 1, marked + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // A code typed whole, or scanned, is taken as it is; otherwise the one marked in the list.
      const exact = items.find((item) => item.code === normalizeStockCode(words));
      const chosen = exact ?? (open ? current : null);
      if (chosen) take(chosen);
    } else if (event.key === 'Escape') {
      show(false);
    }
  }

  return (
    <Popover onOpenChange={show} open={open}>
      <PopoverAnchor asChild>
        <div className={cn('border-input bg-background flex h-8 items-center rounded-sm border', open ? 'ring-ring/50 ring-2' : '')}>
          <input
            aria-activedescendant={open && current ? `${listId}-${current.id}` : undefined}
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-expanded={open}
            aria-label={label}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-sm outline-none"
            id={id}
            onChange={(event) => {
              setTyped(event.target.value);
              setMarked(0);
              if (!open) setOpen(true);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={onKeyDown}
            placeholder="Code or description"
            role="combobox"
            spellCheck={false}
            value={typed ?? value?.code ?? ''}
          />
          <button aria-label={`Show the item codes for ${label.toLowerCase()}`} className="text-muted-foreground hover:text-foreground flex h-full items-center border-l px-1.5" onClick={() => show(!open)} tabIndex={-1} type="button">
            <ChevronDownIcon className="size-3.5" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-[min(52rem,calc(100vw-2rem))] p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
        <div className="text-muted-foreground flex flex-wrap justify-between gap-2 border-b px-3 py-1.5 text-xs">
          <span>
            {companyCode} item codes{words.trim() ? ` whose code or description has “${words.trim()}”` : ''}: {formatCount(total)}
          </span>
          <span>↑ ↓ to move · Enter to pick · Esc to close</span>
        </div>
        {shown.length ? (
          <div aria-label={`Item codes for ${label.toLowerCase()}`} className="max-h-80 overflow-y-auto" id={listId} role="listbox">
            {shown.map((item, index) => (
              <div
                aria-selected={index === marked}
                className={cn('grid cursor-pointer grid-cols-[8rem_minmax(0,1fr)_5rem_5rem_6rem] gap-2 px-3 py-1.5 text-sm', index === marked ? 'bg-accent' : 'hover:bg-muted')}
                id={`${listId}-${item.id}`}
                key={item.id}
                onClick={() => take(item)}
                onMouseEnter={() => mark(index)}
                role="option"
              >
                <span className="font-mono font-semibold">
                  <Marked text={item.code} words={words.trim()} />
                </span>
                <span className="truncate">
                  <Marked text={item.name} words={words.trim()} />
                </span>
                <span className="text-muted-foreground">{item.unit}</span>
                <span className={cn('text-right tabular-nums', stockStatus(item.onHand, item.reorderLevel) === 'ENOUGH' ? '' : 'text-warning font-medium')}>{formatCount(item.onHand)}</span>
                <span className="text-right tabular-nums">{costText(item)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground px-3 py-3 text-sm">No item code matches. Look in the whole list, or ask whoever keeps the stock to add it.</p>
        )}
        <div className="bg-muted/40 flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5">
          <Button
            className="h-7 px-1"
            onClick={() => {
              show(false);
              onAdvanced();
            }}
            type="button"
            variant="link"
          >
            <SearchIcon aria-hidden="true" />
            Advanced…
          </Button>
          <span className="text-muted-foreground text-xs">The whole Item Codes list, to search and filter.</span>
          {canMakeItemCodes ? (
            <a className="text-primary ml-auto text-xs font-medium underline-offset-4 hover:underline" href="/inventory?tab=codes" rel="noreferrer" target="_blank">
              + New Item Code
            </a>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Advanced: the whole list, to search and filter ───────────────────────

const ANY = 'any';

export function ItemLookupDialog({
  items,
  lineTypes,
  categories,
  vendors,
  companyName,
  onPick,
  onClose,
}: {
  /** Already narrowed to the requisition's company and free to go on a line. */
  items: readonly PickerItem[];
  lineTypes: readonly { id: string; code: string; name: string }[];
  categories: readonly { id: string; name: string }[];
  vendors: readonly { id: string; name: string; number?: string }[];
  companyName: string;
  onPick: (item: PickerItem) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [no, setNo] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState(ANY);
  const [category, setCategory] = useState(ANY);
  const [vendor, setVendor] = useState(ANY);
  const [lowOnly, setLowOnly] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const byNo = wildcard(no);
  const byDescription = wildcard(description);
  const rows = matchingItems(items, search).filter(
    (item) =>
      byNo(item.code) &&
      byDescription(item.name) &&
      (type === ANY || item.lineTypeId === type) &&
      (category === ANY || item.categoryId === category) &&
      (vendor === ANY || item.usualVendorId === vendor) &&
      (!lowOnly || stockStatus(item.onHand, item.reorderLevel) !== 'ENOUGH'),
  );
  const pick = rows.find((item) => item.id === chosen) ?? null;
  const chips = [
    no.trim() && `No.: ${no.trim()}`,
    description.trim() && `Description: ${description.trim()}`,
    type !== ANY && `Type: ${lineTypes.find((one) => one.id === type)?.name}`,
    category !== ANY && `Category: ${categories.find((one) => one.id === category)?.name}`,
    vendor !== ANY && `Usual vendor: ${vendors.find((one) => one.id === vendor)?.name}`,
    lowOnly && 'Low or out',
  ].filter(Boolean) as string[];
  const clear = () => {
    setNo('');
    setDescription('');
    setType(ANY);
    setCategory(ANY);
    setVendor(ANY);
    setLowOnly(false);
  };
  const vendorName = (vendorId: string | null) => {
    const found = vendors.find((one) => one.id === vendorId);
    return found ? (found.number ?? found.name) : '';
  };

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Select – Item Codes</DialogTitle>
          <DialogDescription>Search by number or description, and filter the list. The company is the requisition&rsquo;s: {companyName}.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Search the item codes" autoFocus onChange={(event) => setSearch(event.target.value)} placeholder="Search by number or description" value={search} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {chips.map((chip) => (
            <span className="rounded-full border px-2.5 py-0.5" key={chip}>
              {chip}
            </span>
          ))}
          <span className="text-muted-foreground">
            {formatCount(rows.length)} item {rows.length === 1 ? 'code' : 'codes'}
          </span>
          {chips.length ? (
            <Button className="h-6 px-1 text-xs" onClick={clear} type="button" variant="link">
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          <fieldset className="grid content-start gap-2.5 md:border-r md:pr-4">
            <legend className="text-heading mb-1 text-sm font-semibold">Filter list by:</legend>
            <Label className="grid gap-1 text-xs">
              No.
              <Input className="h-8 font-mono" onChange={(event) => setNo(event.target.value)} placeholder="FLT*" value={no} />
            </Label>
            <Label className="grid gap-1 text-xs">
              Description
              <Input className="h-8" onChange={(event) => setDescription(event.target.value)} placeholder="*filter*" value={description} />
            </Label>
            <Filter label="Type" onChange={setType} options={lineTypes.map((one) => ({ value: one.id, label: one.name }))} value={type} />
            <Filter label="Category" onChange={setCategory} options={categories.map((one) => ({ value: one.id, label: one.name }))} value={category} />
            <Filter label="Usual vendor" onChange={setVendor} options={vendors.map((one) => ({ value: one.id, label: one.number ? `${one.number} · ${one.name}` : one.name }))} value={vendor} />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox checked={lowOnly} onCheckedChange={(checked) => setLowOnly(checked === true)} />
              Only those low or out
            </label>
            <p className="text-muted-foreground text-xs">* stands for anything: *filter* finds every description with filter in it.</p>
          </fieldset>
          <div className="max-h-[55vh] min-w-0 overflow-auto rounded-sm border">
            <Table aria-label="Item codes to choose from">
              {/* Pinned to the top of this list's own scroll box, not under the app header (see components/ui/table.tsx). */}
              <TableHeader className="sticky top-0 z-10 lg:top-0">
                <TableRow>
                  <TableHead>No.</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead>Usual vendor</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Reorder at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow
                    aria-selected={item.id === chosen}
                    className={cn('cursor-pointer', item.id === chosen ? 'bg-accent' : '')}
                    key={item.id}
                    onClick={() => setChosen(item.id)}
                    onDoubleClick={() => onPick(item)}
                  >
                    <TableCell className="font-mono font-semibold whitespace-nowrap">{item.code}</TableCell>
                    <TableCell>{item.name}</TableCell>
                    <TableCell>{lineTypes.find((one) => one.id === item.lineTypeId)?.name ?? ''}</TableCell>
                    <TableCell>{item.unit}</TableCell>
                    <TableCell className="text-right tabular-nums">{costText(item)}</TableCell>
                    <TableCell>{vendorName(item.usualVendorId)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(item.onHand)}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.reorderLevel ? formatCount(item.reorderLevel) : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length ? null : <p className="text-muted-foreground p-4 text-sm">No item code matches these filters.</p>}
          </div>
        </div>
        <DialogFooter className="items-center">
          <span className="text-muted-foreground mr-auto text-xs">Double-click a row, or choose it and press OK, to put it on the line.</span>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={!pick} onClick={() => pick && onPick(pick)} type="button">
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: readonly { value: string; label: string }[] }) {
  return (
    <Label className="grid gap-1 text-xs">
      {label}
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger aria-label={`Filter by ${label.toLowerCase()}`} className="h-8 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Label>
  );
}
