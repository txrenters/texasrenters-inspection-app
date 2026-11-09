'use client';

import { MAX_INVOICE_RECIPIENTS, PAYMENT_METHOD_LABEL, formatMoney, recipientsProblem, type PaymentDetail } from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { typedAddresses } from '@/components/invoices/send-invoice-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { useSendReceipt } from '@/lib/invoice-delivery-queries';
import { newClientRequestId } from '@/lib/invoice-queries';

/**
 * Emailing a payment's receipt (2026-11-09), as Jobber's "Send receipt": the
 * payment, what it went to and what is still owed, written into the email in
 * Jobber's words. To whoever the invoice was last emailed to, else the
 * client's addresses, ticked; any others typed in. Billed, so only on the
 * press, with one key per press.
 */
export function SendReceiptDialog({ payment, open, onClose }: { payment: PaymentDetail; open: boolean; onClose: () => void }) {
  const id = useId();
  const send = useSendReceipt();
  const known = payment.receiptTo ?? [];
  const [chosen, setChosen] = useState<string[]>([]);
  const [others, setOthers] = useState('');
  const [key, setKey] = useState(newClientRequestId);

  // Filled each time it opens: every usual address ticked, a new key.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
    setChosen(known);
    setOthers('');
    setKey(newClientRequestId());
  }
  if (!open && opened) setOpened(false);

  const to = [...chosen, ...typedAddresses(others)];
  const problem = recipientsProblem(to);

  const submit = () => {
    if (problem || send.isPending) return;
    send.mutate(
      { paymentId: payment.id, input: { to, clientRequestId: key } },
      {
        onSuccess: (sent) => {
          const receipt = sent.receipts?.[0];
          if (receipt?.status === 'FAILED') toast.error('The receipt was not emailed', { description: receipt.failure ?? undefined });
          else
            toast.success(to.length > 1 ? `Receipt emailed to ${to.length} people` : `Receipt emailed to ${to[0]}`, {
              description: receipt?.failure ?? undefined,
            });
          onClose();
        },
        onError: (error) => {
          // The server answered, so this press is over: pressing again is a new send.
          if (error instanceof ApiError && error.status > 0) setKey(newClientRequestId());
          toast.error('The receipt was not emailed', { description: error.message });
        },
      },
    );
  };

  const toggle = (address: string, on: boolean) =>
    setChosen((current) => (on ? [...current, address] : current.filter((item) => item !== address)));

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email the receipt</DialogTitle>
          <DialogDescription>
            {formatMoney(payment.amountCents)} by {PAYMENT_METHOD_LABEL[payment.method].toLowerCase()} on {formatInvoiceDay(payment.paidOn)}, for{' '}
            {payment.invoice.clientName}. The receipt is written into the email, one to each person.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Send to</legend>
          {known.length ? (
            known.map((address, index) => (
              <div className="flex items-center gap-2" key={address}>
                <Checkbox checked={chosen.includes(address)} id={`${id}-known-${index}`} onCheckedChange={(value) => toggle(address, value === true)} />
                <Label className="font-normal break-all" htmlFor={`${id}-known-${index}`}>
                  {address}
                </Label>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">There is no email address for this client. Type one in.</p>
          )}
        </fieldset>
        <Field>
          <FieldLabel htmlFor={`${id}-others`}>{known.length ? 'Also send to (optional)' : 'Email addresses'}</FieldLabel>
          <Input
            autoComplete="off"
            id={`${id}-others`}
            inputMode="email"
            onChange={(event) => setOthers(event.target.value)}
            placeholder="name@example.com, another@example.com"
            value={others}
          />
          <FieldDescription aria-live="polite" className={problem && to.length ? 'text-destructive' : undefined}>
            {problem && to.length ? problem : `Up to ${MAX_INVOICE_RECIPIENTS} people at a time.`}
          </FieldDescription>
        </Field>

        <DialogFooter>
          <Button onClick={onClose} variant="secondary">
            Cancel
          </Button>
          <Button disabled={Boolean(problem) || send.isPending} onClick={submit}>
            {send.isPending ? 'Sending…' : to.length > 1 ? `Email ${to.length} people` : 'Send receipt'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
