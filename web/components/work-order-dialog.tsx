'use client';

import { isUpcomingVisit, visitStateOf, type AdminWorkOrder } from '@texasrenters/shared';
import {
  ExternalLinkIcon,
  KeyRoundIcon,
  LockIcon,
  MapPinIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserRoundIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EMPTY, formatScheduledDate, humanize } from '@/lib/format';
import { useInspection, useInspectionWorkOrder } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * How the work order was matched to a technician: the AI's reading of the job
 * and the reason the ranking gave. The AI named the job types only; who went
 * is the office's rule. Amber when it was left for the office.
 */
function MatchingNote({ matching }: { matching: NonNullable<AdminWorkOrder['matching']> }) {
  const suggested = matching.outcome === 'SUGGESTED';
  const leftForOffice = !suggested && matching.outcome !== 'ASSIGNED' && matching.outcome !== 'ALREADY_ASSIGNED';
  const facts = [
    matching.skills.length ? matching.skills.join(', ') : null,
    matching.scope ? `${matching.scope.toLowerCase()} job` : null,
    matching.confidence !== null ? `${matching.confidence}% sure` : null,
  ].filter(Boolean);
  return (
    <div
      className={cn(
        'flex gap-2.5 rounded-lg border px-4 py-3 text-sm',
        leftForOffice ? 'border-warning/40 bg-warning/5' : 'bg-muted/20',
      )}
    >
      <SparklesIcon aria-hidden className={cn('mt-0.5 size-4 shrink-0', leftForOffice ? 'text-warning' : 'text-muted-foreground')} />
      <div className="grid min-w-0 gap-0.5">
        <span className="text-muted-foreground text-xs">
          {suggested
            ? 'Skill match (trial, nobody assigned)'
            : leftForOffice
              ? 'Not auto-assigned'
              : 'Auto-assigned by skill match'}
          {facts.length ? ` · ${facts.join(' · ')}` : ''}
        </span>
        {matching.summary ? <span>{matching.summary}</span> : null}
        <span className="font-medium">{matching.reason}</span>
      </div>
    </div>
  );
}

/**
 * The visit types only the maintenance app's hand-off files (the Jobber sync
 * never types a visit either way). A row of one is a work order.
 */
const WORK_ORDER_TYPES = new Set(['MAINTENANCE', 'PEST_CONTROL']);

export function isWorkOrderVisit(row: { inspectionType?: string | null }): boolean {
  return WORK_ORDER_TYPES.has(row.inspectionType ?? '');
}

/** "Nov 20, 2026" for a date the maintenance app sent; the dash when it sent none. */
const day = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : EMPTY;

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? EMPTY : value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Which of the maintenance app's rules let the work order through, in the office's words. */
const RULE_WORDS: Record<string, string> = {
  emergency: 'Emergency — sent whatever it costs',
  owner_approved_recorded: 'Owner approval on record',
  under_threshold: 'At or under the approval line — the owner is not asked',
  owner_approved_in_messages: 'Owner approved in messages (read by AI)',
  manual: 'Sent by hand from the maintenance app',
};

const DECISION_WORDS = { approved: 'Approved', declined: 'Declined', not_mentioned: 'Not mentioned' } as const;

/**
 * One read-only value. Plain text under a quiet label rather than a boxed
 * field: nothing here can be edited, and a box that looks like an input
 * invites a click that does nothing.
 */
function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-0.5', wide && 'sm:col-span-2')}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

/** A titled group of fields: what is broken, how to get in, who and when. */
function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden className="text-muted-foreground size-4" />
        {title}
      </h3>
      <dl className="grid gap-x-6 gap-y-3 pl-6 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Unsent() {
  return (
    <p className="text-muted-foreground text-sm">
      The maintenance app’s copy of this work order could not be read. Its text is on the Details tab.
    </p>
  );
}

/** Where approval stands, in a few words, for the header. */
function approvalState(wo: AdminWorkOrder): { words: string; tone: 'success' | 'warning' | 'secondary' } {
  const rule = wo.approval?.rule;
  if (rule === 'owner_approved_recorded' || rule === 'owner_approved_in_messages' || wo.approvedDate)
    return { words: wo.approval?.recordedBy ? `Approved by ${wo.approval.recordedBy}` : 'Owner approved', tone: 'success' };
  if (rule === 'under_threshold') return { words: 'No approval needed', tone: 'secondary' };
  if (rule === 'emergency') return { words: 'Emergency — no approval asked', tone: 'warning' };
  return { words: 'Sent by hand', tone: 'secondary' };
}

