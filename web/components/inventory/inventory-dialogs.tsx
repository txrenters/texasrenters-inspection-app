'use client';

import {
  MOST_STOCK_QUANTITY,
  STOCK_PREFIX,
  formatMoney,
  parseMoney,
  type OpeningBalanceInput,
  type SaveStockCategoryInput,
  type SaveStockItemInput,
  type SaveStockPlaceInput,
  type SaveVendorInput,
  type StockCategoryRow,
  type StockCompany,
  type StockItemRow,
  type StockMovementRow,
  type StockPlaceKind,
  type StockPlaceRow,
  type VendorRow,
  normalizePurchasingCode,
  purchasingCodeProblem,
  suggestedPlaceCode,
} from '@texasrenters/shared';
import { useState, type FormEvent, type ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { businessToday } from '@/lib/clock';
import { formatDay } from '@/lib/format';

/**
 * The Inventory page's forms (2026-11-19, phase 1). Each is mounted only while
 * it is open, so it always starts from what is saved. None of them has a field
 * for on hand: stock changes by a movement, never by typing a number over it.
 */

/** Radix's Select has no empty value: this stands for "none chosen". */
const NONE = 'none';
const chosen = (value: string) => (value === NONE ? null : value);
/** A whole number of units, or null while the field does not hold one. */
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);

function FormDialog({
  title,
  description,
  submitLabel,
  pending,
  error,
  disabled,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  disabled?: boolean;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  children: ReactNode;
}) {
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || pending) return;
    try {
      await onSubmit();
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          {children}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={disabled || pending} type="submit">
              {pending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  id,
  label,
  value,
  onChange,
  options,
  none,
  description,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  /** The word for "none chosen", when none may be. */
  none?: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select disabled={disabled} onValueChange={onChange} value={value}>
        <SelectTrigger className="w-full" id={id}>
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
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

function ActiveSwitch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <Field className="flex items-center justify-between gap-3">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Switch checked={checked} id={id} onCheckedChange={onChange} />
    </Field>
  );
}

type Unit = { code: string; name: string };

/** A new item's unit: the usual word, or nothing chosen yet when the units of measure do not have it. */
export function firstUnit(units: readonly Unit[] | undefined, usual: string): string {
  if (!units?.length) return usual;
  return units.find((unit) => unit.name.toLowerCase() === usual.toLowerCase())?.name ?? '';
}

/**
 * What an item is counted in (Purchasing Setup, 2026-11-21): chosen from the
 * units of measure once Purchasing's Codes tab has any, which the server holds
 * too; any word before that. An item keeps a unit it had, even one not listed.
 */
export function UnitField({
  id,
  label,
  value,
  onChange,
  units,
  saved,
  description,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  units?: readonly Unit[];
  /** The item's unit as saved, kept choosable. */
  saved?: string;
  description: string;
  placeholder?: string;
}) {
  if (!units?.length) {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input autoComplete="off" id={id} maxLength={30} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required value={value} />
        <FieldDescription>{description}</FieldDescription>
      </Field>
    );
  }
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const names = units.map((unit) => unit.name);
  const options = saved && !names.some((name) => same(name, saved)) ? [saved, ...names] : names;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select onValueChange={onChange} value={options.find((name) => same(name, value)) ?? ''}>
        <SelectTrigger className="w-full" id={id}>
          <SelectValue placeholder="Choose a unit" />
        </SelectTrigger>
        <SelectContent>
          {options.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>From the units of measure on Purchasing&apos;s Codes tab.</FieldDescription>
    </Field>
  );
}

// ── Item ──────────────────────────────────────────────────────────────────

