'use client';

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  formatMoney,
  parseMoney,
  paymentProblem,
  type InvoiceDetail,
  type PaymentMethod,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { businessToday } from '@/lib/clock';
import { newClientRequestId, useInvoiceActions } from '@/lib/invoice-queries';

/**
 * Recording a payment against an invoice (the office, 2026-11-05).
 *
 * The money comes in through the tenant's ledger in Propertyware; this is the
 * office saying so, which marks the invoice paid in Jobber once all of it is.
 * No card is charged, here or anywhere: the form records what has already
 * happened. Never more than is owed, never on a day still to come, and one
 * key per opening, so a double click or a resend records one payment.
 */
export function RecordPaymentDialog({
  invoice,
  open,
  onClose,
}: {
  invoice: InvoiceDetail;
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const today = businessToday();
  const actions = useInvoiceActions();
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>('PROPERTYWARE_LEDGER');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newClientRequestId);

  // Filled from the invoice each time it opens: the whole balance, today, the ledger.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (open && openedFor !== invoice.id) {
    setOpenedFor(invoice.id);
    setAmount((invoice.balanceCents / 100).toFixed(2));
    setPaidOn(today);
    setMethod('PROPERTYWARE_LEDGER');
    setReference('');
    setNote('');
    setKey(newClientRequestId());
  }
  if (!open && openedFor) setOpenedFor(null);

  const amountCents = parseMoney(amount);
  const problem =
    amountCents === null ? 'Give the amount in dollars and cents.' : paymentProblem({ amountCents, paidOn }, invoice.balanceCents, today);

  const save = () => {
    if (problem || amountCents === null) return;
    actions.recordPayment.mutate(
      {
        invoiceId: invoice.id,
        input: {
          amountCents,
          paidOn,
          method,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          clientRequestId: key,
        },
      },
      {
        onSuccess: (saved) => {
          toast.success(`${formatMoney(amountCents)} recorded`, {
            description: saved.balanceCents > 0 ? `${formatMoney(saved.balanceCents)} still owed.` : 'The invoice is paid.',
          });
          onClose();
        },
        onError: (error) => toast.error('The payment was not recorded', { description: error.message }),
      },
    );
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            For invoice {invoice.number ? `#${invoice.number}` : ''} to {invoice.clientName}:{' '}
            {formatMoney(invoice.balanceCents)} still owed. Record it once the charge has posted in Propertyware;
            no card is charged.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-amount`}>Amount</FieldLabel>
            <Input
              className="tabular-nums"
              id={`${id}-amount`}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
              value={amount}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-day`}>Paid on</FieldLabel>
            <Input
              id={`${id}-day`}
              max={today}
              onChange={(event) => setPaidOn(event.target.value)}
              type="date"
              value={paidOn}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-method`}>How it was paid</FieldLabel>
            <Select onValueChange={(value) => setMethod(value as PaymentMethod)} value={method}>
              <SelectTrigger className="w-full" id={`${id}-method`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PAYMENT_METHOD_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-reference`}>Reference (optional)</FieldLabel>
            <Input
              id={`${id}-reference`}
              maxLength={80}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Receipt or check number"
              value={reference}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${id}-note`}>Note (optional)</FieldLabel>
            <Textarea
              className="min-h-16"
              id={`${id}-note`}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
            <FieldDescription aria-live="polite" className={problem ? 'text-destructive' : undefined}>
              {problem ?? 'Kept here with who recorded it.'}
            </FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={Boolean(problem) || actions.recordPayment.isPending} onClick={save}>
            {actions.recordPayment.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
