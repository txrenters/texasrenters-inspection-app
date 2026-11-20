'use client';

import {
  MOST_TAX_BASIS_POINTS,
  VENDOR_FILES_MAX_BYTES,
  formatFileSize,
  formatMoney,
  approvalStepFor,
  approvalStepRange,
  approverSaying,
  formatTaxRate,
  orderChangeNeedsApproval,
  orderSubmitProblem,
  orderTotals,
  parseMoney,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  type RequisitionChoices,
  type SavePurchaseOrderInput,
} from '@texasrenters/shared';
import { PackageIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { BillInXeroSection } from '@/components/purchasing/bill-in-xero';
import { BillSection, ReceivingSection } from '@/components/purchasing/order-receiving';
import { PurchaseOrderStatusBadge, PurchaseOrderSteps } from '@/components/purchasing/requisition-parts';
import { AsideCard, FactTable } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EMPTY, formatCount, formatDateTime, formatDay } from '@/lib/format';
import { downloadOrder, orderAttachment } from '@/lib/purchase-order-pdf/download-order';
import { usePurchaseOrder, usePurchaseOrderEdits, useRequisitionChoices, type PurchaseOrderStep } from '@/lib/purchasing-queries';

/**
 * One purchase order (2026-11-19, phase 3). Its purchaser sees the form while
 * it is a draft; everybody else, and the purchaser once it is submitted, sees
 * it as it stands. Every button is drawn from what the server says this person
 * may do. The PDF is made in the browser; emailing it to the vendor is the one
 * thing here that costs, so it happens only on its own button, once a press.
 * What has arrived and the vendor's bill (phase 4) sit under its lines.
 */

const NONE = 'none';
const chosen = (value: string) => (value === NONE ? null : value);
const dollars = (cents: number) => (cents / 100).toFixed(2);

const LINE_COLUMNS: Array<Column<PurchaseOrderLine>> = [
  {
    key: 'item',
    header: 'Item',
    primary: true,
    cell: (line) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{line.item.name}</span>
        <span className="text-muted-foreground text-xs">
          {line.item.code} · {line.item.unit}
        </span>
      </span>
    ),
  },
  { key: 'asked', header: 'Asked for', numeric: true, hideBelow: 'md', cell: (line) => formatCount(line.requestedQuantity) },
  { key: 'quantity', header: 'Ordered', numeric: true, cell: (line) => formatCount(line.quantity) },
  { key: 'received', header: 'Received', numeric: true, cell: (line) => formatCount(line.receivedQuantity) },
  {
    key: 'toCome',
    header: 'Still to come',
    numeric: true,
    hideBelow: 'sm',
    cell: (line) => (line.quantity > line.receivedQuantity ? <Badge variant="warning">{formatCount(line.quantity - line.receivedQuantity)}</Badge> : formatCount(0)),
  },
  { key: 'each', header: 'Price each', numeric: true, cell: (line) => formatMoney(line.unitPriceCents) },
  { key: 'total', header: 'Total', numeric: true, cell: (line) => formatMoney(line.quantity * line.unitPriceCents) },
];

