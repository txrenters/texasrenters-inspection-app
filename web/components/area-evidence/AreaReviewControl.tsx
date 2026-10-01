'use client';

import type { AreaEvidenceBundle } from '@texasrenters/shared';
import { CheckIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { useSetAreaReviewed } from '@/lib/queries';
import { cn } from '@/lib/utils';

/**
 * The reviewer's "I have looked at this area".
 *
 * The review count used to move only when an area's findings were all decided,
 * so an area with nothing wrong in it could never count. This says so directly.
 * Never in place of a decision: while a finding in the area still awaits one,
 * the control says so instead of offering the mark. Shown on the click
 * (`useSetAreaReviewed` is optimistic), so there is no spinner to wait on.
 *
 * Beside the area's name in its panel, and on each row of the photo sheet.
 */
export function AreaReviewControl({
  inspectionId,
  bundle,
  canReview,
  finalized,
  align = 'end',
}: {
  inspectionId: string;
  bundle: AreaEvidenceBundle;
  canReview: boolean;
  finalized: boolean;
  /** Which edge it sits against: the panel's header right, a sheet row's left. */
  align?: 'start' | 'end';
}) {
  const mark = useSetAreaReviewed(inspectionId);
  const { area, counts } = bundle;
  const review = area.review;
  const standing = Boolean(review?.current) && area.reviewStatus === 'REVIEWED';
  const by = review?.byName ? ` by ${review.byName}` : '';

  if (standing && review)
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 text-xs',
          align === 'end' ? 'justify-end' : 'justify-start',
        )}
      >
        <span className="text-success flex items-center gap-1 font-medium">
          <CheckIcon aria-hidden className="size-3.5" />
          Reviewed{by}
        </span>
        <span className="text-muted-foreground">{formatDateTime(review.at)}</span>
        {canReview && !finalized ? (
          <Button
            onClick={() => mark.mutate({ areaId: area.id, reviewed: false })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Undo
          </Button>
        ) : null}
      </div>
    );
  if (!canReview || finalized) return null;

  const nothingRecorded =
    !counts.recordings && !counts.photos && area.completionStatus !== 'SKIPPED';
  const blocked = counts.unreviewedFindings
    ? `Decide the ${counts.unreviewedFindings} finding${counts.unreviewedFindings === 1 ? '' : 's'} awaiting review first`
    : nothingRecorded
      ? 'Nothing was recorded in this area'
      : null;
  return (
    <div className={cn('grid gap-1', align === 'end' ? 'justify-items-end' : 'justify-items-start')}>
      <Button
        disabled={Boolean(blocked)}
        onClick={() => mark.mutate({ areaId: area.id, reviewed: true })}
        size="sm"
        type="button"
        variant="outline"
      >
        <CheckIcon aria-hidden />
        {review ? 'Review again' : 'Mark reviewed'}
      </Button>
      {blocked ? (
        <span className="text-muted-foreground text-xs">{blocked}</span>
      ) : review ? (
        // A mark that newer evidence has overtaken: say whose, so the reviewer
        // knows what they are catching up with.
        <span className="text-muted-foreground text-xs">
          New evidence since it was reviewed{by}
        </span>
      ) : null}
      {mark.error ? <span className="text-destructive text-xs">{mark.error.message}</span> : null}
    </div>
  );
}
