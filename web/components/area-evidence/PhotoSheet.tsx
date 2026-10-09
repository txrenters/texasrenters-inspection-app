'use client';

import type {
  AreaChecklistEntry,
  AreaEvidenceBundle,
  AreaEvidenceSummaryItem,
} from '@texasrenters/shared';
import { useQueries } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { areaEvidenceQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { STATUS_META } from './area-status';
import { isAnswerItem, isChecklistItemAssessed } from './AreaConditionChecklist';
import { AreaReviewControl } from './AreaReviewControl';
import { LazyPhoto } from './LazyPhoto';

/**
 * Every area on one page: its photographs, what its checklist says, and the
 * reviewer's mark.
 *
 * Built for the occupied inspection, where an area is usually one photograph
 * and two answers. Reviewing one through the area list meant open an area,
 * open its Photos tab, open the photograph, read the Condition tab, and go
 * back -- twenty times. Here the whole inspection reads top to bottom the way
 * the office's printed report does, and any photograph opens the viewer that
 * walks on through the rest.
 *
 * Each area's bundle is the same cached read the area panel and the viewer use,
 * so switching views or opening a photograph fetches nothing twice.
 */
export function PhotoSheet({
  inspectionId,
  areas,
  onOpenPhoto,
  onOpenArea,
}: {
  inspectionId: string;
  /** The areas to show, in order: the list as filtered. */
  areas: AreaEvidenceSummaryItem[];
  onOpenPhoto: (areaId: string, photoId: string) => void;
  /** Opens an area in the area view, for what the sheet does not hold: findings. */
  onOpenArea: (areaId: string) => void;
}) {
  const canReview = usePermissions().has('findings:review');
  const bundles = useQueries({
    queries: areas.map((area) => areaEvidenceQuery(inspectionId, area.id)),
  });

  // A quiet line, not a dashed box inside the Areas card (console-development).
  if (!areas.length)
    return <p className="text-muted-foreground py-4 text-center text-sm">No areas match this filter.</p>;

  return (
    <ol aria-label="Photos and answers by area" className="divide-y rounded-lg border">
      {areas.map((area, index) => (
        <SheetRow
          area={area}
          bundle={bundles[index]?.data}
          canReview={canReview}
          inspectionId={inspectionId}
          key={area.id}
          onOpenArea={onOpenArea}
          onOpenPhoto={onOpenPhoto}
        />
      ))}
    </ol>
  );
}

function SheetRow({
  inspectionId,
  area,
  bundle,
  canReview,
  onOpenPhoto,
  onOpenArea,
}: {
  inspectionId: string;
  area: AreaEvidenceSummaryItem;
  bundle: AreaEvidenceBundle | undefined;
  canReview: boolean;
  onOpenPhoto: (areaId: string, photoId: string) => void;
  onOpenArea: (areaId: string) => void;
}) {
  // The bundle's status when it has arrived: it moves with a review mark on the
  // click, where the summary's waits for its refetch.
  const meta = STATUS_META[bundle?.area.reviewStatus ?? area.reviewStatus];
  const photos = bundle ? bundle.photoGroups.flatMap((group) => group.photos) : [];
  const note = bundle?.area.technicianNote?.trim();
  const pending = bundle?.counts.unreviewedFindings ?? area.counts.unreviewedFindings;

  return (
    <li
      aria-label={area.name}
      className="grid gap-3 p-3 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,15rem)]"
    >
      <div className="grid content-start gap-1">
        <span className="text-sm font-medium">{area.name}</span>
        {area.floorName ? (
          <span className="text-muted-foreground text-xs">{area.floorName}</span>
        ) : null}
        <span className="flex flex-wrap gap-1">
          <Badge variant={meta.variant}>{meta.label}</Badge>
        </span>
        {area.skipReason ? (
          <span className="text-muted-foreground text-xs italic">{area.skipReason}</span>
        ) : null}
        {note ? <span className="text-xs">Note: {note}</span> : null}
      </div>

      <div className="min-w-0">
        {!bundle ? (
          <Skeleton className="h-24 w-full max-w-md rounded-lg" />
        ) : photos.length ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5 lg:grid-cols-6">
            {photos.map((photo) => (
              <LazyPhoto
                areaName={area.name}
                key={photo.id}
                onOpen={() => onOpenPhoto(area.id, photo.id)}
                photo={photo}
                compact
              />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No photographs</p>
        )}
      </div>

      <div className="grid content-start gap-2">
        {bundle ? (
          <ConditionLines checklist={bundle.checklist} />
        ) : (
          <Skeleton className="h-10 w-full rounded-md" />
        )}
        {pending ? (
          // Findings are decided in the area view, beside the recording and
          // the photographs they point at; the sheet only says they are there.
          <Button
            className="justify-self-start"
            onClick={() => onOpenArea(area.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            {pending} finding{pending === 1 ? '' : 's'} to review
          </Button>
        ) : null}
        {bundle ? (
          <AreaReviewControl
            align="start"
            bundle={bundle}
            canReview={canReview}
            inspectionId={inspectionId}
          />
        ) : null}
      </div>
    </li>
  );
}

/** One line of what an area's checklist says, for the sheet. */
export type ConditionLine = { label: string; value: string; tone?: 'flagged' | 'missing' };

/**
 * What an area's checklist says, as short lines.
 *
 * Answers -- an occupied room's "Clean" and "Good", a reading, a line of text --
 * are listed as given, and an unanswered one says so. A room scored item by
 * item on the three axes is too long for a row, so it is summarised: how much
 * was scored, then the items that failed an axis, which are what a reviewer
 * reads it for.
 */
export function conditionLines(checklist: AreaChecklistEntry[]): ConditionLine[] {
  const lines: ConditionLine[] = [];
  for (const item of checklist.filter(isAnswerItem)) {
    const value =
      item.numericValue != null
        ? `${item.numericValue}${item.unit ? ` ${item.unit}` : ''}`
        : item.textValue || null;
    lines.push(
      value ? { label: item.label, value } : { label: item.label, value: 'Not answered', tone: 'missing' },
    );
  }
  const scored = checklist.filter((item) => !isAnswerItem(item));
  if (scored.length) {
    lines.push({
      label: 'Scored',
      value: `${scored.filter(isChecklistItemAssessed).length} of ${scored.length} items`,
    });
    for (const item of scored) {
      const failed = [
        item.isClean === false ? 'not clean' : null,
        item.isUndamaged === false ? 'damaged' : null,
        item.isWorking === false ? 'not working' : null,
      ].filter(Boolean);
      if (failed.length) lines.push({ label: item.label, value: failed.join(', '), tone: 'flagged' });
    }
  }
  return lines;
}

/** What an area's checklist says, as the sheet and the viewer's review panel show it. */
export function ConditionLines({ checklist }: { checklist: AreaChecklistEntry[] }) {
  const lines = conditionLines(checklist);
  if (!lines.length) return <p className="text-muted-foreground text-xs">No checklist</p>;
  return (
    <dl className="grid gap-0.5 text-xs">
      {lines.map((line, index) => (
        <div className="flex flex-wrap gap-x-1" key={`${line.label}-${index}`}>
          <dt className="text-muted-foreground">{line.label}:</dt>
          <dd
            className={cn(
              'font-medium',
              line.tone === 'flagged' && 'text-destructive',
              line.tone === 'missing' && 'text-muted-foreground font-normal italic',
            )}
          >
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