export default function PurchaseOrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const order = usePurchaseOrder(orderId);
  // An approved order opened for a change (Purchasing Setup, 2026-11-20); a draft is always open.
  const [changing, setChanging] = useState(false);
  const editing = Boolean(order.data?.can.edit) || (changing && Boolean(order.data?.can.change));
  const choices = useRequisitionChoices(editing);
  const edits = usePurchaseOrderEdits();

  if (order.isLoading || (editing && choices.isLoading)) return <PageSkeleton />;
  if (order.isError || !order.data) return <ErrorState error={order.error} retry={() => void order.refetch()} />;
  if (editing && (choices.isError || !choices.data)) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;

  const data = order.data;
  return (
    <>
      <PageHeader
        badges={<PurchaseOrderStatusBadge status={data.status} />}
        className="mb-3"
        description={
          <>
            <Link className="underline-offset-4 hover:underline" href="/purchasing?tab=orders">
              Purchasing
            </Link>
            {` · ${data.vendor?.name ?? 'No vendor chosen yet'} · ${data.company?.name ?? 'No company'} · from `}
            <Link className="underline-offset-4 hover:underline" href={`/purchasing/requisitions/${data.requisition.id}`}>
              {data.requisition.number ?? 'its requisition'}
            </Link>
          </>
        }
        prominent
        record={{ icon: PackageIcon, tone: 'text-info', label: 'Purchase order' }}
        title={data.number ? `Purchase order ${data.number}` : 'Purchase order, draft'}
      />
      <div className="mb-6">
        <PurchaseOrderSteps status={data.status} />
      </div>

      {data.status === 'DRAFT' && data.decisionNote ? (
        <Alert className="mb-6" variant="warning">
          <AlertDescription>It was sent back: “{data.decisionNote}”</AlertDescription>
        </Alert>
      ) : null}
      {data.status === 'CANCELLED' ? (
        <Alert className="mb-6" variant="destructive">
          <AlertDescription>Cancelled: “{data.cancelReason}”</AlertDescription>
        </Alert>
      ) : null}

      {editing && choices.data ? (
        <OrderForm
          choices={choices.data}
          error={edits.update.error ?? edits.step.error}
          key={data.id}
          onCancelChange={data.can.edit ? undefined : () => setChanging(false)}
          onSave={async (input, submit) => {
            await edits.update.mutateAsync({ orderId, input });
            if (submit) await edits.step.mutateAsync({ orderId, step: 'submit' });
            setChanging(false);
          }}
          order={data}
          pending={edits.update.isPending || edits.step.isPending}
        />
      ) : (
        <OrderView data={data} onChange={data.can.change ? () => setChanging(true) : undefined} />
      )}
    </>
  );
}

// ── The draft, as its purchaser fills it in ───────────────────────────────

interface LineDraft {
  itemId: string;
  quantity: string;
  price: string;
  kept: boolean;
}