export function ItemDialog({
  item,
  categories,
  companies,
  vendors,
  units,
  companyFixed = false,
  onSave,
  onClose,
  pending,
  error,
}: {
  /** The item being changed; none for a new one. */
  item?: StockItemRow;
  categories: readonly StockCategoryRow[];
  companies: readonly StockCompany[];
  vendors: readonly { id: string; name: string }[];
  /** The units of measure, once there are any. */
  units?: readonly Unit[];
  /** It has moved already, so its company stays (the server holds this too). */
  companyFixed?: boolean;
  onSave: (input: SaveStockItemInput) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [unit, setUnit] = useState(item?.unit ?? firstUnit(units, 'each'));
  const [category, setCategory] = useState(item?.category?.id ?? NONE);
  const [company, setCompany] = useState(item?.company?.tenantId ?? NONE);
  const [vendor, setVendor] = useState(item?.usualVendor?.id ?? NONE);
  const [level, setLevel] = useState(String(item?.reorderLevel ?? 0));
  const [quantity, setQuantity] = useState(String(item?.reorderQuantity ?? 0));
  const [active, setActive] = useState(item?.active ?? true);

  const reorderLevel = whole(level);
  const reorderQuantity = whole(quantity);
  // A new item's code comes from its category, so it must have one.
  const invalid = !name.trim() || !unit.trim() || reorderLevel === null || reorderQuantity === null || (!item && category === NONE);
  // The categories in use, and this item's own even if it has been switched off since.
  const categoryOptions = categories.filter((option) => option.active || option.id === item?.category?.id);
  const picked = categories.find((option) => option.id === category);

  // A change sends only what changed; a new item sends everything it has.
  const input: SaveStockItemInput = {};
  if (!invalid) {
    if (name.trim() !== (item?.name ?? '')) input.name = name.trim();
    if (unit.trim() !== (item?.unit ?? '')) input.unit = unit.trim();
    if (category !== NONE && category !== (item?.category?.id ?? NONE)) input.categoryId = category;
    if (chosen(company) !== (item?.company?.tenantId ?? null)) input.xeroTenantId = chosen(company);
    if (chosen(vendor) !== (item?.usualVendor?.id ?? null)) input.usualVendorId = chosen(vendor);
    if (reorderLevel !== (item?.reorderLevel ?? null)) input.reorderLevel = reorderLevel;
    if (reorderQuantity !== (item?.reorderQuantity ?? null)) input.reorderQuantity = reorderQuantity;
    if (item && active !== item.active) input.active = active;
  }
  const changed = Object.keys(input).length > 0;
  // A company that was disconnected since still shows as the item's own.
  const companyOptions = [...companies];
  if (item?.company && !companyOptions.some((option) => option.tenantId === item.company?.tenantId)) companyOptions.push(item.company);

  return (
    <FormDialog
      description={
        item
          ? `${item.code}. What is on hand is not changed here: it changes only by a stock movement.`
          : 'Add something the office stocks. The console gives it its code. Enter what is on hand afterwards, as its opening balance.'
      }
      disabled={invalid || !changed}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave(input)}
      pending={pending}
      submitLabel={item ? 'Save item' : 'Add item'}
      title={item ? 'Edit item' : 'New item'}
    >
      {categoryOptions.length || item ? (
        <Choice
          description={
            item?.category
              ? `${item.code} got its code from its category, so the category stays.`
              : item
                ? 'This item was added before categories gave the codes. It keeps its code.'
                : picked
                  ? `Its code will be ${picked.nextCode}.`
                  : 'The category gives the item its code.'
          }
          disabled={Boolean(item?.category)}
          id="item-category"
          label="Category"
          none={item ? 'No category' : 'Choose a category'}
          onChange={setCategory}
          options={categoryOptions.map((option) => ({ value: option.id, label: `${option.name} (${option.prefix})` }))}
          value={category}
        />
      ) : (
        <Alert variant="warning">
          <AlertDescription>Add a category on the Categories tab first: its prefix starts the item&apos;s code.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field>
          <FieldLabel htmlFor="item-name">Name</FieldLabel>
          <Input autoComplete="off" id="item-name" maxLength={160} onChange={(event) => setName(event.target.value)} required value={name} />
        </Field>
        <UnitField description="each, box, jug." id="item-unit" label="Counted in" onChange={setUnit} saved={item?.unit} units={units} value={unit} />
      </div>
      <Choice
        description={companyFixed ? 'This item already has stock movements, so its company stays.' : 'The company whose books this stock belongs to.'}
        disabled={companyFixed}
        id="item-company"
        label="Company"
        none="No company yet"
        onChange={setCompany}
        options={companyOptions.map((option) => ({ value: option.tenantId, label: option.name }))}
        value={company}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="item-reorder-level">Reorder at</FieldLabel>
          <Input id="item-reorder-level" inputMode="numeric" max={MOST_STOCK_QUANTITY} onChange={(event) => setLevel(event.target.value)} value={level} />
          <FieldDescription>Shows as Low at or below this. 0 for never.</FieldDescription>
          <FieldError>{reorderLevel === null ? 'A whole number, 0 or more.' : null}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="item-reorder-quantity">Usual order quantity</FieldLabel>
          <Input id="item-reorder-quantity" inputMode="numeric" max={MOST_STOCK_QUANTITY} onChange={(event) => setQuantity(event.target.value)} value={quantity} />
          <FieldError>{reorderQuantity === null ? 'A whole number, 0 or more.' : null}</FieldError>
        </Field>
      </div>
      <Choice id="item-vendor" label="Usual vendor" none="No usual vendor" onChange={setVendor} options={vendors.map((option) => ({ value: option.id, label: option.name }))} value={vendor} />
      {item ? <ActiveSwitch checked={active} id="item-active" label="In use" onChange={setActive} /> : null}
    </FormDialog>
  );
}

// ── Category ──────────────────────────────────────────────────────────────

export function CategoryDialog({
  category,
  onSave,
  onClose,
  pending,
  error,
}: {
  category?: StockCategoryRow;
  onSave: (input: SaveStockCategoryInput) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [prefix, setPrefix] = useState(category?.prefix ?? '');
  const [active, setActive] = useState(category?.active ?? true);
  // Once it has given out a code its prefix stays (the server holds this too).
  const prefixFixed = Boolean(category) && category?.nextCode !== `${category?.prefix}-0001`;
  const typed = prefix.trim().toUpperCase();
  const prefixValid = STOCK_PREFIX.test(typed);

  const input: SaveStockCategoryInput = {};
  if (name.trim() !== (category?.name ?? '')) input.name = name.trim();
  if (typed !== (category?.prefix ?? '')) input.prefix = typed;
  if (category && active !== category.active) input.active = active;

  return (
    <FormDialog
      description="A kind of stock. Its prefix starts the code of every item added to it, and the console numbers them."
      disabled={!name.trim() || !prefixValid || !Object.keys(input).length}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave(input)}
      pending={pending}
      submitLabel={category ? 'Save category' : 'Add category'}
      title={category ? 'Edit category' : 'New category'}
    >
      <Field>
        <FieldLabel htmlFor="category-name">Name</FieldLabel>
        <Input autoComplete="off" id="category-name" maxLength={60} onChange={(event) => setName(event.target.value)} required value={name} />
      </Field>
      <Field>
        <FieldLabel htmlFor="category-prefix">Prefix</FieldLabel>
        <Input autoComplete="off" className="uppercase" disabled={prefixFixed} id="category-prefix" maxLength={6} onChange={(event) => setPrefix(event.target.value)} required value={prefix} />
        <FieldDescription>
          {prefixFixed
            ? `It has already given out codes starting ${category?.prefix}, so the prefix stays. The next is ${category?.nextCode}.`
            : prefixValid
              ? `Its first item will be ${typed}-0001.`
              : 'A letter and then one to five letters or digits, like FLT.'}
        </FieldDescription>
        <FieldError>{prefix.trim() && !prefixValid ? 'A letter and then one to five letters or digits.' : null}</FieldError>
      </Field>
      {category ? <ActiveSwitch checked={active} id="category-active" label="In use" onChange={setActive} /> : null}
    </FormDialog>
  );
}

// ── Opening balance ───────────────────────────────────────────────────────

export function OpeningBalanceDialog({
  item,
  places,
  onSave,
  onClose,
  pending,
  error,
}: {
  item: StockItemRow;
  places: readonly StockPlaceRow[];
  onSave: (input: OpeningBalanceInput) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const open = places.filter((place) => place.active);
  const [placeId, setPlaceId] = useState(open[0]?.id ?? NONE);
  const [quantity, setQuantity] = useState('');
  const [cost, setCost] = useState('');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  // One key for this opening of the form: a second click or a retry is the same entry.
  const [requestKey] = useState(() => crypto.randomUUID());

  const units = whole(quantity);
  const unitCostCents = cost.trim() ? parseMoney(cost) : null;
  // Today in Texas, where the stock is: somebody on a clock ahead of it (Manila) is not offered tomorrow.
  const today = businessToday();
  const ahead = Boolean(day) && day > today;
  const invalid = placeId === NONE || !units || unitCostCents === null || unitCostCents < 0 || ahead;

  return (
    <FormDialog
      description={`What is on the shelf of ${item.code} today, entered once for each place. It becomes the first line of the item's ledger.`}
      disabled={invalid}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave({ placeId, quantity: units ?? 0, unitCostCents: unitCostCents ?? 0, ...(day ? { day } : {}), ...(note.trim() ? { note: note.trim() } : {}), requestKey })}
      pending={pending}
      submitLabel="Enter opening balance"
      title="Opening balance"
    >
      {open.length ? (
        <Choice id="opening-place" label="Place" onChange={setPlaceId} options={open.map((place) => ({ value: place.id, label: place.name }))} value={placeId} />
      ) : (
        <Alert variant="warning">
          <AlertDescription>Add a place on the Places tab first: stock is always kept somewhere.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="opening-quantity">Quantity, in {item.unit}</FieldLabel>
          <Input id="opening-quantity" inputMode="numeric" onChange={(event) => setQuantity(event.target.value)} required value={quantity} />
          <FieldError>{quantity.trim() && !units ? 'A whole number, 1 or more.' : null}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="opening-cost">Cost of one</FieldLabel>
          <Input id="opening-cost" inputMode="decimal" onChange={(event) => setCost(event.target.value)} placeholder="0.00" required value={cost} />
          <FieldDescription>{units && unitCostCents !== null ? `${formatMoney(units * unitCostCents)} in all.` : 'What the office paid for one.'}</FieldDescription>
          <FieldError>{cost.trim() && unitCostCents === null ? 'An amount of money, like 3.42.' : null}</FieldError>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="opening-day">As of</FieldLabel>
        <Input id="opening-day" max={today} onChange={(event) => setDay(event.target.value)} type="date" value={day} />
        <FieldDescription>Leave empty for today in Texas, {formatDay(today)}.</FieldDescription>
        <FieldError>{ahead ? `That day has not come yet in Texas. It is ${formatDay(today)} there.` : null}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor="opening-note">Note</FieldLabel>
        <Input autoComplete="off" id="opening-note" maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} />
      </Field>
    </FormDialog>
  );
}

// ── Reversal ──────────────────────────────────────────────────────────────

export function ReverseMovementDialog({
  item,
  movement,
  onSave,
  onClose,
  pending,
  error,
}: {
  item: StockItemRow;
  movement: StockMovementRow;
  onSave: (reason: string) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      description={
        movement.quantity < 0
          ? `This puts ${-movement.quantity} of ${item.code} back into ${movement.placeName} with a second line in the ledger. The first line stays as it was written, and this cannot be undone.`
          : `This takes ${movement.quantity} of ${item.code} back out of ${movement.placeName} with a second line in the ledger. The first line stays as it was written, and this cannot be undone.`
      }
      disabled={!reason.trim()}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave(reason.trim())}
      pending={pending}
      submitLabel="Reverse movement"
      title="Reverse this movement?"
    >
      <Field>
        <FieldLabel htmlFor="reverse-reason">Why</FieldLabel>
        <Textarea id="reverse-reason" maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={3} value={reason} />
        <FieldDescription>Kept on the reversal, with your name.</FieldDescription>
      </Field>
    </FormDialog>
  );
}

// ── Place ─────────────────────────────────────────────────────────────────

const PLACE_KINDS: { value: StockPlaceKind; label: string }[] = [
  { value: 'STOCKROOM', label: 'Storeroom' },
  { value: 'VAN', label: 'Truck' },
];

export function PlaceDialog({
  place,
  technicians,
  onSave,
  onClose,
  pending,
  error,
}: {
  place?: StockPlaceRow;
  technicians: readonly { id: string; name: string }[];
  onSave: (input: SaveStockPlaceInput) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState(place?.name ?? '');
  const [code, setCode] = useState(place?.code ?? '');
  const [kind, setKind] = useState<StockPlaceKind>(place?.kind ?? 'STOCKROOM');
  const [technician, setTechnician] = useState(place?.technicianId ?? NONE);
  const [active, setActive] = useState(place?.active ?? true);

  const technicianId = kind === 'VAN' ? chosen(technician) : null;
  const input: SaveStockPlaceInput = {};
  if (name.trim() !== (place?.name ?? '')) input.name = name.trim();
  const codeProblem = code.trim() ? purchasingCodeProblem(code) : place ? 'Give it a location code.' : null;
  if (code.trim() && normalizePurchasingCode(code) !== (place?.code ?? '')) input.code = normalizePurchasingCode(code);
  // A place keeps its kind: it is chosen when the place is made, and only then.
  if (!place) input.kind = kind;
  if (technicianId !== (place?.technicianId ?? null)) input.technicianId = technicianId;
  if (place && active !== place.active) input.active = active;
  // The truck's technician, even if they have left the office since.
  const options = technicians.map((person) => ({ value: person.id, label: person.name }));
  if (place?.technicianId && place.technicianName && !options.some((option) => option.value === place.technicianId))
    options.push({ value: place.technicianId, label: place.technicianName });

  return (
    <FormDialog
      description="Where stock is kept. A truck is its own place, so what is in it can be counted. A place keeps its kind."
      disabled={!name.trim() || Boolean(codeProblem) || !Object.keys(input).length}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave(input)}
      pending={pending}
      submitLabel={place ? 'Save place' : 'Add place'}
      title={place ? 'Edit place' : 'New place'}
    >
      <Field>
        <FieldLabel htmlFor="place-name">Name</FieldLabel>
        <Input autoComplete="off" id="place-name" maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} />
      </Field>
      <Field>
        <FieldLabel htmlFor="place-code">Location code</FieldLabel>
        <Input autoCapitalize="characters" autoComplete="off" className="font-mono" id="place-code" maxLength={20} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder={name.trim() ? suggestedPlaceCode(name) : 'STORE'} value={code} />
        <FieldDescription>{codeProblem ?? 'A requisition and an order name the place by it.'}</FieldDescription>
      </Field>
      {place ? null : <Choice id="place-kind" label="Kind" onChange={(value) => setKind(value as StockPlaceKind)} options={PLACE_KINDS} value={kind} />}
      {kind === 'VAN' ? <Choice id="place-technician" label="Technician" none="Nobody: any technician may use it" onChange={setTechnician} options={options} value={technician} /> : null}
      {place ? <ActiveSwitch checked={active} id="place-active" label="In use" onChange={setActive} /> : null}
    </FormDialog>
  );
}

// ── Vendor ────────────────────────────────────────────────────────────────

export function VendorDialog({
  vendor,
  onSave,
  onClose,
  pending,
  error,
}: {
  vendor?: VendorRow;
  onSave: (input: SaveVendorInput) => Promise<unknown>;
  onClose: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState(vendor?.name ?? '');
  const [contactName, setContactName] = useState(vendor?.contactName ?? '');
  const [email, setEmail] = useState(vendor?.email ?? '');
  const [phone, setPhone] = useState(vendor?.phone ?? '');
  const [terms, setTerms] = useState(vendor?.terms ?? '');
  const [notes, setNotes] = useState(vendor?.notes ?? '');
  const [active, setActive] = useState(vendor?.active ?? true);

  const input: SaveVendorInput = {};
  if (name.trim() !== (vendor?.name ?? '')) input.name = name.trim();
  const optional = { contactName, email, phone, terms, notes } as const;
  for (const field of Object.keys(optional) as (keyof typeof optional)[])
    if ((optional[field].trim() || null) !== (vendor?.[field] ?? null)) input[field] = optional[field].trim() || null;
  if (vendor && active !== vendor.active) input.active = active;

  return (
    <FormDialog
      description="Who the office buys stock from."
      disabled={!name.trim() || !Object.keys(input).length}
      error={error}
      onClose={onClose}
      onSubmit={() => onSave(input)}
      pending={pending}
      submitLabel={vendor ? 'Save vendor' : 'Add vendor'}
      title={vendor ? 'Edit vendor' : 'New vendor'}
    >
      {vendor ? (
        <p className="text-muted-foreground text-sm">
          Vendor no. <span className="text-foreground font-mono font-semibold">{vendor.number}</span>, given by the console.
        </p>
      ) : null}
      <Field>
        <FieldLabel htmlFor="vendor-name">Name</FieldLabel>
        <Input autoComplete="off" id="vendor-name" maxLength={160} onChange={(event) => setName(event.target.value)} required value={name} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="vendor-contact">Contact</FieldLabel>
          <Input autoComplete="off" id="vendor-contact" maxLength={120} onChange={(event) => setContactName(event.target.value)} value={contactName} />
        </Field>
        <Field>
          <FieldLabel htmlFor="vendor-phone">Phone</FieldLabel>
          <Input autoComplete="off" id="vendor-phone" maxLength={40} onChange={(event) => setPhone(event.target.value)} value={phone} />
        </Field>
        <Field>
          <FieldLabel htmlFor="vendor-email">Email</FieldLabel>
          <Input autoComplete="off" id="vendor-email" maxLength={320} onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
        </Field>
        <Field>
          <FieldLabel htmlFor="vendor-terms">Payment terms</FieldLabel>
          <Input autoComplete="off" id="vendor-terms" maxLength={60} onChange={(event) => setTerms(event.target.value)} placeholder="Net 30" value={terms} />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="vendor-notes">Notes</FieldLabel>
        <Textarea id="vendor-notes" maxLength={2000} onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} />
      </Field>
      {vendor ? <ActiveSwitch checked={active} id="vendor-active" label="In use" onChange={setActive} /> : null}
    </FormDialog>
  );
}
