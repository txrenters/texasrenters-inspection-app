'use client';

import type { AreaChecklistEntry } from '@texasrenters/shared';
import { CheckIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useRecordChecklistItem } from '@/lib/queries';

/** The three axes the printed report scores, in the order it prints them. */
const AXES = [
  { key: 'isClean', label: 'Clean' },
  { key: 'isUndamaged', label: 'Undamaged' },
  { key: 'isWorking', label: 'Working' },
] as const;

type AxisKey = (typeof AXES)[number]['key'];

/** Seconds as m:ss, the form a video scrubber shows. */
function timecode(total: number) {
  const minutes = Math.floor(total / 60);
  return `${minutes}:${Math.floor(total % 60).toString().padStart(2, '0')}`;
}

/**
 * One axis as a three-state control.
 *
 * Yes / No / unassessed, not a checkbox. A checkbox cannot say "I did not
 * assess this", so an item the reviewer skipped would be indistinguishable from
 * one they found faulty — and the report prints those cells blank precisely
 * because the distinction matters.
 *
 * Clicking the active value clears it, so a misclick is recoverable without a
 * separate reset control.
 */
function AxisControl({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (next: boolean | null) => void;
  value: boolean | null;
}) {
  return (
    <div
      aria-label={label}
      className="flex gap-1"
      role="radiogroup"
    >
      {[true, false].map((option) => {
        const active = value === option;
        const Icon = option ? CheckIcon : XIcon;
        return (
          <Button
            aria-checked={active}
            aria-label={`${label}: ${option ? 'yes' : 'no'}`}
            className={cn(
              'size-8',
              // `text-brand`, not `text-brand-foreground`. The -foreground token
              // is the colour meant to sit *on* a solid brand fill, and it is a
              // very dark green (oklch L=0.236) for exactly that reason. Painted
              // as text over a 15% tint on a dark card it was invisible, so a
              // "yes" rendered as an empty box while "no" — which correctly used
              // `text-destructive`, the colour itself — showed up red.
              //
              // Every all-yes row therefore looked unanswered, and the header
              // still counted it as assessed. The stored data was right the whole
              // time; only this one token was wrong.
              active &&
                (option
                  ? 'border-brand bg-brand/15 text-brand hover:bg-brand/20'
                  : 'border-destructive bg-destructive/10 text-destructive hover:bg-destructive/15'),
            )}
            disabled={disabled}
            key={String(option)}
            onClick={() => onChange(active ? null : option)}
            role="radio"
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The area's checklist, scored during review.
 *
 * Moved here from the technician's device deliberately: the reviewer is the one
 * reading the recording and the photographs, and each axis is a judgement about
 * evidence already on screen. The items are the same rows the coverage
 * checklist uses, so what a technician was asked to cover and what a reviewer
 * scores can never drift apart.
 */
export function AreaConditionChecklist({
  areaId,
  canReview,
  checklist,
  inspectionId,
  onSeek,
  readOnlyReason,
}: {
  areaId: string;
  canReview: boolean;
  checklist: AreaChecklistEntry[];
  inspectionId: string;
  /** Jumps the area's recording to a moment, when a player is mounted. */
  onSeek?: (seconds: number) => void;
  /** Set when scoring is refused — a finalized inspection, or no permission. */
  readOnlyReason?: string;
}) {
  const record = useRecordChecklistItem(inspectionId, areaId);
  const pendingItemId = record.isPending ? record.variables?.itemId : undefined;
  const assessed = checklist.filter(
    (item) => item.isClean !== null || item.isUndamaged !== null || item.isWorking !== null,
  ).length;

  if (!checklist.length)
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Condition checklist</CardTitle>
          <CardDescription>
            This area has no checklist items yet. Add them from the property&apos;s area list.
          </CardDescription>
        </CardHeader>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Condition checklist</CardTitle>
        <CardDescription>
          {assessed} of {checklist.length} assessed
          {readOnlyReason ? ` · ${readOnlyReason}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            {/* `lg:static`, overriding the sticky default.
                `TableHeader` pins itself below the app header, which is right
                for a full-page list and wrong for a table sitting inside a card
                partway down a page: the header detaches from its own table and
                rides over the rows as the card scrolls past. This one is short
                and always fully visible, so there is nothing for stickiness to
                buy here either. */}
            <TableHeader className="lg:static">
              <TableRow className="hover:bg-transparent">
                <TableHead>Item</TableHead>
                {AXES.map((axis) => (
                  <TableHead className="w-24 text-center" key={axis.key} scope="col">
                    {axis.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {checklist.map((item) => (
                <TableRow key={item.itemId}>
                  <TableCell className="font-normal" scope="row">
                    {item.label}
                    {item.comment ? (
                      <span className="text-muted-foreground block text-xs">{item.comment}</span>
                    ) : null}
                    {/* The moment in the walkthrough when the technician
                        answered. This is the point of capturing it: it turns an
                        hour of video into a list of places worth looking. */}
                    {item.videoTimestampSeconds === null ? null : onSeek ? (
                      <button
                        className="text-muted-foreground hover:text-foreground mt-0.5 block text-xs tabular-nums underline underline-offset-2"
                        onClick={() => onSeek(item.videoTimestampSeconds!)}
                        type="button"
                      >
                        {timecode(item.videoTimestampSeconds)} in the walkthrough
                      </button>
                    ) : (
                      // No walkthrough to seek — the moment is still worth
                      // showing, but as text rather than a control that would
                      // do nothing when pressed.
                      <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
                        {timecode(item.videoTimestampSeconds)} in the walkthrough
                      </span>
                    )}
                  </TableCell>
                  {AXES.map((axis) => (
                    <TableCell key={axis.key}>
                      <div className="flex justify-center">
                        <AxisControl
                          disabled={!canReview || Boolean(readOnlyReason) || record.isPending}
                          label={`${item.label} ${axis.label}`}
                          onChange={(next) =>
                            record.mutate({
                              itemId: item.itemId,
                              // The whole assessment every time: this is a PUT,
                              // so sending one axis would clear the other two.
                              isClean: axis.key === 'isClean' ? next : item.isClean,
                              isUndamaged: axis.key === 'isUndamaged' ? next : item.isUndamaged,
                              isWorking: axis.key === 'isWorking' ? next : item.isWorking,
                              comment: item.comment,
                            })
                          }
                          value={item[axis.key as AxisKey]}
                        />
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {pendingItemId ? (
          <p className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-xs">
            <Spinner className="size-3" />
            Saving…
          </p>
        ) : null}
        {record.error ? (
          <p className="text-destructive px-4 py-2 text-xs">{record.error.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