function OrderForm({
  order,
  choices,
  onSave,
  onCancelChange,
  pending,
  error,
}: {
  order: PurchaseOrderDetail;
  choices: RequisitionChoices;
  onSave: (input: SavePurchaseOrderInput, submit: boolean) => Promise<unknown>;
  /** Set while an approved order is being changed: leaves it as it was. */
  onCancelChange?: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const changing = Boolean(onCancelChange);
  const [vendor, setVendor] = useState(order.vendor?.id ?? NONE);
  const [place, setPlace] = useState(order.deliverTo?.id ?? NONE);
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? '');
  const [terms, setTerms] = useState(order.terms ?? '');
  const [tax, setTax] = useState(order.taxBasisPoints ? String(order.taxBasisPoints / 100) : '');
  const [notes, setNotes] = useState(order.notes ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() => order.lines.map((line) => ({ itemId: line.item.id, quantity: String(line.quantity), price: dollars(line.unitPriceCents), kept: true })));
  const setLine = (itemId: string, change: Partial<LineDraft>) => setLines((rows) => rows.map((row) => (row.itemId === itemId ? { ...row, ...change } : row)));

  // "8.25" is 825 hundredths of a percent; empty is no tax.
  const rate = tax.trim() === '' ? 0 : Number(tax);
  const taxBasisPoints = Number.isFinite(rate) && rate >= 0 && Math.round(rate * 100) <= MOST_TAX_BASIS_POINTS ? Math.round(rate * 100) : null;
  const parsed = lines.map((line) => {
    if (!line.kept) return 'left out' as const;
    const quantity = /^\d+$/.test(line.quantity.trim()) && Number(line.quantity) > 0 ? Number(line.quantity) : null;
    const price = line.price.trim() ? parseMoney(line.price) : null;
    return quantity !== null && price !== null && price >= 0 ? { itemId: line.itemId, quantity, unitPriceCents: price } : null;
  });
  const complete = taxBasisPoints !== null && parsed.every((line) => line !== null);
  const input: SavePurchaseOrderInput = {
    vendorId: chosen(vendor),
    deliverToPlaceId: chosen(place),
    expectedOn: expectedOn || null,
    terms: terms.trim() || null,
    taxBasisPoints: taxBasisPoints ?? 0,
    notes: notes.trim() || null,
    lines: parsed.flatMap((line) => (line && line !== 'left out' ? [line] : [])),
  };
  const totals = orderTotals(input.lines, input.taxBasisPoints);
  const problem = complete ? orderSubmitProblem(input) : 'Finish the quantities, prices and tax rate.';
  const save = (submit: boolean) => {
    if (pending || !complete || (submit && problem)) return;
    void onSave(input, submit).catch(() => undefined);
  };
  // The order's own vendor, even if it has been switched off since.
  const vendors = [...choices.vendors];
  if (order.vendor && !vendors.some((option) => option.id === order.vendor?.id)) vendors.push(order.vendor);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 gap-6">
        <section className="bg-card grid gap-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="order-vendor">Vendor</FieldLabel>
              <Select onValueChange={setVendor} value={vendor}>
                <SelectTrigger className="w-full" id="order-vendor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Choose a vendor</SelectItem>
                  {vendors.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="order-place">Deliver to</FieldLabel>
              <Select onValueChange={setPlace} value={place}>
                <SelectTrigger className="w-full" id="order-place">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not decided</SelectItem>
                  {choices.places.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="order-expected">Expected by</FieldLabel>
              <Input id="order-expected" onChange={(event) => setExpectedOn(event.target.value)} type="date" value={expectedOn} />
            </Field>
            <Field>
              <FieldLabel htmlFor="order-terms">Payment terms</FieldLabel>
              <Input autoComplete="off" id="order-terms" maxLength={60} onChange={(event) => setTerms(event.target.value)} placeholder="Net 30" value={terms} />
            </Field>
            <Field>
              <FieldLabel htmlFor="order-tax">Sales tax, %</FieldLabel>
              <Input id="order-tax" inputMode="decimal" onChange={(event) => setTax(event.target.value)} placeholder="0" value={tax} />
              <FieldDescription>{taxBasisPoints === null ? 'A rate from 0 to 30, like 8.25.' : 'Empty for none.'}</FieldDescription>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="order-notes">Notes for the vendor</FieldLabel>
            <Textarea id="order-notes" maxLength={2000} onChange={(event) => setNotes(event.target.value)} rows={2} value={notes} />
            <FieldDescription>Printed on the order.</FieldDescription>
          </Field>
        </section>

        <section className="grid gap-3">
          <h2 className="text-heading text-base font-bold">What is ordered</h2>
          <div className="bg-card overflow-clip rounded-xl border">
            <Table aria-label="What is ordered">
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Asked for</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Price each</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>
                    <span className="sr-only">Leave out</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((line, index) => {
                  const draft = lines[index]!;
                  const row = parsed[index];
                  return (
                    <TableRow className={draft.kept ? undefined : 'opacity-60'} key={line.id}>
                      <TableCell>
                        <span className="grid gap-0.5">
                          <span className="font-medium">{line.item.name}</span>
                          <span className="text-muted-foreground text-xs">{line.item.code}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCount(line.requestedQuantity)}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          aria-label={`Quantity of ${line.item.name}`}
                          className="ml-auto w-20 text-right"
                          disabled={!draft.kept}
                          inputMode="numeric"
                          onChange={(event) => setLine(draft.itemId, { quantity: event.target.value })}
                          value={draft.quantity}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          aria-label={`Price of one ${line.item.name}`}
                          className="ml-auto w-24 text-right"
                          disabled={!draft.kept}
                          inputMode="decimal"
                          onChange={(event) => setLine(draft.itemId, { price: event.target.value })}
                          value={draft.price}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{row && row !== 'left out' ? formatMoney(row.quantity * row.unitPriceCents) : ''}</TableCell>
                      <TableCell className="text-right">
                        <Button aria-label={`${draft.kept ? 'Leave out' : 'Put back'} ${line.item.name}`} onClick={() => setLine(draft.itemId, { kept: !draft.kept })} size="sm" type="button" variant="outline">
                          {draft.kept ? 'Leave out' : 'Put back'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs">An order holds only what its requisition asked for. The quantity and the price are what was agreed with the vendor.</p>
        </section>
      </div>

      <aside className="grid gap-4">
        <AsideCard title={changing ? 'Changing an approved order' : 'Before you submit'}>
          <Totals subtotalCents={totals.subtotalCents} taxBasisPoints={input.taxBasisPoints} taxCents={totals.taxCents} totalCents={totals.totalCents} />
          <p className="text-muted-foreground mt-3 text-xs">
            {changing
              ? orderChangeNeedsApproval(
                  { totalCents: order.totalCents, itemIds: order.lines.map((line) => line.item.id), vendorId: order.vendor?.id ?? null },
                  { totalCents: totals.totalCents, itemIds: input.lines.map((line) => line.itemId), vendorId: input.vendorId },
                  order.reapproveChangedOrders,
                )
                ? `This change goes back for approval: ${approverSaying(approvalStepFor(totals.totalCents, order.approvalSteps)).toLowerCase()} approves it again.`
                : `This change stays approved${order.status === 'SENT' ? ', and the order is to be sent to the vendor again' : ''}.`
              : `${approverSaying(approvalStepFor(totals.totalCents, order.approvalSteps))} approves it at this amount. You made it, so somebody else approves it.`}
          </p>
          {problem ? (
            <p className="text-warning mt-3 text-xs font-medium" role="status">
              {problem}
            </p>
          ) : null}
          {error ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          {changing ? (
            <div className="mt-4 grid gap-2">
              <Button disabled={pending || Boolean(problem)} onClick={() => save(false)} type="button">
                {pending ? <Spinner /> : null}
                Save the change
              </Button>
              <Button disabled={pending} onClick={onCancelChange} type="button" variant="outline">
                Keep it as it was
              </Button>
            </div>
          ) : (
            <div className="mt-4 grid gap-2">
              <Button disabled={pending || Boolean(problem)} onClick={() => save(true)} type="button">
                {pending ? <Spinner /> : null}
                Submit for approval
              </Button>
              <Button disabled={pending || !complete} onClick={() => save(false)} type="button" variant="outline">
                Save the draft
              </Button>
            </div>
          )}
        </AsideCard>
        <OrderAside data={order} />
      </aside>
    </div>
  );
}

function Totals({ subtotalCents, taxCents, taxBasisPoints, totalCents }: { subtotalCents: number; taxCents: number; taxBasisPoints: number; totalCents: number }) {
  return (
    <FactTable
      facts={[
        { label: 'Subtotal', value: formatMoney(subtotalCents) },
        ...(taxBasisPoints ? [{ label: `Sales tax, ${formatTaxRate(taxBasisPoints)}`, value: formatMoney(taxCents) }] : []),
        { label: 'Order total', value: <strong>{formatMoney(totalCents)}</strong> },
      ]}
      label="Order totals"
    />
  );
}

// ── The order as it stands ────────────────────────────────────────────────

function OrderView({ data, onChange }: { data: PurchaseOrderDetail; onChange?: () => void }) {
  const edits = usePurchaseOrderEdits();
  const [note, setNote] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const deciding = data.can.approve || data.can.sendBack || Boolean(data.can.approveBlocked);
  const decide = (step: PurchaseOrderStep) => void edits.step.mutateAsync({ orderId: data.id, step, input: note.trim() ? { note: note.trim() } : {} }).catch(() => undefined);

  async function download() {
    setDownloading(true);
    setProblem(null);
    try {
      await downloadOrder(data);
    } catch {
      setProblem('The PDF could not be made. Try again.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 gap-6">
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-heading text-base font-bold">What is ordered</h2>
            <Button disabled={downloading || !data.lines.length} onClick={() => void download()} variant="outline">
              {downloading ? <Spinner /> : null}
              Download PDF
            </Button>
          </div>
          {problem ? (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <DataTable columns={LINE_COLUMNS} label="What is ordered" rowKey={(line) => line.id} rows={data.lines} />
          <div className="ml-auto w-full max-w-xs">
            <Totals subtotalCents={data.subtotalCents} taxBasisPoints={data.taxBasisPoints} taxCents={data.taxCents} totalCents={data.totalCents} />
          </div>
        </section>
        {data.notes ? (
          <AsideCard title="Notes for the vendor">
            <p className="whitespace-pre-wrap">{data.notes}</p>
          </AsideCard>
        ) : null}
        {['DRAFT', 'AWAITING_APPROVAL', 'CANCELLED'].includes(data.status) ? null : (
          <>
            <ReceivingSection data={data} />
            <BillSection data={data} />
            <BillInXeroSection data={data} />
          </>
        )}
      </div>

      <aside className="grid gap-4">
        {deciding ? (
          <AsideCard title="Your decision">
            <p className="text-muted-foreground text-xs">
              {data.can.approveBlocked ??
                `${formatMoney(data.totalCents)}, in the ${approvalStepRange(data.approvalSteps, data.approvalSteps.indexOf(approvalStepFor(data.totalCents, data.approvalSteps)))} step. Approving lets it be sent to the vendor.`}
            </p>
            {data.can.sendBack ? (
              <Field className="mt-3">
                <FieldLabel htmlFor="order-decision-note">Note to {data.madeBy.name}</FieldLabel>
                <Textarea id="order-decision-note" maxLength={1000} onChange={(event) => setNote(event.target.value)} rows={3} value={note} />
                <FieldDescription>Needed to send it back.</FieldDescription>
              </Field>
            ) : null}
            {edits.step.error ? (
              <Alert className="mt-3" variant="destructive">
                <AlertDescription>{edits.step.error.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="mt-4 grid gap-2">
              {data.can.approve ? (
                <Button disabled={edits.step.isPending} onClick={() => decide('approve')}>
                  Approve
                </Button>
              ) : null}
              {data.can.sendBack ? (
                <Button disabled={edits.step.isPending || !note.trim()} onClick={() => decide('send-back')} variant="outline">
                  Send back with the note
                </Button>
              ) : null}
            </div>
          </AsideCard>
        ) : null}
        <OrderAside data={data} onChange={onChange} />
      </aside>
    </div>
  );
}

/** What both the form and the view show beside the order: its details, the emails sent, its history, and send and cancel. */
function OrderAside({ data, onChange }: { data: PurchaseOrderDetail; onChange?: () => void }) {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  return (
    <>
      <AsideCard title="Order details">
        <FactTable
          facts={[
            { label: 'Vendor', value: data.vendor?.name ?? EMPTY, detail: data.vendorContact?.email ?? undefined },
            { label: 'Made by', value: data.madeBy.name, detail: formatDay(data.createdAt) },
            ...(data.approvedBy ? [{ label: 'Approved by', value: data.approvedBy, detail: data.approvedAt ? formatDateTime(data.approvedAt) : undefined }] : []),
            ...(data.terms ? [{ label: 'Terms', value: data.terms }] : []),
            ...(data.deliverTo ? [{ label: 'Deliver to', value: data.deliverTo.name }] : []),
            ...(data.expectedOn ? [{ label: 'Expected', value: formatDay(data.expectedOn) }] : []),
          ]}
          label="Order details"
        />
        {data.can.send || data.can.cancel || onChange ? (
          <div className="mt-4 grid gap-2">
            {data.can.send ? <Button onClick={() => setSending(true)}>{data.status === 'SENT' ? 'Email the vendor again' : 'Send to the vendor'}</Button> : null}
            {onChange ? (
              <Button onClick={onChange} variant="outline">
                Change the order
              </Button>
            ) : null}
            {data.can.cancel ? (
              <Button className="text-destructive" onClick={() => setCancelling(true)} variant="outline">
                Cancel this order
              </Button>
            ) : null}
          </div>
        ) : null}
      </AsideCard>

      {data.deliveries.length ? (
        <AsideCard title="Sent to the vendor">
          <ol aria-label="Emails of this order, newest first" className="grid gap-2.5">
            {data.deliveries.map((delivery) => (
              <li className="grid gap-0.5" key={delivery.id}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all">{delivery.recipient}</span>
                  <Badge variant={delivery.status === 'SENT' ? 'success' : delivery.status === 'FAILED' ? 'destructive' : 'secondary'}>
                    {delivery.status === 'SENT' ? 'Sent' : delivery.status === 'FAILED' ? 'Not sent' : 'Sending'}
                  </Badge>
                </span>
                <span className="text-muted-foreground text-xs">
                  {delivery.by} · {formatDateTime(delivery.at)}
                  {delivery.failure ? ` · ${delivery.failure}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </AsideCard>
      ) : null}

      <AsideCard title="History">
        <ol aria-label="History, newest first" className="grid gap-2.5">
          {data.history.map((entry) => (
            <li className="grid gap-0.5" key={`${entry.at} ${entry.what}`}>
              <span>
                {entry.by} {entry.what}
              </span>
              <span className="text-muted-foreground text-xs">{formatDateTime(entry.at)}</span>
            </li>
          ))}
        </ol>
      </AsideCard>

      {sending ? <SendDialog data={data} onClose={() => setSending(false)} /> : null}
      {cancelling ? <CancelDialog data={data} onClose={() => setCancelling(false)} /> : null}
    </>
  );
}

/** The email to the vendor. The PDF is made here, in the browser, when Send is pressed; one press is one email. */
function SendDialog({ data, onClose }: { data: PurchaseOrderDetail; onClose: () => void }) {
  const { send } = usePurchaseOrderEdits();
  const [to, setTo] = useState(data.vendorContact?.email ?? '');
  const [message, setMessage] = useState('');
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One key for this opening of the form: a second click or a retry is the same email.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  const pending = making || send.isPending;
  // The requisition's files ticked for the vendor ride along; past one email's room the server refuses, so the button does not ask.
  const vendorBytes = data.vendorFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  const tooBig = vendorBytes > VENDOR_FILES_MAX_BYTES;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !to.trim() || tooBig) return;
    setProblem(null);
    setMaking(true);
    let attachment: Awaited<ReturnType<typeof orderAttachment>>;
    try {
      attachment = await orderAttachment(data);
    } catch {
      setProblem('The PDF could not be made. Try again.');
      return;
    } finally {
      setMaking(false);
    }
    try {
      await send.mutateAsync({ orderId: data.id, input: { to: to.trim(), ...(message.trim() ? { message: message.trim() } : {}), attachment, clientRequestId } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{data.status === 'SENT' ? 'Email the vendor again' : 'Send to the vendor'}</DialogTitle>
          <DialogDescription>
            {data.number} for {formatMoney(data.totalCents)} goes to {data.vendor?.name ?? 'the vendor'} as a PDF, in one email to one address.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="send-to">To</FieldLabel>
            <Input autoComplete="off" id="send-to" maxLength={320} onChange={(event) => setTo(event.target.value)} required type="email" value={to} />
            {data.vendorContact?.email ? null : <FieldDescription>The vendor has no email saved. Add it on Inventory, under Vendors, to have it filled in.</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel htmlFor="send-message">Message</FieldLabel>
            <Textarea id="send-message" maxLength={2000} onChange={(event) => setMessage(event.target.value)} rows={3} value={message} />
          </Field>
          {data.vendorFiles.length ? (
            <section aria-label="Files that go with it" className="grid gap-1.5 text-sm">
              <p className="font-medium">With the PDF, from the requisition</p>
              <ul className="text-muted-foreground grid gap-0.5 text-xs">
                {data.vendorFiles.map((file) => (
                  <li className="flex justify-between gap-3" key={file.id}>
                    <span className="truncate">{file.fileName}</span>
                    <span className="shrink-0 tabular-nums">{formatFileSize(file.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
              {tooBig ? (
                <p className="text-destructive text-xs font-medium" role="status">
                  These come to {formatFileSize(vendorBytes)}, and one email carries at most {formatFileSize(VENDOR_FILES_MAX_BYTES)} beside the PDF. Untick some on the requisition, or send them on their own.
                </p>
              ) : null}
            </section>
          ) : null}
          {problem || send.error ? (
            <Alert variant="destructive">
              <AlertDescription>{problem ?? send.error?.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={pending || !to.trim() || tooBig} type="submit">
              {pending ? <Spinner /> : null}
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ data, onClose }: { data: PurchaseOrderDetail; onClose: () => void }) {
  const { step } = usePurchaseOrderEdits();
  const [reason, setReason] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (step.isPending || !reason.trim()) return;
    try {
      await step.mutateAsync({ orderId: data.id, step: 'cancel', input: { reason: reason.trim() } });
      onClose();
    } catch {
      // The mutation holds the API's message; it is shown below.
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel this order?</DialogTitle>
          <DialogDescription>
            {data.status === 'SENT'
              ? 'The vendor already has it. Cancelling here does not tell them: do that yourself. '
              : ''}
            Its requisition becomes approved again, so another order can be made from it. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="cancel-reason">Why</FieldLabel>
            <Textarea id="cancel-reason" maxLength={1000} onChange={(event) => setReason(event.target.value)} required rows={3} value={reason} />
          </Field>
          {step.error ? (
            <Alert variant="destructive">
              <AlertDescription>{step.error.message}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Keep the order
            </Button>
            <Button disabled={step.isPending || !reason.trim()} type="submit" variant="destructive">
              Cancel the order
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
