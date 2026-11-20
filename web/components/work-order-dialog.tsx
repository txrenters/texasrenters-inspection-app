'use client';

import { isUpcomingVisit, visitStateOf, type AdminWorkOrder } from '@texasrenters/shared';
import { ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EMPTY, formatScheduledDate, humanize } from '@/lib/format';
import { useInspection, useInspectionWorkOrder } from '@/lib/queries';

/**
 * The visit types only the maintenance app's hand-off files (the Jobber sync
 * never types a visit either way). A row of one is a work order.
 */
const WORK_ORDER_TYPES = new Set(['MAINTENANCE', 'PEST_CONTROL']);

export function isWorkOrderVisit(row: { inspectionType?: string | null }): boolean {
  return WORK_ORDER_TYPES.has(row.inspectionType ?? '');
}

/** "Nov 20, 2026" for a date the maintenance app sent; the dash when it sent none. */
const day = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : EMPTY;

const money = (value: number | null) =>
  value === null ? EMPTY : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** One labelled, read-only value, laid out as the maintenance app's form fields are. */
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'grid gap-1.5 sm:col-span-2' : 'grid gap-1.5'}>
      <span className="text-sm font-medium">{label}</span>
      <div className="bg-muted/40 min-h-9 rounded-md border px-3 py-2 text-sm break-words whitespace-pre-wrap">
        {children}
      </div>
    </div>
  );
}

function Unsent() {
  return <p className="text-muted-foreground text-sm">The maintenance app’s copy of this work order could not be read.</p>;
}

/** Which of the maintenance app's rules let the work order through, in the office's words. */
const RULE_WORDS: Record<string, string> = {
  emergency: 'Emergency — sent whatever it costs',
  owner_approved_recorded: 'Owner approval on record',
  under_threshold: 'At or under the approval line — the owner is not asked',
  owner_approved_in_messages: 'Owner approved in messages (read by AI)',
  manual: 'Sent by hand from the maintenance app',
};

const DECISION_WORDS = { approved: 'Approved', declined: 'Declined', not_mentioned: 'Not mentioned' } as const;

