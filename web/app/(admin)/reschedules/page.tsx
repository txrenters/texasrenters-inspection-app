'use client';

import {
  RESCHEDULE_KIND_LABEL,
  VISIT_SERVICE_LABEL,
  type RescheduleRequestFilter,
  type RescheduleRequestList,
  type RescheduleRequestView,
} from '@texasrenters/shared';
import { CalendarCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { INSPECTION_TYPE_CHILDREN } from '@/lib/admin-navigation';
import { usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import { formatRelative, formatScheduledDate, humanize } from '@/lib/format';
import { useTechnicians } from '@/lib/queries';
import {
  useBookAgainRescheduleRequest,
  useDismissRescheduleRequest,
  useMoveRescheduleRequest,
  useRescheduleRequests,
} from '@/lib/reschedule-queries';

/**
 * The visits to book again (2026-10-21).
 *
 * A technician's "book it again" used to be a line in the Jobber note and a
 * warning on one inspection's page: nothing listed them, and nothing said
 * whether one was ever booked. This is the list, oldest first, and the
 * office's three answers -- each of which reaches Jobber.
 */

/** "Occupied", "HVAC": a type as the navigation names it. */
function typeName(type: string) {
  return INSPECTION_TYPE_CHILDREN.find((child) => child.type === type)?.title ?? humanize(type);
}

/** What is asked for: the services still to do, or the visit itself -- with what it carried. */
function asked(request: RescheduleRequestView) {
  if (request.kind === 'BEFORE_VISIT') return 'Another day';
  const services = request.services.map((service) => VISIT_SERVICE_LABEL[service]);
  if (request.kind === 'SERVICES_NOT_DONE' && services.length) return services.join(', ');
  const visit = `The whole ${typeName(request.inspection.inspectionType).toLowerCase()} visit`;
  return services.length ? `${visit}, with ${services.join(' and ').toLowerCase().replace('ac ', 'AC ')}` : visit;
}

/** Where the request stands, in a word and a line. */
function standing(request: RescheduleRequestView): {
  label: string;
  variant: 'secondary' | 'success' | 'warning' | 'destructive' | 'info';
  detail?: string | null;
} {
  switch (request.status) {
    case 'OPEN':
      return request.jobberError
        ? { label: 'Jobber refused', variant: 'destructive', detail: request.jobberError }
        : { label: 'Waiting', variant: 'warning' };
    case 'SENDING':
      return { label: 'Sending to Jobber', variant: 'info' };
    case 'DISMISSED':
      return { label: 'Dismissed', variant: 'secondary', detail: request.dismissReason };
    case 'DONE': {
      const where = request.resolvedInJobber ? ' in Jobber' : '';
      return request.outcome === 'MOVED'
        ? { label: `Moved${where}`, variant: 'success', detail: `Now ${formatScheduledDate(request.inspection.scheduledOn)}` }
        : {
            label: `Booked again${where}`,
            variant: 'success',
            detail: request.rebook ? `For ${formatScheduledDate(request.rebook.scheduledOn)}` : null,
          };
    }
  }
}

const columns: Array<Column<RescheduleRequestView>> = [
  {
    key: 'property',
    header: 'Property',
    primary: true,
    cell: (request) => (
      <div className="grid min-w-36">
        <span className="font-medium text-pretty">{request.inspection.address ?? 'An address not on file'}</span>
        <span className="text-muted-foreground text-xs">
          {[typeName(request.inspection.inspectionType), request.inspection.city].filter(Boolean).join(' · ')}
        </span>
      </div>
    ),
  },
  {
    key: 'asked',
    header: 'Asked',
    className: 'max-w-sm',
    cell: (request) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{asked(request)}</span>
        <span className="text-muted-foreground text-xs text-pretty">{request.reason}</span>
      </div>
    ),
  },
  {
    key: 'why',
    header: 'From',
    hideBelow: 'md',
    cell: (request) => (
      <div className="grid">
        <span>{RESCHEDULE_KIND_LABEL[request.kind]}</span>
        <span className="text-muted-foreground text-xs">
          {[request.requestedBy?.displayName, formatRelative(request.requestedAt)].filter(Boolean).join(' · ')}
        </span>
      </div>
    ),
  },
  {
    key: 'day',
    header: 'Visit day',
    hideBelow: 'lg',
    cell: (request) => (
      <div className="grid">
        <span>{formatScheduledDate(request.inspection.scheduledOn)}</span>
        {request.preferredOn ? (
          <span className="text-muted-foreground text-xs">Suggests {formatScheduledDate(request.preferredOn)}</span>
        ) : null}
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    className: 'max-w-xs',
    cell: (request) => {
      const state = standing(request);
      return (
        <div className="grid gap-1">
          <Badge variant={state.variant}>{state.label}</Badge>
          {state.detail ? <span className="text-muted-foreground text-xs text-pretty">{state.detail}</span> : null}
          {request.rebook ? (
            <Link className="text-primary relative z-10 text-xs hover:underline" href={`/inspections/${request.rebook.id}`}>
              Open the new visit
            </Link>
          ) : null}
        </div>
      );
    },
  },
];

type Answering = { request: RescheduleRequestView; answer: 'move' | 'book' | 'dismiss' };

/** Radix's select has no empty value: this one stands for "nobody". */
const NOBODY = 'nobody';

export default function ReschedulesPage() {
  const { has } = usePermissions();
  const canManage = has('inspections:manage');
  const [filter, setFilter] = useState<RescheduleRequestFilter>('open');
  const requests = useRescheduleRequests(filter);
  const [answering, setAnswering] = useState<Answering | null>(null);

  const header = (
    <PageHeader
      description="Visits the technicians asked to have booked again."
      info={
        <>
          <p>
            A request comes from a technician who asked for <b>another day</b> before going, who <b>could not get in</b>,
            or who left a service <b>not done</b> with &ldquo;Ask the office to book it again&rdquo;.
          </p>
          <p>
            <b>Move</b> puts a visit still to happen on another day, here and in Jobber. <b>Book again</b> makes a new
            visit for what was not done, booked in Jobber when the first one was. <b>Dismiss</b> leaves a note on the
            Jobber job saying why it is not booked.
          </p>
          <p>
            A request is done once Jobber has taken the change. If Jobber refuses, it comes back here with the reason.
            One moved or booked by hand in Jobber closes on its own when the sync sees it.
          </p>
        </>
      }
      infoLabel="How requests are answered"
      title="Reschedules"
    />
  );

  if (requests.isLoading)
    return (
      <>
        {header}
        <PageSkeleton cards={1} />
      </>
    );
  if (requests.isError)
    return (
      <>
        {header}
        <ErrorState error={requests.error} retry={() => void requests.refetch()} />
      </>
    );

  const data = requests.data!;
  return (
    <>
      {header}
      <div className="grid gap-4">
        <Tabs onValueChange={(value) => setFilter(value as RescheduleRequestFilter)} value={filter}>
          <TabsList>
            <TabsTrigger value="open">
              Open{' '}
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {(data.counts.open + data.counts.sending).toLocaleString()}
              </span>
            </TabsTrigger>
            <TabsTrigger value="closed">Answered</TabsTrigger>
          </TabsList>
        </Tabs>
        {data.items.length ? (
          <DataTable
            actions={
              filter === 'open'
                ? (request) => (
                    <RowActions
                      canManage={canManage}
                      list={data}
                      onAnswer={(answer) => setAnswering({ request, answer })}
                      request={request}
                    />
                  )
                : undefined
            }
            columns={columns}
            label={filter === 'open' ? 'Open reschedule requests' : 'Answered reschedule requests'}
            rowHref={(request) => `/inspections/${request.inspection.id}`}
            rowKey={(request) => request.id}
            rows={data.items}
          />
        ) : (
          <EmptyState
            description={
              filter === 'open'
                ? 'Nothing is waiting. A request appears here when a technician asks for a visit to be booked again.'
                : 'Nothing has been answered yet.'
            }
            icon={CalendarCheckIcon}
            title={filter === 'open' ? 'No visits to book again' : 'No answered requests'}
          />
        )}
      </div>

      {answering?.answer === 'dismiss' ? (
        <DismissDialog onClose={() => setAnswering(null)} request={answering.request} />
      ) : answering ? (
        <DayDialog answer={answering.answer} onClose={() => setAnswering(null)} request={answering.request} />
      ) : null}
    </>
  );
}

/** Why an answer cannot be given here, or null when it can. */
function blocked(request: RescheduleRequestView, list: RescheduleRequestList, canManage: boolean) {
  if (request.status === 'SENDING') return 'Waiting for Jobber to take the answer already given.';
  if (!canManage) return 'Moving or booking a visit needs permission to manage inspections.';
  if (request.action === 'MOVE' && request.inspection.inJobber && !list.jobberEditsPushed)
    return 'Changes are not sent to Jobber on this server: move it in Jobber, and this closes when the sync sees it.';
  if (request.action === 'BOOK_AGAIN' && request.rebook)
    return 'Booked again already; Jobber refused that booking. Fix it on the new visit, or dismiss this.';
  if (request.action === 'BOOK_AGAIN' && request.inspection.inJobber && !list.jobberBookingEnabled)
    return 'Visits are not booked in Jobber from this server: book it in Jobber, and this closes when the sync sees it.';
  return null;
}

function RowActions({
  request,
  list,
  canManage,
  onAnswer,
}: {
  request: RescheduleRequestView;
  list: RescheduleRequestList;
  canManage: boolean;
  onAnswer: (answer: Answering['answer']) => void;
}) {
  const reason = blocked(request, list, canManage);
  return (
    <div className="relative z-10 flex justify-end gap-2">
      <Button
        disabled={Boolean(reason)}
        onClick={() => onAnswer(request.action === 'MOVE' ? 'move' : 'book')}
        size="sm"
        title={reason ?? undefined}
        variant="outline"
      >
        {request.action === 'MOVE' ? 'Move…' : 'Book again…'}
      </Button>
      <Button
        disabled={request.status !== 'OPEN'}
        onClick={() => onAnswer('dismiss')}
        size="sm"
        variant="ghost"
      >
        Dismiss…
      </Button>
    </div>
  );
}

/** Move, or book again: a day, and for a booking who goes. */
function DayDialog({
  request,
  answer,
  onClose,
}: {
  request: RescheduleRequestView;
  answer: 'move' | 'book';
  onClose: () => void;
}) {
  const move = useMoveRescheduleRequest();
  const book = useBookAgainRescheduleRequest();
  const technicians = useTechnicians({ page: 1, pageSize: 100 });
  const [day, setDay] = useState(request.suggestedDay ?? '');
  const [technician, setTechnician] = useState(request.inspection.technician?.id ?? NOBODY);
  const pending = move.isPending || book.isPending;
  const today = businessToday();
  const type = typeName(request.inspection.inspectionType).toLowerCase();

  const submit = () => {
    const done = {
      onSuccess: (result: RescheduleRequestView) => {
        toast.success(answer === 'move' ? 'The visit was moved' : 'The visit was booked again', {
          description:
            result.status === 'SENDING' ? 'Sending to Jobber; this closes when Jobber takes it.' : undefined,
        });
        onClose();
      },
      onError: (error: Error) =>
        toast.error(answer === 'move' ? 'The visit was not moved' : 'The visit was not booked', {
          description: error.message,
        }),
    };
    if (answer === 'move') move.mutate({ id: request.id, input: { scheduledOn: day } }, done);
    else
      book.mutate(
        { id: request.id, input: { scheduledOn: day, technicianId: technician === NOBODY ? null : technician } },
        done,
      );
  };

  return (
    <Dialog onOpenChange={(open) => (open || pending ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{answer === 'move' ? 'Move the visit' : 'Book it again'}</DialogTitle>
          <DialogDescription>
            {request.inspection.address ?? 'An address not on file'}, on {formatScheduledDate(request.inspection.scheduledOn)}.{' '}
            {answer === 'move'
              ? request.inspection.inJobber
                ? 'Moved here and in Jobber, with its plan stop.'
                : 'Moved here, with its plan stop.'
              : `A new ${type} visit for ${asked(request).toLowerCase()}${
                  request.inspection.inJobber ? ', booked in Jobber too' : ''
                }.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm">
            <span className="text-muted-foreground">{request.requestedBy?.displayName ?? 'The technician'}:</span>{' '}
            {request.reason}
          </p>
          <Field>
            <FieldLabel htmlFor="reschedule-day">{answer === 'move' ? 'New day (Texas)' : 'Day (Texas)'}</FieldLabel>
            <DatePicker id="reschedule-day" min={today} onChange={setDay} value={day} />
            {/* Names the day it offers: a hint that said only "the next Monday" read
                as describing whatever day was picked in the calendar instead. */}
            {request.suggestedDay ? (
              <FieldDescription>
                {request.preferredOn === request.suggestedDay
                  ? `The technician suggested ${formatScheduledDate(request.suggestedDay)}.`
                  : `The next Monday kept for rescheduled visits is ${formatScheduledDate(request.suggestedDay)}.`}
              </FieldDescription>
            ) : null}
          </Field>
          {answer === 'book' ? (
            <Field>
              <FieldLabel htmlFor="reschedule-technician">Technician</FieldLabel>
              <Select onValueChange={setTechnician} value={technician}>
                <SelectTrigger className="w-full" id="reschedule-technician">
                  <SelectValue placeholder="Choose a technician" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NOBODY}>Nobody yet</SelectItem>
                  {[...(technicians.data?.items ?? [])]
                    .sort((a, b) => a.displayName.localeCompare(b.displayName))
                    .map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {request.kind === 'SERVICES_NOT_DONE' ? (
                <FieldDescription>
                  The new visit is a whole {type} visit. To book only the service, book it in Jobber and dismiss this.
                </FieldDescription>
              ) : null}
            </Field>
          ) : null}
        </div>

        <DialogFooter>
          <Button disabled={pending} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={pending || !day || day < today} onClick={submit}>
            {pending ? <Spinner /> : null}
            {answer === 'move' ? 'Move' : 'Book again'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DismissDialog({ request, onClose }: { request: RescheduleRequestView; onClose: () => void }) {
  const dismiss = useDismissRescheduleRequest();
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 3 && !dismiss.isPending;
  return (
    <Dialog onOpenChange={(open) => (open || dismiss.isPending ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dismiss the request</DialogTitle>
          <DialogDescription>
            {request.inspection.address ?? 'An address not on file'}:{' '}
            {request.kind === 'BEFORE_VISIT'
              ? `the visit stays on ${formatScheduledDate(request.inspection.scheduledOn)}`
              : 'it is not booked again'}
            {request.inspection.inJobber ? '. A note on the Jobber job says so, with your reason' : ''}.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="reschedule-dismiss-reason">Why</FieldLabel>
          <Textarea
            id="reschedule-dismiss-reason"
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Booked in Jobber by hand, tenant moved out, done on the next visit…"
            rows={3}
            value={reason}
          />
        </Field>
        <DialogFooter>
          <Button disabled={dismiss.isPending} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!ready}
            onClick={() =>
              dismiss.mutate(
                { id: request.id, input: { reason: reason.trim() } },
                {
                  onSuccess: () => {
                    toast.success('The request was dismissed');
                    onClose();
                  },
                  onError: (error) => toast.error('The request was not dismissed', { description: error.message }),
                },
              )
            }
          >
            {dismiss.isPending ? <Spinner /> : null}
            Dismiss
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
