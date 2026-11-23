'use client';

import {
  VENDOR_BILL_STATUS_LABEL,
  VENDOR_PAYMENT_METHODS,
  VENDOR_PAYMENT_METHOD_LABEL,
  formatMoney,
  parseMoney,
  type GoodsReceiptRow,
  type PurchaseOrderDetail,
  type VendorBillStatus,
  type VendorPaymentMethod,
} from '@texasrenters/shared';
import { useState, type FormEvent, type ReactNode } from 'react';

import { ScanField } from '@/components/inventory/scan-field';

import { AsideCard, FactTable } from '@/components/record/record-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { businessToday } from '@/lib/clock';
import { formatCount, formatDateTime, formatDay } from '@/lib/format';
import { usePurchaseReceivingEdits, useRequisitionChoices } from '@/lib/purchasing-queries';

/**
 * What has arrived for an order, and the vendor's bill (2026-11-19, phase 4).
 * Posting a receipt is what puts stock on the shelf; it is never edited, only
 * reversed. The bill is held, saying why, until it agrees with the order and
 * what was received. Every button is drawn from what the server says this
 * person may do, and nothing here calls anything billed.
 */

const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const dollars = (cents: number) => (cents / 100).toFixed(2);

/**
 * Why a day cannot be used yet, or null (2026-11-19). The day is Texas's,
 * where the stock and the vendors are: the office in Manila is a day ahead
 * every evening, and was offered "tomorrow" by its own calendar.
 */
export function aheadOfTexas(day: string): string | null {
  const today = businessToday();
  return day && day > today ? `That day has not come yet in Texas. It is ${formatDay(today)} there.` : null;
}

