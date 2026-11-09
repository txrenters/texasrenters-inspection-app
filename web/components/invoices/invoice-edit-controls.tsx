'use client';

import {
  INVOICE_STATUS_ACTION_LABEL,
  canDeleteInvoice,
  formatMoney,
  invoiceStatusActions,
  isEditableInvoiceStatus,
  type InvoiceDetail,
  type InvoiceStatusAction,
} from '@texasrenters/shared';
import { EllipsisIcon, PencilIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatInvoiceMoment } from '@/components/invoices/invoice-parts';
import { useInvoiceEdits, useInvoiceHistory } from '@/lib/invoice-edit-queries';

/**
 * Editing an invoice from its page (2026-11-06, phase 3), as Jobber's invoice
 * offers it: Edit, and a More menu to mark a draft sent, void it, close it as
 * bad debt, reopen it, or delete a draft. Each asks once, says what it does,
 * and is sent against the invoice as it was read. Shown only to whoever makes
 * invoices, and only once the console owns invoicing.
 */

type Choice = InvoiceStatusAction | 'DELETE';

const DONE: Record<InvoiceStatusAction, string> = {
  MARK_SENT: 'Marked as sent',
  VOID: 'Invoice voided',
  BAD_DEBT: 'Closed as bad debt',
  REOPEN: 'Invoice reopened',
};

/** What each choice does, in the words the confirmation asks with. */
function consequence(choice: Choice, invoice: InvoiceDetail) {
  const owed = formatMoney(invoice.balanceCents);
  switch (choice) {
    case 'MARK_SENT':
      return `It is owed from now: ${formatMoney(invoice.totalCents - (invoice.paidCents ?? 0))}.`;
    case 'VOID':
      return 'It owes nothing, and stays on the record as voided. It can be reopened.';
    case 'BAD_DEBT':
      return `The ${owed} still owed is written off. It can be reopened.`;
    case 'REOPEN':
      return 'It is owed again: its total less what has been paid.';
    case 'DELETE':
      return 'The draft is gone. What it was stays on the record.';
  }
}

export function InvoiceEditControls({ invoice }: { invoice: InvoiceDetail }) {
  const router = useRouter();
  const edits = useInvoiceEdits();
  const [asking, setAsking] = useState<Choice | null>(null);
  const paidCents = invoice.paidCents ?? 0;
  const actions = invoiceStatusActions({ status: invoice.status, balanceCents: invoice.balanceCents, paidCents });
  const deletable = canDeleteInvoice({ status: invoice.status, paidCents });
  const busy = edits.changeStatus.isPending || edits.remove.isPending;

  const confirm = () => {
    if (!asking || !invoice.updatedAt) return;
    const done = (title: string) => () => {
      toast.success(title);
      setAsking(null);
    };
    const failed = (error: Error) => toast.error('Nothing was changed', { description: error.message });
    if (asking === 'DELETE')
      edits.remove.mutate(
        { id: invoice.id, expectedUpdatedAt: invoice.updatedAt },
        {
          onSuccess: () => {
            toast.success('Draft deleted');
            setAsking(null);
            router.push('/invoices');
          },
          onError: failed,
        },
      );
    else
      edits.changeStatus.mutate(
        { id: invoice.id, input: { action: asking, expectedUpdatedAt: invoice.updatedAt } },
        { onSuccess: done(DONE[asking]), onError: failed },
      );
  };

  return (
    <>
      {isEditableInvoiceStatus(invoice.status) ? (
        <Button asChild size="sm" variant="outline">
          <Link href={`/invoices/${invoice.id}/edit`}>
            <PencilIcon />
            Edit
          </Link>
        </Button>
      ) : null}
      {/* Create similar (2026-11-10) is always on offer, so More always is. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-label="More" size="sm" variant="outline">
            <EllipsisIcon />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href={`/invoices/new?similar=${encodeURIComponent(invoice.id)}`}>Create similar</Link>
          </DropdownMenuItem>
          {actions.length || deletable ? <DropdownMenuSeparator /> : null}
          {actions.map((action) => (
            <DropdownMenuItem key={action} onSelect={() => setAsking(action)}>
              {INVOICE_STATUS_ACTION_LABEL[action]}
            </DropdownMenuItem>
          ))}
          {deletable ? (
            <>
              {actions.length ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem className="text-destructive" onSelect={() => setAsking('DELETE')}>
                Delete draft
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog onOpenChange={(open) => (open ? undefined : setAsking(null))} open={asking !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking === 'DELETE' ? 'Delete this draft?' : asking ? `${INVOICE_STATUS_ACTION_LABEL[asking]}?` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>{asking ? consequence(asking, invoice) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it as it is</AlertDialogCancel>
            <AlertDialogAction
              className={asking === 'DELETE' || asking === 'VOID' || asking === 'BAD_DEBT' ? buttonVariants({ variant: 'destructive' }) : undefined}
              disabled={busy}
              onClick={(event) => {
                // Closed once the server agrees, not by the click.
                event.preventDefault();
                confirm();
              }}
            >
              {busy ? 'Working…' : asking === 'DELETE' ? 'Delete draft' : asking ? INVOICE_STATUS_ACTION_LABEL[asking] : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What happened to the invoice in the console, newest first, and who did it. */
export function InvoiceHistorySection({ invoiceId }: { invoiceId: string }) {
  const history = useInvoiceHistory(invoiceId);
  const items = history.data?.items ?? [];
  return (
    <section aria-label="History" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">History</h2>
      {history.isLoading ? (
        <p className="text-muted-foreground mt-2 text-sm">Loading…</p>
      ) : history.isError ? (
        <p className="text-muted-foreground mt-2 text-sm">The history could not be read.</p>
      ) : items.length ? (
        <ol className="mt-2 divide-y">
          {items.map((event) => (
            <li className="py-2.5 text-sm" key={event.id}>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-heading font-semibold">{event.title}</span>
                <span className="text-muted-foreground text-xs">
                  {formatInvoiceMoment(event.at)}
                  {event.actor ? ` · ${event.actor.displayName}` : ''}
                </span>
              </p>
              {event.lines.length ? (
                <ul className="text-muted-foreground mt-1 grid gap-0.5 text-xs">
                  {event.lines.map((line, index) => (
                    <li className="break-words" key={`${index}:${line}`}>
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground mt-2 text-sm">
          Nothing has been changed here yet. Jobber keeps no history the console can read, so it starts with the first change made in the console.
        </p>
      )}
      {history.data?.truncated ? <p className="text-muted-foreground mt-2 text-xs">Older changes are not listed.</p> : null}
    </section>
  );
}