/**
 * The crew's estimate placed against the approval line: the one comparison
 * the whole hand-off rule turns on, drawn rather than described.
 */
function EstimateMeter({ estimate, threshold }: { estimate: number | null; threshold: number }) {
  if (estimate === null) {
    return <p className="text-muted-foreground text-sm">The crew has not entered an estimate.</p>;
  }
  const scale = Math.max(threshold * 1.5, estimate * 1.1, 1);
  const over = estimate > threshold;
  const fill = Math.min(100, (estimate / scale) * 100);
  const line = (threshold / scale) * 100;
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-3xl font-semibold tabular-nums">{money(estimate)}</span>
        <span className={cn('text-sm', over ? 'text-warning' : 'text-muted-foreground')}>
          {over
            ? `${money(estimate - threshold)} over the ${money(threshold)} line`
            : `${money(threshold - estimate)} under the ${money(threshold)} line`}
        </span>
      </div>
      <div
        aria-label={`Estimate ${money(estimate)} against an approval line of ${money(threshold)}`}
        className="bg-muted relative h-2 rounded-full"
        role="img"
      >
        <div className={cn('h-full rounded-full', over ? 'bg-warning' : 'bg-success')} style={{ width: `${fill}%` }} />
        <div aria-hidden className="bg-foreground absolute -top-1 h-4 w-0.5 rounded" style={{ left: `${line}%` }} />
      </div>
      <div className="text-muted-foreground relative h-4 text-xs">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${line}%` }}>
          Approval line
        </span>
      </div>
    </div>
  );
}

/** The crew's estimate and what let the work order through, as the maintenance app decided it. */
function EstimatePanel({ workOrder: wo }: { workOrder: AdminWorkOrder }) {
  const approval = wo.approval;
  return (
    <div className="grid gap-6">
      <EstimateMeter estimate={wo.costEstimate} threshold={approval?.threshold ?? 300} />
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Field label="Sent because" wide>
          {approval?.rule ? (RULE_WORDS[approval.rule] ?? humanize(approval.rule)) : EMPTY}
        </Field>
        <Field label="Approved by">{approval?.recordedBy ?? EMPTY}</Field>
        <Field label="Approval date">{day(approval?.recordedAt ?? wo.approvedDate)}</Field>
      </dl>
      {approval?.summary || approval?.problems.length ? (
        <section className="grid gap-3 border-t pt-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <SparklesIcon aria-hidden className="text-muted-foreground size-4" />
            What the owner said, as the AI read it
            {approval.aiConfidence !== null ? (
              <span className="text-muted-foreground font-normal">{approval.aiConfidence}% sure</span>
            ) : null}
          </h3>
          {approval.summary ? <p className="text-sm">{approval.summary}</p> : null}
          {approval.problems.length ? (
            <ul className="grid gap-2">
              {approval.problems.map((problem) => (
                <li className="grid gap-0.5 sm:grid-cols-[7rem_1fr] sm:gap-3" key={problem.item}>
                  <Badge
                    variant={
                      problem.decision === 'approved' ? 'success' : problem.decision === 'declined' ? 'destructive' : 'secondary'
                    }
                  >
                    {DECISION_WORDS[problem.decision]}
                  </Badge>
                  <span className="text-sm">
                    <span className="font-medium">{problem.item}</span>
                    {problem.evidence ? <span className="text-muted-foreground"> — “{problem.evidence}”</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
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
 * Emergency / Approved beside it, then tabs -- so the office reads it the same
 * way in both apps. The header answers the three questions a crew lead asks
 * first: what it costs, whether it is approved, and who is going. Nothing is
 * approved or changed here; that stays with the maintenance app.
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
      .join(', ');
  const approval = wo ? approvalState(wo) : null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[90vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="gap-3 border-b p-6 pb-4 text-left">
          <div className="grid gap-1 pr-8">
            <DialogTitle className="text-primary flex items-center gap-2 text-2xl tabular-nums">
              {number ? `#${number}` : 'Work order'}
              {wo?.url ? (
                <a
                  aria-label="Open in PropertyWare"
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                  href={wo.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLinkIcon className="size-4" />
                </a>
              ) : null}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-1.5">
              <MapPinIcon aria-hidden className="size-3.5 shrink-0" />
              {address || (loading ? 'Loading…' : EMPTY)}
            </DialogDescription>
          </div>

          {wo ? (
            <div className="flex flex-wrap gap-2">
              <Badge variant={/high|urgent|emergency/i.test(wo.priority ?? '') ? 'destructive' : 'outline'}>
                Priority: {wo.priority ?? EMPTY}
              </Badge>
              <Badge variant="outline">Status: {wo.status ?? EMPTY}</Badge>
              {wo.isEmergency !== null ? (
                <Badge variant={wo.isEmergency ? 'destructive' : 'outline'}>
                  {wo.isEmergency ? 'Emergency' : 'Non-emergency'}
                </Badge>
              ) : null}
              {approval?.tone === 'success' ? <Badge variant="success">Approved</Badge> : null}
            </div>
          ) : null}

          {wo && data ? (
            <div className="bg-muted/40 grid gap-3 rounded-lg px-4 py-3 text-sm sm:grid-cols-3 sm:gap-0 sm:divide-x">
              <div className="flex items-center gap-2.5 sm:pr-4">
                <ReceiptIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <div className="grid">
                  <span className="text-muted-foreground text-xs">Crew estimate</span>
                  <span className="font-medium tabular-nums">{money(wo.costEstimate)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2.5 sm:px-4">
                <ShieldCheckIcon
                  aria-hidden
                  className={cn('size-4 shrink-0', approval?.tone === 'success' ? 'text-success' : 'text-muted-foreground')}
                />
                <div className="grid min-w-0">
                  <span className="text-muted-foreground text-xs">Approval</span>
                  <span className="truncate font-medium">{approval?.words}</span>
                </div>
              </div>
              <div className="flex items-center gap-2.5 sm:pl-4">
                <UserRoundIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <div className="grid min-w-0">
                  <span className="text-muted-foreground text-xs">{humanize(data.inspectionType)} crew</span>
                  <span className={cn('truncate font-medium', !technician && 'text-warning')}>
                    {technician ?? 'Nobody assigned yet'}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {wo?.matching ? <MatchingNote matching={wo.matching} /> : null}
        </DialogHeader>

        {loading ? (
          <div aria-busy="true" aria-label="Loading work order" className="grid gap-3 p-6">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : visit.isError ? (
          <div className="p-6">
            <ErrorState error={visit.error} retry={() => void visit.refetch()} />
          </div>
        ) : (
          <Tabs className="min-h-0 flex-1 gap-0" defaultValue="details">
            <div className="overflow-x-auto px-6 pt-4">
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="estimate">Estimate</TabsTrigger>
                <TabsTrigger value="notes">Notes{wo?.notes.length ? ` (${wo.notes.length})` : ''}</TabsTrigger>
                <TabsTrigger value="messages">Messages</TabsTrigger>
                <TabsTrigger value="visit">Crew visit</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent className="overflow-y-auto px-6 pt-4 pb-6" value="details">
              {wo ? (
                <div className="grid gap-6">
                  <p className="border-primary/40 border-l-2 pl-4 text-base leading-relaxed break-words whitespace-pre-wrap">
                    {wo.description ?? 'The maintenance app sent no description.'}
                  </p>
                  <Section icon={WrenchIcon} title="The problem">
                    <Field label="Category">{wo.category ?? EMPTY}</Field>
                    <Field label="Type">{wo.type ?? EMPTY}</Field>
                    <Field label="Location">{wo.specificLocation ?? EMPTY}</Field>
                    <Field label="Emergency">
                      {wo.isEmergency === null ? EMPTY : wo.isEmergency ? 'Emergency' : 'Non-emergency'}
                    </Field>
                  </Section>
                  <Section icon={KeyRoundIcon} title="Getting in">
                    <Field label="Authorized to enter">{wo.authorizedToEnter ?? EMPTY}</Field>
                    <Field label="Occupancy">{wo.occupied ? 'Occupied' : 'Vacant'}</Field>
                    <Field label="Tenants">
                      {wo.tenants.length
                        ? wo.tenants.map((tenant) => [tenant.name, tenant.phone].filter(Boolean).join(', ')).join('\n')
                        : EMPTY}
                    </Field>
                    <Field label="Zone">{wo.zone ?? EMPTY}</Field>
                  </Section>
                  <Section icon={UserRoundIcon} title="Who and when">
                    <Field label="Vendors">
                      {wo.vendors.length
                        ? wo.vendors.map((vendor) => `${vendor.name ?? EMPTY}${vendor.inHouse ? ' (in-house)' : ''}`).join(', ')
                        : EMPTY}
                    </Field>
                    <Field label="Service status">{wo.serviceStatus ?? EMPTY}</Field>
                    <Field label="Source">{wo.source ?? EMPTY}</Field>
                    <Field label="Created">{day(wo.createdDate)}</Field>
                    <Field label="Scheduled end">{day(wo.scheduledEndDate)}</Field>
                  </Section>
                </div>
              ) : data?.internalNotes?.trim() ? (
                <p className="text-sm break-words whitespace-pre-wrap">{data.internalNotes.trim()}</p>
              ) : (
                <p className="text-muted-foreground text-sm">The maintenance app sent no details.</p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 pt-4 pb-6" value="estimate">
              {wo ? <EstimatePanel workOrder={wo} /> : <Unsent />}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 pt-4 pb-6" value="notes">
              {!wo ? (
                <Unsent />
              ) : wo.notes.length ? (
                // Oldest first, as the maintenance app's Notes tab lists them: a
                // timeline, so the rule down the side is the order itself.
                <ol className="border-border ml-1.5 grid gap-5 border-l pl-5">
                  {wo.notes.map((note, index) => (
                    <li className="relative grid gap-1" key={`${note.date ?? ''}-${index}`}>
                      <span
                        aria-hidden
                        className="bg-background border-primary absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2"
                      />
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium">{note.subject ?? 'Note'}</span>
                        <span className="text-muted-foreground text-xs">
                          {[note.author, note.date ? day(note.date) : null].filter(Boolean).join(', ') || EMPTY}
                        </span>
                        {note.isPrivate ? (
                          <Badge variant="outline">
                            <LockIcon aria-hidden className="size-3" />
                            Private
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{note.body}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">No notes on this work order. Notes added in the maintenance app show here after its next send.</p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 pt-4 pb-6" value="messages">
              {!wo ? (
                <Unsent />
              ) : wo.messagesSummary ? (
                <figure className="grid gap-3">
                  <blockquote className="bg-muted/40 rounded-lg p-4 text-base leading-relaxed break-words whitespace-pre-wrap">
                    {wo.messagesSummary.summary}
                  </blockquote>
                  <figcaption className="text-muted-foreground flex items-start gap-2 text-xs">
                    <SparklesIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span>
                      AI summary of {wo.messagesSummary.messagesRead} message
                      {wo.messagesSummary.messagesRead === 1 ? '' : 's'} with the tenant, owner and vendors
                      {wo.messagesSummary.readAt ? `, written ${day(wo.messagesSummary.readAt)}` : ''}. It is written again
                      when a new message arrives. Read the messages themselves in the maintenance app before acting on it.
                    </span>
                  </figcaption>
                </figure>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No messages summary yet. One is written once the work order has texts or emails, and arrives with the next send.
                </p>
              )}
            </TabsContent>

            <TabsContent className="overflow-y-auto px-6 pt-4 pb-6" value="visit">
              {data ? (
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Field label="Status">{state ? <StatusBadge value={state} /> : EMPTY}</Field>
                  <Field label="Crew">{humanize(data.inspectionType)}</Field>
                  <Field label="Scheduled">{formatScheduledDate(data.scheduledAt)}</Field>
                  <Field label="Technician">
                    {technician ?? (state && isUpcomingVisit(state) ? <StatusBadge value="UNASSIGNED" /> : EMPTY)}
                  </Field>
                </dl>
              ) : null}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
