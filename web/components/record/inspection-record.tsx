'use client';

import type { AdminInspection } from '@texasrenters/shared';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { formatAddress, formatDateTime, formatScheduledDate, humanize } from '@/lib/format';

import { AsideCard, FactTable, PlaceCard, type Fact } from './record-kit';

/**
 * The inspection page's Jobber layout (the office, 2026-11-04: "we want the
 * features for familiarity"). Everything here is read from what the page has
 * already loaded; nothing is asked for again.
 */

interface ReviewFigures {
  /** "3 of 7", or null while the area summary is read. */
  areasReviewed: string | null;
  /** Null when this account may not read findings. */
  findingsToReview: number | null | undefined;
  comparedWith?: { id: string; scheduledAt: string } | null;
  /** Only the types compared against a move-in show the row at all. */
  comparesToMoveIn: boolean;
}

/** The property's card and the inspection's details, side by side as Jobber's job page has them. */
export function InspectionRecordTop({
  figures,
  item,
}: {
  figures: ReviewFigures;
  item: AdminInspection;
}) {
  const building = item.propertywareBuilding;

  // What the job is and when are the header's and the Visit card's; these are the review's.
  const facts: Fact[] = [{ label: 'Areas reviewed', value: figures.areasReviewed ?? '…' }];
  if (figures.findingsToReview !== null)
    facts.push({
      label: 'Findings to review',
      value:
        figures.findingsToReview === undefined ? (
          '…'
        ) : figures.findingsToReview ? (
          <span className="text-warning font-semibold">{figures.findingsToReview}</span>
        ) : (
          'None'
        ),
    });
  if (figures.comparesToMoveIn)
    facts.push({
      label: 'Compared with',
      value: figures.comparedWith ? (
        <Link className="hover:underline" href={`/inspections/${figures.comparedWith.id}`}>
          Move-in · {formatScheduledDate(figures.comparedWith.scheduledAt)}
        </Link>
      ) : (
        <span className="text-muted-foreground">No move-in</span>
      ),
    });
  if (item.priority && item.priority !== 'STANDARD') facts.push({ label: 'Priority', value: humanize(item.priority) });

  return (
    <div className="mb-4 grid items-start gap-4 lg:grid-cols-2">
      <PlaceCard
        address={building ? formatAddress(building) : null}
        href={building ? `/properties/${building.id}` : undefined}
        lines={[{ label: 'Unit', value: item.propertywareUnit?.name ?? 'Entire property' }]}
        name={building?.name ?? 'Property snapshot'}
      />
      <FactTable className="lg:-mt-2.5" facts={facts} label="Inspection details" />
    </div>
  );
}

interface AuditEvent {
  id: string;
  action: string;
  detail?: string | null;
  actorName?: string | null;
  createdAt: string;
}

/** Jobber's side panel, for an inspection: where it stands, its notes, and what happened to it last. */
export function InspectionRecordAside({
  activity,
  item,
  notesAction,
  onSeeActivity,
  technicianName,
}: {
  /** The page's own audit page, already loaded; the first few are shown. */
  activity: readonly AuditEvent[] | undefined;
  item: AdminInspection;
  /** "Edit", where the viewer may edit the inspection's details. */
  notesAction?: ReactNode;
  /** Opens the full activity, further down the page. */
  onSeeActivity: () => void;
  technicianName: string | null;
}) {
  return (
    <>
      <AsideCard title="Overview">
        <dl className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusBadge value={item.status} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">Technician</dt>
            <dd className="text-heading truncate">{technicianName ?? 'Nobody yet'}</dd>
          </div>
          <div className="flex items-start justify-between gap-2">
            <dt className="text-muted-foreground shrink-0">In Jobber</dt>
            <dd className="text-heading min-w-0 text-right break-words">
              {item.jobberVisitTitle ?? (item.scheduledInJobber ? 'Booked' : 'Not booked')}
            </dd>
          </div>
        </dl>
      </AsideCard>

      <AsideCard action={notesAction} title="Notes">
        {item.internalNotes ? (
          <p className="text-foreground whitespace-pre-wrap">{item.internalNotes}</p>
        ) : (
          <p className="text-muted-foreground border-border rounded-lg border border-dashed px-3 py-4 text-center">
            No internal notes yet.
          </p>
        )}
      </AsideCard>

      <AsideCard
        action={
          <Button className="h-7 px-2 text-xs" onClick={onSeeActivity} size="sm" variant="ghost">
            See all
          </Button>
        }
        title="Recent activity"
      >
        {activity === undefined ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : activity.length ? (
          <ol className="flex flex-col gap-2.5">
            {activity.slice(0, 5).map((event) => (
              <li className="flex flex-col" key={event.id}>
                <span className="text-heading font-medium">{humanize(event.action)}</span>
                <span className="text-muted-foreground text-xs">
                  {[event.actorName, formatDateTime(event.createdAt)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">Nothing recorded yet.</p>
        )}
      </AsideCard>
    </>
  );
}
