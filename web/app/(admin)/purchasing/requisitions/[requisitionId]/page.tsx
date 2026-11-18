'use client';

import { formatMoney, type RequisitionDetail, type RequisitionLine, type RequisitionQuote } from '@texasrenters/shared';
import { ClipboardListIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { RequisitionForm, StockFigure } from '@/components/purchasing/requisition-form';
import { RequisitionStatusBadge, RequisitionSteps, approverFor } from '@/components/purchasing/requisition-parts';
import { AsideCard, FactTable } from '@/components/record/record-kit';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { EMPTY, formatCount, formatDateTime, formatDay } from '@/lib/format';
import { usePurchasingEdits, useRequisition, useRequisitionChoices, type RequisitionStep } from '@/lib/purchasing-queries';

/**
 * One purchase requisition (2026-11-19, phase 2). Its author sees the form
 * while it is a draft or has been sent back; everybody else, and its author
 * once it is submitted, sees it as it stands, with what they may do about it.
 * Every button here is drawn from what the server says this person may do.
 */

const LINE_COLUMNS: Array<Column<RequisitionLine>> = [
  {
    key: 'item',
    header: 'Item',
    primary: true,
    cell: (line) => (
      <span className="grid gap-0.5">
        <span className="font-medium">{line.item?.name ?? line.description}</span>
        <span className="text-muted-foreground text-xs">{line.item ? `${line.item.code} · ${line.item.unit}` : 'Not in the inventory yet'}</span>
      </span>
    ),
  },
  { key: 'onHand', header: 'On hand now', numeric: true, cell: (line) => (line.onHand === null ? EMPTY : <StockFigure onHand={line.onHand} reorderLevel={line.reorderLevel ?? 0} />) },
  { key: 'reorder', header: 'Reorder at', numeric: true, hideBelow: 'md', cell: (line) => (line.reorderLevel ? formatCount(line.reorderLevel) : EMPTY) },
  { key: 'quantity', header: 'Asking for', numeric: true, cell: (line) => formatCount(line.quantity) },
  { key: 'each', header: 'Est. each', numeric: true, hideBelow: 'sm', cell: (line) => formatMoney(line.estimatedUnitCostCents) },
  { key: 'total', header: 'Est. total', numeric: true, cell: (line) => formatMoney(line.quantity * line.estimatedUnitCostCents) },
];

const QUOTE_COLUMNS: Array<Column<RequisitionQuote>> = [
  { key: 'vendor', header: 'Vendor', primary: true, cell: (quote) => <span className="font-medium">{quote.vendor.name}</span> },
  { key: 'total', header: 'Total', numeric: true, cell: (quote) => formatMoney(quote.totalCents) },
  { key: 'delivery', header: 'Delivery', cell: (quote) => quote.delivery ?? EMPTY },
  { key: 'chosen', header: 'Chosen', cell: (quote) => (quote.chosen ? <Badge variant="success">Chosen</Badge> : '') },
];

export default function RequisitionPage() {
  const { requisitionId } = useParams<{ requisitionId: string }>();
  const requisition = useRequisition(requisitionId);
  const editing = Boolean(requisition.data?.can.edit);
  const choices = useRequisitionChoices(editing);
  const edits = usePurchasingEdits();

  if (requisition.isLoading || (editing && choices.isLoading)) return <PageSkeleton />;
  if (requisition.isError || !requisition.data) return <ErrorState error={requisition.error} retry={() => void requisition.refetch()} />;
  if (editing && (choices.isError || !choices.data)) return <ErrorState error={choices.error} retry={() => void choices.refetch()} />;

  const data = requisition.data;
  const act = (step: RequisitionStep, note?: string) => edits.step.mutateAsync({ requisitionId, step, input: note ? { note } : {} });

  return (
    <>
      <PageHeader
        badges={<RequisitionStatusBadge status={data.status} />}
        className="mb-3"
        description={
          <>
            <Link className="underline-offset-4 hover:underline" href="/purchasing">
              Purchasing
            </Link>
            {` · Asked by ${data.requestedBy.name} on ${formatDay(data.submittedAt ?? data.createdAt)} · ${data.company?.name ?? 'No company'}${data.neededBy ? ` · needed by ${formatDay(data.neededBy)}` : ''}`}
          </>
        }
        prominent
        record={{ icon: ClipboardListIcon, tone: 'text-info', label: 'Purchase requisition' }}
        title={data.number ? `Purchase requisition ${data.number}` : 'Purchase requisition, draft'}
      />
      <div className="mb-6">
        <RequisitionSteps status={data.status} />
      </div>

      {data.status === 'SENT_BACK' || data.status === 'REJECTED' ? (
        <Alert className="mb-6" variant={data.status === 'REJECTED' ? 'destructive' : 'warning'}>
          <AlertDescription>
            {data.decidedBy ?? 'The approver'} {data.status === 'REJECTED' ? 'rejected it' : 'sent it back'}: “{data.decisionNote}”
          </AlertDescription>
        </Alert>
      ) : null}

      {editing && choices.data ? (
        <RequisitionForm
          choices={choices.data}
          discardLabel="Cancel this requisition"
          error={edits.update.error ?? edits.step.error}
          key={data.id}
          onDiscard={() => void act('cancel').catch(() => undefined)}
          onSave={async (input, submit) => {
            await edits.update.mutateAsync({ requisitionId, input });
            if (submit) await act('submit');
          }}
          pending={edits.update.isPending || edits.step.isPending}
          requisition={data}
        />
      ) : (
        <RequisitionView act={act} data={data} error={edits.step.error} pending={edits.step.isPending} />
      )}
    </>
  );
}

function RequisitionView({
  data,
  act,
  pending,
  error,
}: {
  data: RequisitionDetail;
  act: (step: RequisitionStep, note?: string) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
}) {
  const [note, setNote] = useState('');
  const deciding = data.can.approve || data.can.sendBack || data.can.reject || Boolean(data.can.approveBlocked);
  const run = (step: RequisitionStep) => void act(step, note.trim() || undefined).catch(() => undefined);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 gap-6">
        <AsideCard title="Why it is needed">
          <p className="whitespace-pre-wrap">{data.reason || 'No reason given yet.'}</p>
          {data.deliverTo ? <p className="text-muted-foreground mt-2 text-xs">Deliver to {data.deliverTo.name}.</p> : null}
        </AsideCard>

        <section className="grid gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-heading text-base font-bold">What is asked for</h2>
            <p className="text-sm font-semibold">Estimated total {formatMoney(data.estimatedTotalCents)}</p>
          </div>
          <DataTable columns={LINE_COLUMNS} label="What is asked for" rowKey={(line) => line.id} rows={data.lines} />
        </section>

        <section className="grid gap-3">
          <h2 className="text-heading text-base font-bold">Quotes</h2>
          {data.quotes.length ? (
            <DataTable columns={QUOTE_COLUMNS} label="Quotes" rowKey={(quote) => quote.id} rows={data.quotes} />
          ) : (
            <p className="text-muted-foreground text-sm">None recorded.</p>
          )}
        </section>
      </div>

      <aside className="grid gap-4">
        {deciding ? (
          <AsideCard title="Your decision">
            <p className="text-muted-foreground text-xs">
              {data.can.approveBlocked ??
                `${formatMoney(data.estimatedTotalCents)} against a ${formatMoney(data.settings.approvalLimitCents)} approval limit. Approving buys nothing: it lets this become an order.`}
            </p>
            {data.can.sendBack || data.can.reject ? (
              <Field className="mt-3">
                <FieldLabel htmlFor="decision-note">Note to {data.requestedBy.name}</FieldLabel>
                <Textarea id="decision-note" maxLength={1000} onChange={(event) => setNote(event.target.value)} rows={3} value={note} />
                <FieldDescription>Needed to send it back or reject it.</FieldDescription>
              </Field>
            ) : null}
            {error ? (
              <Alert className="mt-3" variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="mt-4 grid gap-2">
              {data.can.approve ? (
                <Button disabled={pending} onClick={() => run('approve')}>
                  Approve
                </Button>
              ) : null}
              {data.can.sendBack ? (
                <Button disabled={pending || !note.trim()} onClick={() => run('send-back')} variant="outline">
                  Send back with the note
                </Button>
              ) : null}
              {data.can.reject ? (
                <Button className="text-destructive" disabled={pending || !note.trim()} onClick={() => run('reject')} variant="outline">
                  Reject
                </Button>
              ) : null}
            </div>
          </AsideCard>
        ) : null}

        <AsideCard title="Where it stands">
          <FactTable
            facts={[
              { label: 'Estimated total', value: formatMoney(data.estimatedTotalCents) },
              ...(data.status === 'SUBMITTED' ? [{ label: 'Waiting on', value: approverFor(data.estimatedTotalCents, data.settings) }] : []),
              ...(data.decidedBy && data.status !== 'SUBMITTED' ? [{ label: 'Decided by', value: data.decidedBy, detail: data.decidedAt ? formatDateTime(data.decidedAt) : undefined }] : []),
              ...(data.status === 'APPROVED' ? [{ label: 'Next', value: 'A purchase order', detail: 'Orders are not in the console yet.' }] : []),
            ]}
            label="Where it stands"
          />
          {data.can.cancel ? (
            <>
              {!deciding && error ? (
                <Alert className="mt-3" variant="destructive">
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              ) : null}
              <Button className="mt-4 w-full" disabled={pending} onClick={() => run('cancel')} variant="outline">
                Cancel this requisition
              </Button>
            </>
          ) : null}
        </AsideCard>

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
      </aside>
    </div>
  );
}