/** The crew's estimate and what let the work order through, as the maintenance app decided it. */
function EstimatePanel({ workOrder: wo }: { workOrder: AdminWorkOrder }) {
  const approval = wo.approval;
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Crew estimate:">{money(wo.costEstimate)}</Field>
        <Field label="Approval line:">{approval ? `${money(approval.threshold)} and under goes without the owner` : EMPTY}</Field>
        <Field label="Sent because:" wide>
          {approval?.rule ? (RULE_WORDS[approval.rule] ?? humanize(approval.rule)) : EMPTY}
        </Field>
        <Field label="Approved by:">{approval?.recordedBy ?? EMPTY}</Field>
        <Field label="Approval Date:">{day(approval?.recordedAt ?? wo.approvedDate)}</Field>
      </div>
      {approval?.summary || approval?.problems.length ? (
        <div className="grid gap-2">
          <span className="text-sm font-medium">
            Owner’s messages, as the AI read them
            {approval.aiConfidence !== null ? ` (${approval.aiConfidence}% sure)` : ''}:
          </span>
          {approval.summary ? (
            <p className="bg-muted/40 rounded-md border p-3 text-sm whitespace-pre-wrap">{approval.summary}</p>
          ) : null}
          {approval.problems.length ? (
            <ul className="grid gap-1.5">
              {approval.problems.map((problem) => (
                <li className="flex flex-wrap items-baseline gap-2 text-sm" key={problem.item}>
                  <Badge variant={problem.decision === 'approved' ? 'success' : problem.decision === 'declined' ? 'destructive' : 'secondary'}>
                    {DECISION_WORDS[problem.decision]}
                  </Badge>
                  <span className="font-medium">{problem.item}</span>
                  {problem.evidence ? <span className="text-muted-foreground">“{problem.evidence}”</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A handed-over work order, read where it was clicked.
 *
 * Not the inspection page: a work order has no rooms, baseline or report, and
 * that page read it as an inspection ("it should be a modal, and not treat it
 * as inspection", the office, 2026-11-21). Laid out as the maintenance app's
 * own work order modal -- the number as the title, Priority / Status /
 * Emergency / Approved beside it, tabs, then the fields -- so the office reads
 * it the same way in both apps. Nothing is approved or changed here; that
 * stays with the maintenance app.
 */
export function WorkOrderDialog({ inspectionId, onClose }: { inspectionId: string; onClose: () => void }) {
  const visit = useInspection(inspectionId);
  const workOrder = useInspectionWorkOrder(inspectionId);
  const wo: AdminWorkOrder | undefined = workOrder.data;
  const data = visit.data;
  const state = data ? visitStateOf(data) : null;
  const technician = data?.assignments?.find((assignment) => assignment.isCurrent)?.technician?.displayName ?? null;
  const number = wo?.number ?? data?.workOrderNumber ?? null;
  const loading = visit.isLoading || workOrder.isLoading;
  const address =
    wo?.address ??
    [data?.propertywareBuilding?.name, data?.propertywareUnit?.name ? `Unit ${data.propertywareUnit.name}` : null]
      .filter(Boolean)
      .join(' · ');

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="gap-2 p-6 pb-3 text-left">
          <DialogTitle className="text-primary flex items-center gap-3 text-2xl">
            {number ? `#${number}` : 'Work order'}
            {wo?.url ? (
              <a
                aria-label="Open in PropertyWare"
                className="text-muted-foreground hover:text-foreground"
                href={wo.url}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon className="size-4" />
              </a>
            ) : null}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap gap-2">
              {wo ? (
                <>
                  <Badge variant={/high|urgent|emergency/i.test(wo.priority ?? '') ? 'destructive' : 'outline'}>
                    Priority: {wo.priority ?? EMPTY}
                  </Badge>
                  <Badge variant="outline">Status: {wo.status ?? EMPTY}</Badge>
                  {wo.isEmergency !== null ? (
                    <Badge variant={wo.isEmergency ? 'destructive' : 'outline'}>
                      {wo.isEmergency ? 'Emergency' : 'Non-emergency'}
                    </Badge>
                  ) : null}
                  {wo.approvedDate || wo.approval?.recordedBy ? <Badge variant="outline">Approved</Badge> : null}
                </>
              ) : (
                <span>{address || (loading ? 'Loading…' : EMPTY)}</span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div aria-busy="true" aria-label="Loading work order" className="space-y-3 px-6 pb-6">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : visit.isError ? (
          <div className="px-6 pb-6">
            <ErrorState error={visit.error} retry={() => void visit.refetch()} />
          </div>
        ) : (
          <Tabs className="min-h-0 flex-1 gap-0" defaultValue="details">
            <div className="flex justify-center px-6 pb-3">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="estimate">Estimate</TabsTrigger>
                <TabsTrigger value="notes">Notes{wo?.notes.length ? ` (${wo.notes.length})` : ''}</TabsTrigger>
                <TabsTrigger value="messages">Messages</TabsTrigger>
                <TabsTrigger value="visit">Crew visit</TabsTrigger>
              </TabsList>
            </div>
            <Separator />

            <TabsContent className="overflow-y-auto px-6 py-4" value="details">
              {wo ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Property:" wide>
                    {address || EMPTY}
                  </Field>
                  <Field label="Vendors:">
                    {wo.vendors.length
                      ? wo.vendors.map((vendor) => `${vendor.name ?? EMPTY}${vendor.inHouse ? ' (in-house)' : ''}`).join(', ')
                      : EMPTY}
                  </Field>
                  <Field label="Emergency:">
                    {wo.isEmergency === null ? EMPTY : wo.isEmergency ? 'Emergency' : 'Non-emergency'}
                  </Field>
                  <Field label="Category:">{wo.category ?? EMPTY}</Field>
                  <Field label="Type:">{wo.type ?? EMPTY}</Field>
                  <Field label="Location:">{wo.specificLocation ?? EMPTY}</Field>
                  <Field label="Service Status:">{wo.serviceStatus ?? EMPTY}</Field>
                  <Field label="Authorized to enter:">{wo.authorizedToEnter ?? EMPTY}</Field>
                  <Field label="Source:">{wo.source ?? EMPTY}</Field>
                  <Field label="Zone:">{wo.zone ?? EMPTY}</Field>
                  <Field label="Occupancy:">{wo.occupied ? 'Occupied' : 'Vacant'}</Field>
                  <Field label="Tenants:">
                    {wo.tenants.length
                      ? wo.tenants.map((tenant) => [tenant.name, tenant.phone].filter(Boolean).join(' · ')).join('\n')
                      : EMPTY}
                  </Field>
                  <Field label="Created Date:">{day(wo.createdDate)}</Field>
                  <Field label="Scheduled End Date:">{day(wo.scheduledEndDate)}</Field>
                  <Field label="Description:" wide>
                    {wo.description ?? EMPTY}
                  </Field>
                </div>
              ) : data?.internalNotes?.trim() ? (
                <Field label="Work order:" wide>
                  {data.internalNotes.trim()}
                </Field>
              ) : (
                <p className="text-muted-foreground text-sm">The maintenance app sent no details.</p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 py-4" value="estimate">
              {wo ? <EstimatePanel workOrder={wo} /> : <Unsent />}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 py-4" value="notes">
              {!wo ? (
                <Unsent />
              ) : wo.notes.length ? (
                <ol className="grid gap-3">
                  {wo.notes.map((note, index) => (
                    <li className="bg-muted/40 rounded-md border p-3" key={`${note.date ?? ''}-${index}`}>
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs">
                        {note.subject ? <span className="text-sm font-medium">{note.subject}</span> : null}
                        <span className="text-muted-foreground">
                          {[note.author, note.date ? day(note.date) : null].filter(Boolean).join(' · ') || EMPTY}
                        </span>
                        {note.isPrivate ? <Badge variant="outline">Private</Badge> : null}
                      </div>
                      <p className="text-sm break-words whitespace-pre-wrap">{note.body}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">No notes on this work order.</p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 py-4" value="messages">
              {!wo ? (
                <Unsent />
              ) : wo.messagesSummary ? (
                <div className="grid gap-2">
                  <p className="bg-muted/40 rounded-md border p-3 text-sm break-words whitespace-pre-wrap">
                    {wo.messagesSummary.summary}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    AI summary of {wo.messagesSummary.messagesRead} message
                    {wo.messagesSummary.messagesRead === 1 ? '' : 's'} with the tenant, owner and vendors
                    {wo.messagesSummary.readAt ? `, written ${day(wo.messagesSummary.readAt)}` : ''}. It is written
                    again when a new message arrives.
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No messages summary yet.</p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 py-4" value="visit">
              {data ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Status:">{state ? <StatusBadge value={state} /> : EMPTY}</Field>
                  <Field label="Crew:">{humanize(data.inspectionType)}</Field>
                  <Field label="Scheduled:">{formatScheduledDate(data.scheduledAt)}</Field>
                  <Field label="Technician:">
                    {technician ?? (state && isUpcomingVisit(state) ? <StatusBadge value="UNASSIGNED" /> : EMPTY)}
                  </Field>
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