function FormDialog({
  title,
  description,
  submitLabel,
  destructive,
  pending,
  error,
  disabled,
  wide,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  submitLabel: string;
  destructive?: boolean;
  pending: boolean;
  error: Error | null;
  disabled?: boolean;
  wide?: boolean;
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
      <DialogContent className={wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
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
            <Button disabled={disabled || pending} type="submit" variant={destructive ? 'destructive' : 'default'}>
              {pending ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({ title, description, label, submitLabel, pending, error, onClose, onSubmit }: { title: string; description: string; label: string; submitLabel: string; pending: boolean; error: Error | null; onClose: () => void; onSubmit: (reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog description={description} destructive disabled={!reason.trim()} error={error} onClose={onClose} onSubmit={() => onSubmit(reason.trim())} pending={pending} submitLabel={submitLabel} title={title}>
      <Field>
        <FieldLabel htmlFor="reason-text">{label}</FieldLabel>
        <Textarea id="reason-text" maxLength={500} onChange={(event) => setReason(event.target.value)} required rows={3} value={reason} />
      </Field>
    </FormDialog>
  );
}

// ── Receiving ─────────────────────────────────────────────────────────────

export function ReceivingSection({ data }: { data: PurchaseOrderDetail }) {
  const edits = usePurchaseReceivingEdits();
  const [receiving, setReceiving] = useState(false);
  const [reversing, setReversing] = useState<GoodsReceiptRow | null>(null);
  const [closing, setClosing] = useState(false);
  const toCome = data.lines.reduce((sum, line) => sum + (line.quantity - line.receivedQuantity), 0);

  return (
    <AsideCard
      action={
        data.can.receive ? (
          <Button onClick={() => setReceiving(true)} size="sm">
            Receive goods
          </Button>
        ) : undefined
      }
      title="What has arrived"
    >
      {data.receipts.length ? (
        <ol aria-label="Receipts, newest first" className="grid gap-3">
          {data.receipts.map((receipt) => (
            <li className="grid gap-1 border-b pb-3 last:border-b-0 last:pb-0" key={receipt.id}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{receipt.number}</span>
                <span className="text-muted-foreground">{formatDay(receipt.receivedOn)}</span>
                {receipt.reversed ? <Badge variant="outline">Reversed</Badge> : null}
                {!receipt.reversed && data.can.reverseReceipt ? (
                  <Button aria-label={`Reverse ${receipt.number}`} className="ml-auto" onClick={() => setReversing(receipt)} size="sm" variant="outline">
                    Reverse
                  </Button>
                ) : null}
              </span>
              <span className={receipt.reversed ? 'text-muted-foreground line-through' : undefined}>
                {receipt.lines.map((line) => `${formatCount(line.quantity)} × ${line.itemName}, into ${line.placeName}`).join('; ')}
              </span>
              <span className="text-muted-foreground text-xs">
                {receipt.by}
                {receipt.packingSlip ? ` · packing slip ${receipt.packingSlip}` : ''}
                {receipt.note ? ` · ${receipt.note}` : ''}
                {receipt.reversed ? ` · reversed by ${receipt.reversed.by}: ${receipt.reversed.reason}` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground">Nothing has arrived yet.</p>
      )}
      {data.shortCloseReason ? <p className="text-muted-foreground mt-3 text-xs">The rest will not arrive: {data.shortCloseReason}</p> : null}
      {data.can.closeShort ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">{formatCount(toCome)} still to come.</span>
          <Button onClick={() => setClosing(true)} size="sm" variant="outline">
            The rest will not arrive
          </Button>
        </div>
      ) : null}

      {receiving ? <ReceiveDialog data={data} onClose={() => { setReceiving(false); edits.receive.reset(); }} /> : null}
      {reversing ? (
        <ReasonDialog
          description={`This takes ${reversing.number}'s stock back out with new lines in the ledger. The receipt stays, marked reversed, and this cannot be undone.`}
          error={edits.reverseReceipt.error}
          label="Why"
          onClose={() => {
            setReversing(null);
            edits.reverseReceipt.reset();
          }}
          onSubmit={(reason) => edits.reverseReceipt.mutateAsync({ receiptId: reversing.id, input: { reason } })}
          pending={edits.reverseReceipt.isPending}
          submitLabel="Reverse receipt"
          title={`Reverse ${reversing.number}?`}
        />
      ) : null}
      {closing ? (
        <ReasonDialog
          description="The order is finished with what has arrived, and can be billed and closed on that. No more can be received against it, and this cannot be undone."
          error={edits.closeShort.error}
          label="Why the rest will not arrive"
          onClose={() => {
            setClosing(false);
            edits.closeShort.reset();
          }}
          onSubmit={(reason) => edits.closeShort.mutateAsync({ orderId: data.id, input: { reason } })}
          pending={edits.closeShort.isPending}
          submitLabel="Finish the order"
          title="The rest will not arrive?"
        />
      ) : null}
    </AsideCard>
  );
}

function ReceiveDialog({ data, onClose }: { data: PurchaseOrderDetail; onClose: () => void }) {
  const { receive } = usePurchaseReceivingEdits();
  // The places in use: the form's own read, kept a minute.
  const choices = useRequisitionChoices(true);
  const places = choices.data?.places ?? [];
  const open = data.lines.filter((line) => line.receivedQuantity < line.quantity);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(open.map((line) => [line.id, String(line.quantity - line.receivedQuantity)])));
  const [placeOf, setPlaceOf] = useState<Record<string, string>>({});
  const [receivedOn, setReceivedOn] = useState('');
  const [packingSlip, setPackingSlip] = useState('');
  const [note, setNote] = useState('');
  // One key for this opening of the form: a second click or a retry is the same receipt.
  const [requestKey] = useState(() => crypto.randomUUID());

  const fallback = data.deliverTo && places.some((place) => place.id === data.deliverTo?.id) ? data.deliverTo.id : (places[0]?.id ?? '');
  const rows = open.map((line) => {
    const typed = quantities[line.id] ?? '';
    const quantity = typed.trim() === '' ? 0 : whole(typed);
    const remaining = line.quantity - line.receivedQuantity;
    // Each line where it goes (2026-11-23), else the order's place.
    const own = line.place && places.some((place) => place.id === line.place?.id) ? line.place.id : null;
    return { line, remaining, quantity, placeId: placeOf[line.id] ?? own ?? fallback, over: quantity !== null && quantity > remaining };
  });
  const invalid = rows.some((row) => row.quantity === null || row.over) || !rows.some((row) => row.quantity) || !fallback || Boolean(aheadOfTexas(receivedOn));
  const units = rows.reduce((sum, row) => sum + (row.quantity ?? 0), 0);

  return (
    <FormDialog
      description={`What arrived for ${data.number}. Posting it puts the stock on the shelf. A receipt cannot be edited after, only reversed.`}
      disabled={invalid}
      error={receive.error}
      onClose={onClose}
      onSubmit={() =>
        receive.mutateAsync({
          orderId: data.id,
          input: {
            ...(receivedOn ? { receivedOn } : {}),
            ...(packingSlip.trim() ? { packingSlip: packingSlip.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            requestKey,
            lines: rows.flatMap((row) => (row.quantity ? [{ orderLineId: row.line.id, placeId: row.placeId, quantity: row.quantity }] : [])),
          },
        })
      }
      pending={receive.isPending}
      submitLabel="Post receipt"
      title="Receive goods"
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="receive-day">Day it arrived</FieldLabel>
          <Input id="receive-day" max={businessToday()} onChange={(event) => setReceivedOn(event.target.value)} type="date" value={receivedOn} />
          <FieldDescription>Leave empty for today in Texas, {formatDay(businessToday())}.</FieldDescription>
          <FieldError>{aheadOfTexas(receivedOn)}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="receive-slip">Packing slip no.</FieldLabel>
          <Input autoComplete="off" id="receive-slip" maxLength={80} onChange={(event) => setPackingSlip(event.target.value)} value={packingSlip} />
        </Field>
      </div>
      <ScanField
        hint="Scan a box's label to jump to its line."
        id="receive-scan"
        items={open.map((line) => ({ id: line.id, code: line.item.code }))}
        missing={(code) => (data.lines.some((line) => line.item.code === code) ? `${code} has all arrived already.` : `${code} is not on this order.`)}
        onItem={(line) => {
          const field = document.getElementById(`receive-line-${line.id}`);
          if (field instanceof HTMLInputElement) {
            field.focus();
            field.select();
          }
        }}
      />
      <div className="overflow-clip rounded-xl border">
        <Table aria-label="What arrived now">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Still to come</TableHead>
              <TableHead className="text-right">Arrived now</TableHead>
              <TableHead>Put in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.line.id}>
                <TableCell>
                  <span className="grid gap-0.5">
                    <span className="font-medium">{row.line.item.name}</span>
                    {row.over ? <span className="text-destructive text-xs">Only {formatCount(row.remaining)} still to come.</span> : null}
                    {row.quantity !== null && row.quantity > 0 && row.quantity < row.remaining ? (
                      <span className="text-warning text-xs">{formatCount(row.remaining - row.quantity)} fewer than ordered. The order stays open for them.</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCount(row.remaining)}</TableCell>
                <TableCell className="text-right">
                  <Input
                    aria-label={`${row.line.item.name} arrived now`}
                    className="ml-auto w-20 text-right"
                    id={`receive-line-${row.line.id}`}
                    inputMode="numeric"
                    onChange={(event) => setQuantities((all) => ({ ...all, [row.line.id]: event.target.value }))}
                    value={quantities[row.line.id] ?? ''}
                  />
                </TableCell>
                <TableCell>
                  <Select onValueChange={(placeId) => setPlaceOf((all) => ({ ...all, [row.line.id]: placeId }))} value={row.placeId}>
                    <SelectTrigger aria-label={`Place for ${row.line.item.name}`} className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {places.map((place) => (
                        <SelectItem key={place.id} value={place.id}>
                          {place.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Field>
        <FieldLabel htmlFor="receive-note">Note, for damage or a short delivery</FieldLabel>
        <Input autoComplete="off" id="receive-note" maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} />
      </Field>
      <p className="text-muted-foreground text-xs" role="status">
        {units ? `Posting adds ${formatCount(units)} unit${units === 1 ? '' : 's'} to stock.` : 'Enter what arrived. Leave a line at 0 if none of it came.'}
      </p>
    </FormDialog>
  );
}

// ── The vendor's bill ─────────────────────────────────────────────────────

const BILL_TONE: Record<VendorBillStatus, 'destructive' | 'info' | 'success'> = { HELD: 'destructive', MATCHED: 'info', APPROVED: 'success', PAID: 'success' };

export function BillSection({ data }: { data: PurchaseOrderDetail }) {
  const edits = usePurchaseReceivingEdits();
  const [entering, setEntering] = useState(false);
  const [paying, setPaying] = useState(false);
  const [reason, setReason] = useState('');
  const bill = data.bill;

  return (
    <AsideCard
      action={
        data.can.bill ? (
          <Button onClick={() => setEntering(true)} size="sm" variant={bill ? 'outline' : 'default'}>
            {bill ? 'Change the bill' : 'Enter the bill'}
          </Button>
        ) : undefined
      }
      title="The vendor's bill"
    >
      {bill ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-medium">{bill.billNumber}</span>
            <Badge variant={BILL_TONE[bill.status]}>{VENDOR_BILL_STATUS_LABEL[bill.status]}</Badge>
          </div>
          <FactTable
            facts={[
              { label: 'Bill date', value: formatDay(bill.billDate) },
              { label: 'Bill total', value: formatMoney(bill.totalCents) },
              { label: 'Entered by', value: bill.enteredBy },
              ...(bill.approvedBy ? [{ label: 'Approved by', value: bill.approvedBy, detail: bill.approvedAt ? formatDateTime(bill.approvedAt) : undefined }] : []),
              ...(bill.overrideReason ? [{ label: 'Approved although it did not match', value: bill.overrideReason }] : []),
              ...(bill.paidOn
                ? [{ label: 'Paid', value: `${formatDay(bill.paidOn)}${bill.method ? `, ${VENDOR_PAYMENT_METHOD_LABEL[bill.method].toLowerCase()}` : ''}`, detail: [bill.reference, bill.paidBy].filter(Boolean).join(' · ') || undefined }]
                : []),
            ]}
            label="The vendor's bill"
          />
          {bill.problems.length && bill.status === 'HELD' ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>
                <ul aria-label="Why the bill is held" className="grid gap-1">
                  {bill.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {edits.approveBill.error || edits.approveBillAnyway.error ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{(edits.approveBill.error ?? edits.approveBillAnyway.error)?.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-3 grid gap-2">
            {data.can.approveBill ? (
              <Button disabled={edits.approveBill.isPending} onClick={() => void edits.approveBill.mutateAsync(data.id).catch(() => undefined)}>
                Approve bill for payment
              </Button>
            ) : null}
            {data.can.overrideBill ? (
              <>
                <Field>
                  <FieldLabel htmlFor="bill-override-reason">Reason to approve it although it does not match</FieldLabel>
                  <Textarea id="bill-override-reason" maxLength={1000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
                  <FieldDescription>Kept on the bill and in the audit log, with your name.</FieldDescription>
                </Field>
                <Button
                  disabled={edits.approveBillAnyway.isPending || !reason.trim()}
                  onClick={() => void edits.approveBillAnyway.mutateAsync({ orderId: data.id, input: { reason: reason.trim() } }).catch(() => undefined)}
                  variant="outline"
                >
                  Approve anyway
                </Button>
              </>
            ) : null}
            {data.can.pay ? <Button onClick={() => setPaying(true)}>Record payment</Button> : null}
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">No bill entered yet. It is matched against this order and its receipts before it can be paid.</p>
      )}

      {entering ? <BillDialog data={data} onClose={() => { setEntering(false); edits.saveBill.reset(); }} /> : null}
      {paying ? <PayDialog data={data} onClose={() => { setPaying(false); edits.payBill.reset(); }} /> : null}
    </AsideCard>
  );
}

function BillDialog({ data, onClose }: { data: PurchaseOrderDetail; onClose: () => void }) {
  const { saveBill } = usePurchaseReceivingEdits();
  const bill = data.bill;
  const billed = new Map(bill?.lines.map((line) => [line.orderLineId, line]));
  const [billNumber, setBillNumber] = useState(bill?.billNumber ?? '');
  const [billDate, setBillDate] = useState(bill?.billDate ?? '');
  const [total, setTotal] = useState(bill ? dollars(bill.totalCents) : '');
  // A new bill starts from what arrived, at the order's prices: the usual case, to check against the paper.
  const [rows, setRows] = useState<Record<string, { quantity: string; price: string }>>(() =>
    Object.fromEntries(data.lines.map((line) => [line.id, { quantity: String(bill ? (billed.get(line.id)?.quantity ?? 0) : line.receivedQuantity), price: dollars(billed.get(line.id)?.unitPriceCents ?? line.unitPriceCents) }])),
  );
  const setRow = (lineId: string, change: Partial<{ quantity: string; price: string }>) => setRows((all) => ({ ...all, [lineId]: { ...all[lineId]!, ...change } }));

  const parsed = data.lines.map((line) => {
    const row = rows[line.id]!;
    const quantity = row.quantity.trim() === '' ? 0 : whole(row.quantity);
    const price = row.price.trim() ? parseMoney(row.price) : null;
    return { line, quantity, price };
  });
  const totalCents = total.trim() ? parseMoney(total) : null;
  const invalid = !billNumber.trim() || !billDate || Boolean(aheadOfTexas(billDate)) || totalCents === null || totalCents < 0 || parsed.some((row) => row.quantity === null || (row.quantity > 0 && (row.price === null || row.price < 0)));

  return (
    <FormDialog
      description={`The vendor's invoice for ${data.number}, as it reads on the paper. It is checked against the order and what arrived as it is saved.`}
      disabled={invalid}
      error={saveBill.error}
      onClose={onClose}
      onSubmit={() =>
        saveBill.mutateAsync({
          orderId: data.id,
          input: {
            billNumber: billNumber.trim(),
            billDate,
            totalCents: totalCents ?? 0,
            lines: parsed.flatMap((row) => (row.quantity ? [{ orderLineId: row.line.id, quantity: row.quantity, unitPriceCents: row.price ?? 0 }] : [])),
          },
        })
      }
      pending={saveBill.isPending}
      submitLabel="Save the bill"
      title={bill ? 'Change the bill' : "Enter the vendor's bill"}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="bill-number">Bill no.</FieldLabel>
          <Input autoComplete="off" id="bill-number" maxLength={80} onChange={(event) => setBillNumber(event.target.value)} required value={billNumber} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bill-date">Bill date</FieldLabel>
          <Input id="bill-date" max={businessToday()} onChange={(event) => setBillDate(event.target.value)} required type="date" value={billDate} />
          <FieldError>{aheadOfTexas(billDate)}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="bill-total">Bill total</FieldLabel>
          <Input id="bill-total" inputMode="decimal" onChange={(event) => setTotal(event.target.value)} placeholder="0.00" required value={total} />
          <FieldDescription>With tax, as printed.</FieldDescription>
        </Field>
      </div>
      <div className="overflow-clip rounded-xl border">
        <Table aria-label="What the bill charges for">
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Received</TableHead>
              <TableHead className="text-right">Billed</TableHead>
              <TableHead className="text-right">Price each</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell className="font-medium">{line.item.name}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCount(line.quantity)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{formatCount(line.receivedQuantity)}</TableCell>
                <TableCell className="text-right">
                  <Input aria-label={`${line.item.name} billed`} className="ml-auto w-20 text-right" inputMode="numeric" onChange={(event) => setRow(line.id, { quantity: event.target.value })} value={rows[line.id]!.quantity} />
                </TableCell>
                <TableCell className="text-right">
                  <Input aria-label={`Billed price of one ${line.item.name}`} className="ml-auto w-24 text-right" inputMode="decimal" onChange={(event) => setRow(line.id, { price: event.target.value })} value={rows[line.id]!.price} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground text-xs">Enter what the bill says, even where it differs: the console then holds it and says why.</p>
    </FormDialog>
  );
}

function PayDialog({ data, onClose }: { data: PurchaseOrderDetail; onClose: () => void }) {
  const { payBill } = usePurchaseReceivingEdits();
  const [paidOn, setPaidOn] = useState('');
  const [method, setMethod] = useState<VendorPaymentMethod>('CHECK');
  const [reference, setReference] = useState('');
  return (
    <FormDialog
      description={`Writes down that ${data.bill?.billNumber} for ${formatMoney(data.bill?.totalCents ?? 0)} was paid. No money moves in the console.`}
      disabled={!paidOn || Boolean(aheadOfTexas(paidOn))}
      error={payBill.error}
      onClose={onClose}
      onSubmit={() => payBill.mutateAsync({ orderId: data.id, input: { paidOn, method, ...(reference.trim() ? { reference: reference.trim() } : {}) } })}
      pending={payBill.isPending}
      submitLabel="Record payment"
      title="Record payment"
    >
      <Field>
        <FieldLabel htmlFor="pay-day">Day it was paid</FieldLabel>
        <Input id="pay-day" max={businessToday()} onChange={(event) => setPaidOn(event.target.value)} required type="date" value={paidOn} />
        <FieldError>{aheadOfTexas(paidOn)}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor="pay-method">How</FieldLabel>
        <Select onValueChange={(next) => setMethod(next as VendorPaymentMethod)} value={method}>
          <SelectTrigger className="w-full" id="pay-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VENDOR_PAYMENT_METHODS.map((option) => (
              <SelectItem key={option} value={option}>
                {VENDOR_PAYMENT_METHOD_LABEL[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="pay-reference">Reference</FieldLabel>
        <Input autoComplete="off" id="pay-reference" maxLength={80} onChange={(event) => setReference(event.target.value)} placeholder="Check number, transfer reference" value={reference} />
      </Field>
    </FormDialog>
  );
}
