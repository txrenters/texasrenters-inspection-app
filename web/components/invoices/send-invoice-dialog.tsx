'use client';

import {
  MAX_INVOICE_RECIPIENTS,
  formatMoney,
  overdueWords,
  recipientsProblem,
  type InvoiceDeliveryKind,
  type InvoiceDeliveryView,
  type InvoiceDetail,
  MAX_ATTACHED_PDF_BYTES,
  fillTemplate,
  invoiceTemplateValues,
  type InvoiceEmailAttachment,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceDay, formatInvoiceMoment } from '@/components/invoices/invoice-parts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useInvoiceEdits } from '@/lib/invoice-edit-queries';
import { newClientRequestId } from '@/lib/invoice-queries';
import { useSendInvoice } from '@/lib/invoice-delivery-queries';
import { invoiceFileName, invoicePdf, previewInvoice } from '@/lib/invoice-pdf/download-invoice';
import { useEmailTemplates } from '@/lib/invoice-record-queries';

/**
 * Emailing an invoice to the client (2026-11-06, phase 5), as Jobber's "Send
 * invoice": who it goes to -- the client's addresses Jobber keeps, ticked, and
 * any others typed in -- and a note above it. The invoice itself is written
 * into the email: who it is for, each line, the totals and what is due.
 *
 * Each email is billed, so it goes only on the press, to five people at most,
 * and one key per press: a resend of a press that got no answer sends nothing
 * twice, and pressing again after an answer is a new send. A draft is marked
 * sent first, as Jobber does when it sends one.
 */

/** Addresses typed in, split on commas, semicolons, spaces or new lines. */
export const typedAddresses = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((address) => address.trim())
    .filter(Boolean);

/** "invoice #8439", or "the invoice" before it has a number. */
const whichInvoice = (invoice: InvoiceDetail) => (invoice.number ? `invoice #${invoice.number}` : 'the invoice');

/** The note it opens with, which the office can change. */
export function defaultInvoiceNote(invoice: InvoiceDetail) {
  const due = invoice.dueOn ? ` by ${formatInvoiceDay(invoice.dueOn)}` : '';
  return `Hello,\n\nHere is ${whichInvoice(invoice)} for ${invoice.clientName}: ${formatMoney(invoice.balanceCents)} is due${due}.\n\nThank you.`;
}

/** The office's invoice note filled for this invoice; the console's own while there is none, or no number yet. */
export function templateNote(invoice: InvoiceDetail, template: string | undefined) {
  if (!template || !invoice.number) return defaultInvoiceNote(invoice);
  return fillTemplate(template, invoiceTemplateValues(invoice, invoice.brand?.name ?? 'TexasRenters.com'));
}

