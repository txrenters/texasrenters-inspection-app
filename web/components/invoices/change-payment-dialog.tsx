'use client';

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  formatMoney,
  owedBeforePayment,
  parseMoney,
  paymentProblem,
  type PaymentDetail,
  type PaymentMethod,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

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
import { Button, buttonVariants } from '@/components/ui/button';
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
import { useInvoiceActions } from '@/lib/invoice-queries';

/**
 * Correcting a payment (2026-11-06, phase 2 of taking invoicing over from
 * Jobber): the amount, the day, how it was paid, the reference and the note.
 * Never more than the invoice owed with this payment taken back, never a day
 * still to come; the balance is worked out again on the server, and a payment
 * someone else changed meanwhile is refused rather than overwritten.
 */
export function ChangePaymentDialog({
  payment,
  open,
  onClose,
}: {
  payment: PaymentDetail;
  open: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const today = businessToday();
  const actions = useInvoiceActions();
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(payment.paidOn);
  const [method, setMethod] = useState<PaymentMethod>(payment.method);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  // Filled from the payment each time it opens, as it is now.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  if (open && openedAt !== payment.updatedAt) {
    setOpenedAt(payment.updatedAt);
    setAmount((payment.amountCents / 100).toFixed(2));
    setPaidOn(payment.paidOn);
    setMethod(payment.method);
    setReference(payment.reference ?? '');
    setNote(payment.note ?? '');
  }
  if (!open && openedAt) setOpenedAt(null);

  const owed = owedBeforePayment(payment);
  const amountCents = parseMoney(amount);
  const problem =
    amountCents === null ? 'Give the amount in dollars and cents.' : paymentProblem({ amountCents, paidOn }, owed, today);

  const save = () => {
    if (problem || amountCents === null) return;
    actions.changePayment.mutate(
      {
        paymentId: payment.id,
        input: {
          amountCents,
          paidOn,
          method,
          reference: reference.trim() || null,
          note: note.trim() || null,
          expectedUpdatedAt: payment.updatedAt,
        },
      },
      {
        onSuccess: (saved) => {
          toast.success('Payment changed', {
            description:
              saved.invoiceBalanceCents > 0 ? `${formatMoney(saved.invoiceBalanceCents)} still owed.` : 'The invoice is paid.',
          });
          onClose();
        },
        onError: (error) => toast.error('The payment was not changed', { description: error.message }),
      },
    );
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change the payment</DialogTitle>
          <DialogDescription>
            Up to {formatMoney(owed)}: what the invoice owes with this payment taken back. No card is charged.
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
            <Input id={`${id}-day`} max={today} onChange={(event) => setPaidOn(event.target.value)} type="date" value={paidOn} />
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
              maxLength={120}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Receipt or check number"
              value={reference}
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor={`${id}-note`}>Details (optional)</FieldLabel>
            <Textarea className="min-h-16" id={`${id}-note`} maxLength={1000} onChange={(event) => setNote(event.target.value)} value={note} />
            <FieldDescription aria-live="polite" className={problem ? 'text-destructive' : undefined}>
              {problem ?? 'The invoice’s balance is worked out again, and the change kept on the record with who made it.'}
            </FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={Boolean(problem) || actions.changePayment.isPending} onClick={save}>
            {actions.changePayment.isPending ? 'Saving…' : 'Save the change'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Taking a payment off its invoice, asked once: the invoice owes it again, and
 * the record keeps what it was.
 */
export function RemovePaymentDialog({
  payment,
  open,
  onClose,
  onRemoved,
}: {
  payment: PaymentDetail;
  open: boolean;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const actions = useInvoiceActions();
  const invoice = payment.invoice.number ? `invoice #${payment.invoice.number}` : 'the invoice';
  const remove = () =>
    actions.removePayment.mutate(
      { paymentId: payment.id, expectedUpdatedAt: payment.updatedAt },
      {
        onSuccess: () => {
          toast.success('Payment removed', { description: `${formatMoney(payment.amountCents)} is owed on ${invoice} again.` });
          onRemoved();
        },
        onError: (error) => toast.error('The payment was not removed', { description: error.message }),
      },
    );
  return (
    <AlertDialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this payment?</AlertDialogTitle>
          <AlertDialogDescription>
            {formatMoney(payment.amountCents)} comes off {invoice}, which then owes it again. What the payment was stays on
            the invoice&apos;s record.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={actions.removePayment.isPending}
            onClick={(event) => {
              // Closed by `onRemoved`, once the server agrees, not by the click.
              event.preventDefault();
              remove();
            }}
          >
            {actions.removePayment.isPending ? 'Removing…' : 'Remove payment'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
