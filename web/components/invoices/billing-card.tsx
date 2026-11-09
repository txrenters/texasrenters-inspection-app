'use client';

import {
  MAX_INVOICE_RECIPIENTS,
  STATEMENT_PERIOD_LABEL,
  formatMoney,
  recipientsProblem,
  statementQueryProblem,
  type AccountEntry,
  type PropertyAccount,
  type StatementPeriod,
  type StatementQuery,
} from '@texasrenters/shared';
import { DownloadIcon, FileTextIcon, MailIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { formatInvoiceDay } from '@/components/invoices/invoice-parts';
import { InvoiceDeliveries, typedAddresses } from '@/components/invoices/send-invoice-dialog';
import { AsideCard } from '@/components/record/record-kit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import { newClientRequestId } from '@/lib/invoice-queries';
import { fetchStatement, usePropertyAccount, useSendStatement } from '@/lib/property-account-queries';
import { appliedTo, entryName } from '@/lib/statement-pdf/statement-document';
import { downloadStatement } from '@/lib/statement-pdf/download-statement';
import { cn } from '@/lib/utils';

/**
 * A property's billing history (2026-11-10, phase 3 of the invoice gap
 * review), as Jobber's Billing card on a client: each invoice and payment,
 * newest first, ten at a time, the current balance under it, and a
 * statement -- downloaded, or emailed to the client once the console owns
 * invoicing.
 */

const PAGE = 10;

export function BillingCard({ propertyId }: { propertyId: string }) {
  const { has } = usePermissions();
  const canRead = has('invoices:read');
  const account = usePropertyAccount(propertyId, canRead);
  const [page, setPage] = useState(0);
  const [stating, setStating] = useState(false);
  if (!canRead) return null;
  const data = account.data;
  const pages = Math.max(1, Math.ceil((data?.entries.length ?? 0) / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = data?.entries.slice(current * PAGE, current * PAGE + PAGE) ?? [];

  return (
    <AsideCard
      action={
        data?.entries.length ? (
          <Button onClick={() => setStating(true)} size="sm" variant="outline">
            <FileTextIcon />
            Statement
          </Button>
        ) : undefined
      }
      title="Billing"
    >
      {account.isLoading ? (
        <Skeleton className="h-24" />
      ) : account.isError || !data ? (
        <p className="text-muted-foreground">The billing history could not be read.</p>
      ) : data.entries.length ? (
        <>
          <ul aria-label="Billing history" className="divide-y">
            {shown.map((entry) => (
              <EntryRow entry={entry} key={entry.key} />
            ))}
          </ul>
          {pages > 1 ? (
            <div className="text-muted-foreground mt-2 flex items-center justify-end gap-2 text-xs">
              <span className="tabular-nums">
                {current * PAGE + 1}–{Math.min(data.entries.length, current * PAGE + PAGE)} of {data.entries.length}
              </span>
              <Button aria-label="Newer" disabled={current === 0} onClick={() => setPage(current - 1)} size="sm" variant="ghost">
                ‹
              </Button>
              <Button aria-label="Older" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} size="sm" variant="ghost">
                ›
              </Button>
            </div>
          ) : null}
          <div className="mt-3 flex items-baseline justify-between border-t pt-3">
            <span className="text-muted-foreground">Current balance</span>
            <span className={cn('text-heading text-lg font-bold tabular-nums', data.balanceCents < 0 && 'text-success')}>
              {formatMoney(data.balanceCents)}
            </span>
          </div>
          {data.statements.length ? (
            <details className="mt-3">
              <summary className="text-muted-foreground cursor-pointer text-xs">Statements emailed ({data.statements.length})</summary>
              <div className="mt-2">
                <InvoiceDeliveries deliveries={data.statements} />
              </div>
            </details>
          ) : null}
          <StatementDialog account={data} onClose={() => setStating(false)} open={stating} />
        </>
      ) : (
        <p className="text-muted-foreground">Nothing has been billed yet.</p>
      )}
    </AsideCard>
  );
}

function EntryRow({ entry }: { entry: AccountEntry }) {
  const href = entry.paymentId ? `/payments/${entry.paymentId}` : `/invoices/${entry.invoiceId}`;
  const linked = entry.kind === 'INVOICE' || entry.kind === 'PAYMENT' || entry.kind === 'REFUND';
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        {linked ? (
          <Link className="text-heading font-medium hover:underline" href={href}>
            {entryName(entry)}
          </Link>
        ) : (
          <span className="text-heading font-medium">{entryName(entry)}</span>
        )}
        <p className="text-muted-foreground text-xs">
          {formatInvoiceDay(entry.on)}
          {appliedTo(entry) ? ` · ${appliedTo(entry)}` : ''}
        </p>
      </div>
      <span className={cn('shrink-0 tabular-nums', entry.amountCents < 0 && 'text-success')}>{formatMoney(entry.amountCents)}</span>
    </li>
  );
}

/**
 * Jobber's statement: everything, since the account last stood at nothing,
 * or from a day; downloaded as a PDF, or emailed -- billed -- on the press.
 */
export function StatementDialog({ account, open, onClose }: { account: PropertyAccount; open: boolean; onClose: () => void }) {
  const id = useId();
  const { has } = usePermissions();
  const send = useSendStatement(account.propertyId);
  const [period, setPeriod] = useState<StatementPeriod>('LIFETIME');
  const [from, setFrom] = useState('');
  const [emailing, setEmailing] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [others, setOthers] = useState('');
  const [key, setKey] = useState(newClientRequestId);
  const [downloading, setDownloading] = useState(false);

  // Filled each time it opens.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
    setPeriod('LIFETIME');
    setFrom('');
    setEmailing(false);
    setChosen(account.statementTo);
    setOthers('');
    setKey(newClientRequestId());
  }
  if (!open && opened) setOpened(false);

  const today = businessToday();
  const query: StatementQuery = { period, from: period === 'FROM' ? from : null };
  const periodProblem = statementQueryProblem(query, today);
  const to = [...chosen, ...typedAddresses(others)];
  const toProblem = recipientsProblem(to);
  const mayEmail = account.writesEnabled && has('invoices:manage');

  const download = async () => {
    setDownloading(true);
    try {
      await downloadStatement(await fetchStatement(account.propertyId, query));
    } catch (error) {
      toast.error('The statement could not be made', { description: error instanceof Error ? error.message : 'Try again in a moment.' });
    } finally {
      setDownloading(false);
    }
  };

  const submit = () => {
    if (periodProblem || toProblem || send.isPending) return;
    send.mutate(
      { ...query, to, clientRequestId: key },
      {
        onSuccess: (sent) => {
          toast.success(to.length > 1 ? `Statement emailed to ${to.length} people` : `Statement emailed to ${to[0]}`, {
            description: sent.statements[0]?.failure ?? undefined,
          });
          onClose();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status > 0) setKey(newClientRequestId());
          toast.error('The statement was not emailed', { description: error.message });
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
          <DialogTitle>Statement</DialogTitle>
          <DialogDescription>
            {account.clientName}: {formatMoney(account.balanceCents)} {account.balanceCents < 0 ? 'in credit' : 'owed'} today.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">What it covers</legend>
          {(Object.keys(STATEMENT_PERIOD_LABEL) as StatementPeriod[]).map((value) => (
            <label className="flex items-center gap-2 text-sm" key={value}>
              <input
                checked={period === value}
                className="accent-primary size-4"
                name={`${id}-period`}
                onChange={() => setPeriod(value)}
                type="radio"
                value={value}
              />
              {STATEMENT_PERIOD_LABEL[value]}
            </label>
          ))}
          {period === 'FROM' ? (
            <Input
              aria-label="Starts on"
              className="ml-6 w-auto"
              max={today}
              onChange={(event) => setFrom(event.target.value)}
              type="date"
              value={from}
            />
          ) : null}
          {periodProblem && (period !== 'FROM' || from) ? <p className="text-destructive text-xs">{periodProblem}</p> : null}
        </fieldset>

        {emailing ? (
          <>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Send to</legend>
              {account.statementTo.length ? (
                account.statementTo.map((address, index) => (
                  <div className="flex items-center gap-2" key={address}>
                    <Checkbox checked={chosen.includes(address)} id={`${id}-to-${index}`} onCheckedChange={(value) => toggle(address, value === true)} />
                    <Label className="font-normal break-all" htmlFor={`${id}-to-${index}`}>
                      {address}
                    </Label>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-sm">There is no email address for this client. Type one in.</p>
              )}
            </fieldset>
            <Field>
              <FieldLabel htmlFor={`${id}-others`}>{account.statementTo.length ? 'Also send to (optional)' : 'Email addresses'}</FieldLabel>
              <Input
                autoComplete="off"
                id={`${id}-others`}
                inputMode="email"
                onChange={(event) => setOthers(event.target.value)}
                placeholder="name@example.com"
                value={others}
              />
              <FieldDescription aria-live="polite" className={toProblem && to.length ? 'text-destructive' : undefined}>
                {toProblem && to.length ? toProblem : `The statement is written into the email. Up to ${MAX_INVOICE_RECIPIENTS} people.`}
              </FieldDescription>
            </Field>
          </>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button disabled={Boolean(periodProblem) || downloading} onClick={() => void download()} variant="outline">
            <DownloadIcon />
            {downloading ? 'Making the PDF…' : 'Download PDF'}
          </Button>
          {mayEmail ? (
            emailing ? (
              <Button disabled={Boolean(periodProblem) || Boolean(toProblem) || send.isPending} onClick={submit}>
                <MailIcon />
                {send.isPending ? 'Sending…' : to.length > 1 ? `Email ${to.length} people` : 'Send statement'}
              </Button>
            ) : (
              <Button onClick={() => setEmailing(true)}>
                <MailIcon />
                Email to client
              </Button>
            )
          ) : null}
        </DialogFooter>
        {!account.writesEnabled ? (
          <p className="text-muted-foreground text-xs">Statements are emailed from Jobber until the console takes over invoicing.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