/** The invoice's PDF as an attachment: base64, refused when too large to ride on an email. */
export async function invoiceAttachment(invoice: InvoiceDetail): Promise<InvoiceEmailAttachment> {
  const blob = await invoicePdf(invoice);
  if (blob.size > MAX_ATTACHED_PDF_BYTES) throw new Error('The PDF is too large to attach. Send it without.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return { fileName: invoiceFileName(invoice), contentBase64: btoa(binary) };
}

export function SendInvoiceDialog({ invoice, open, onClose }: { invoice: InvoiceDetail; open: boolean; onClose: () => void }) {
  const id = useId();
  const send = useSendInvoice();
  const edits = useInvoiceEdits();
  const known = invoice.details?.clientEmails ?? [];
  const [chosen, setChosen] = useState<string[]>([]);
  const [others, setOthers] = useState('');
  // The office's words (2026-11-10), until somebody types their own.
  const words = useEmailTemplates(open);
  const [typed, setTyped] = useState<string | null>(null);
  const message = typed ?? templateNote(invoice, words.data?.templates.invoice.message);
  const [attach, setAttach] = useState(true);
  const [key, setKey] = useState(newClientRequestId);
  const [previewing, setPreviewing] = useState(false);
  const [making, setMaking] = useState(false);

  // Filled each time it opens: the client's first address ticked, the usual note, a new key.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (open && openedFor !== invoice.id) {
    setOpenedFor(invoice.id);
    setChosen(known.slice(0, 1));
    setOthers('');
    setTyped(null);
    setAttach(true);
    setKey(newClientRequestId());
  }
  if (!open && openedFor) setOpenedFor(null);

  const to = [...chosen, ...typedAddresses(others)];
  const problem = recipientsProblem(to);
  const draft = invoice.status === 'DRAFT';
  const busy = send.isPending || edits.changeStatus.isPending || making;

  const sendNow = async (current: InvoiceDetail) => {
    // The PDF the client gets, made from the invoice as it now stands (numbered, for a draft just sent).
    let attachment: InvoiceEmailAttachment | null = null;
    if (attach) {
      setMaking(true);
      try {
        attachment = await invoiceAttachment(current);
      } catch (error) {
        setMaking(false);
        return void toast.error('The PDF could not be attached, and nothing was emailed', {
          description: error instanceof Error ? error.message : 'Try again, or send it without the PDF.',
        });
      }
      setMaking(false);
    }
    // An empty note is somebody choosing none: sent as written, never filled in by the server.
    send.mutate(
      { id: current.id, input: { to, message, clientRequestId: key, attachment } },
      {
        onSuccess: (sent) => {
          const delivery = sent.deliveries?.[0];
          toast.success(to.length > 1 ? `Emailed to ${to.length} people` : `Emailed to ${to[0]}`, {
            description: delivery?.failure ?? undefined,
          });
          onClose();
        },
        onError: (error) => {
          // The server answered, so this press is over: pressing again is a new send.
          if (error instanceof ApiError && error.status > 0) setKey(newClientRequestId());
          toast.error('The invoice was not emailed', { description: error.message });
        },
      },
    );
  };

  const submit = () => {
    if (problem || busy) return;
    if (!draft) return void sendNow(invoice);
    if (!invoice.updatedAt) return;
    edits.changeStatus.mutate(
      { id: invoice.id, input: { action: 'MARK_SENT', expectedUpdatedAt: invoice.updatedAt } },
      {
        onSuccess: (sent) => void sendNow(sent),
        onError: (error) => toast.error('The draft was not marked sent, and nothing was emailed', { description: error.message }),
      },
    );
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await previewInvoice(invoice);
    } catch {
      toast.error('The PDF could not be made', { description: 'Try again in a moment.' });
    } finally {
      setPreviewing(false);
    }
  };

  const toggle = (address: string, on: boolean) =>
    setChosen((current) => (on ? [...current, address] : current.filter((item) => item !== address)));

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email {whichInvoice(invoice)}</DialogTitle>
          <DialogDescription>
            To {invoice.clientName}: {formatMoney(invoice.balanceCents)} due
            {invoice.dueOn ? ` ${formatInvoiceDay(invoice.dueOn)}` : ''}. The invoice is written into the email, one to each
            person.{draft ? ' The draft is marked sent first.' : ''}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Send to</legend>
          {known.length ? (
            known.map((address, index) => (
              <div className="flex items-center gap-2" key={address}>
                <Checkbox
                  checked={chosen.includes(address)}
                  id={`${id}-known-${index}`}
                  onCheckedChange={(value) => toggle(address, value === true)}
                />
                <Label className="font-normal break-all" htmlFor={`${id}-known-${index}`}>
                  {address}
                  {index === 0 ? <span className="text-muted-foreground"> · primary</span> : null}
                </Label>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground text-sm">Jobber has no email address for this client. Type one in.</p>
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
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-message`}>Message</FieldLabel>
          <Textarea
            className="min-h-28"
            id={`${id}-message`}
            maxLength={2000}
            onChange={(event) => setTyped(event.target.value)}
            value={message}
          />
          <FieldDescription aria-live="polite" className={problem && to.length ? 'text-destructive' : undefined}>
            {problem && to.length ? problem : `Above the invoice. Up to ${MAX_INVOICE_RECIPIENTS} people at a time.`}
          </FieldDescription>
        </Field>

        <div className="flex items-center gap-2">
          <Checkbox checked={attach} id={`${id}-attach`} onCheckedChange={(value) => setAttach(value === true)} />
          <Label className="font-normal" htmlFor={`${id}-attach`}>
            Attach the invoice as a PDF
          </Label>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button disabled={previewing} onClick={() => void preview()} variant="ghost">
            {previewing ? 'Making the PDF…' : 'Look at the PDF'}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button onClick={onClose} variant="secondary">
              Cancel
            </Button>
            <Button disabled={Boolean(problem) || busy} onClick={submit}>
              {making ? 'Making the PDF…' : busy ? 'Sending…' : draft ? 'Mark sent and email' : to.length > 1 ? `Email ${to.length} people` : 'Send email'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const DELIVERY_STATUS: Record<InvoiceDeliveryKind, Record<InvoiceDeliveryView['status'], string>> = {
  INVOICE: { PENDING: 'Sending', SENT: 'Emailed', FAILED: 'Not sent' },
  FOLLOW_UP: { PENDING: 'Sending a follow-up', SENT: 'Follow-up emailed', FAILED: 'Follow-up not sent' },
  RECEIPT: { PENDING: 'Sending a receipt', SENT: 'Receipt emailed', FAILED: 'Receipt not sent' },
  STATEMENT: { PENDING: 'Sending a statement', SENT: 'Statement emailed', FAILED: 'Statement not sent' },
};

/** What it was and who sent it: "Office", or for a follow-up "4 days overdue · sent by itself". */
function deliveryBy(delivery: InvoiceDeliveryView) {
  const who = delivery.sentBy?.displayName ?? (delivery.kind === 'INVOICE' ? null : 'sent by itself');
  const late = delivery.kind === 'FOLLOW_UP' && delivery.followUpDay !== null ? overdueWords(delivery.followUpDay) : null;
  return [late, who].filter(Boolean).join(' · ');
}

/**
 * Each email from the console about it, newest first: the invoice itself, a
 * follow-up about paying it, or a receipt (2026-11-09) -- to whom, when, by
 * whom, and why one did not go.
 */
export function InvoiceDeliveries({ deliveries }: { deliveries: readonly InvoiceDeliveryView[] }) {
  return (
    <ol className="grid gap-2.5 text-sm">
      {deliveries.map((delivery) => (
        <li key={delivery.id}>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className={delivery.status === 'FAILED' ? 'text-destructive font-semibold' : 'text-heading font-semibold'}>
              {DELIVERY_STATUS[delivery.kind ?? 'INVOICE'][delivery.status]}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatInvoiceMoment(delivery.sentAt ?? delivery.createdAt)}
              {deliveryBy(delivery) ? ` · ${deliveryBy(delivery)}` : ''}
            </span>
          </p>
          <p className="text-muted-foreground text-xs break-all">{delivery.recipients.join(', ')}</p>
          {delivery.failure ? <p className="text-muted-foreground text-xs">{delivery.failure}</p> : null}
        </li>
      ))}
    </ol>
  );
}
