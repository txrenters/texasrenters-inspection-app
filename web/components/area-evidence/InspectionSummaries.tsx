'use client';

import {
  RECORDING_ACTION_GROUPS,
  RECORDING_ACTION_HEADING,
  type InspectionRecordingSummaries,
} from '@texasrenters/shared';
import { SparklesIcon } from 'lucide-react';

import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { usePermissions } from '@/lib/auth';
import {
  useInspectionRecordingSummaries,
  useSummarizeAreaRecordings,
  useSummarizeInspectionRecordings,
} from '@/lib/queries';
import { cn } from '@/lib/utils';

import { RecordingSummaryBody } from './RecordingSummaryCard';

type SummaryArea = InspectionRecordingSummaries['areas'][number];

/**
 * "Summaries of all areas" (the maintenance team, 2026-10-07): every room's
 * summary on one page, in walk order, with the timestamped points the report
 * leaves out -- and, first, everything the property needs, gathered from every
 * room under the office's three headings, so the work can be read in one go.
 */
export function InspectionSummaries({ inspectionId }: { inspectionId: string }) {
  const query = useInspectionRecordingSummaries(inspectionId);
  const every = useSummarizeInspectionRecordings(inspectionId);
  const canManage = usePermissions().has('inspections:manage');

  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <PageSkeleton cards={3} />;

  const recorded = query.data.areas.filter((area) => area.recorded || area.summary);
  const unrecorded = query.data.areas.filter((area) => !area.recorded && !area.summary);
  const summarized = recorded.filter((area) => area.summary?.current).length;

  if (!recorded.length)
    return (
      <EmptyState
        description="No room of this inspection has a transcribed recording yet, so there is nothing to summarize."
        title="No recordings to summarize"
      />
    );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {summarized} of {recorded.length} recorded areas summarized
          </CardTitle>
          <CardDescription>
            Written by AI from each room’s recordings. The shared report prints each action in
            the room’s Comments column, beside the item it is about.
          </CardDescription>
        </CardHeader>
        {canManage ? (
          <CardContent className="space-y-2">
            <Button disabled={every.isPending} onClick={() => every.mutate()} size="sm" type="button" variant="outline">
              {every.isPending ? <Spinner className="size-3" /> : <SparklesIcon />}
              Summarize every room
            </Button>
            {every.error || every.data ? (
              <p className={cn('text-xs', every.error ? 'text-destructive' : 'text-muted-foreground')}>
                {every.error
                  ? every.error.message
                  : every.data!.queued
                    ? `Summarizing ${every.data!.areas} rooms. Each one appears here as it finishes, within a couple of minutes.`
                    : 'Every room is already being summarized.'}
              </p>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <PropertyNeeds areas={recorded} />

      <div className="space-y-4">
        {recorded.map((area) => (
          <AreaSummary
            area={area}
            canManage={canManage}
            inspectionId={inspectionId}
            key={area.inspectionAreaId}
          />
        ))}
      </div>

      {unrecorded.length ? (
        <p className="text-muted-foreground text-sm">
          No recording: {unrecorded.map((area) => area.name).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

/** Everything the property needs, from every current summary, room by room under each heading. */
function PropertyNeeds({ areas }: { areas: SummaryArea[] }) {
  const groups = RECORDING_ACTION_GROUPS.map((group) => ({
    group,
    rooms: areas
      .filter((area) => area.summary?.current)
      .map((area) => ({
        name: area.name,
        items: area.summary!.actions.find((entry) => entry.group === group)?.items ?? [],
      }))
      .filter((room) => room.items.length > 0),
  })).filter((entry) => entry.rooms.length > 0);
  if (!groups.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Everything the property needs</CardTitle>
        <CardDescription>Gathered from every summarized room.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {groups.map((entry) => (
          <div className="space-y-2" key={entry.group}>
            <p className="font-semibold">{RECORDING_ACTION_HEADING[entry.group]}</p>
            {entry.rooms.map((room) => (
              <div key={room.name}>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {room.name}
                </p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {room.items.map((item, index) => (
                    <li key={index}>
                      {item.text}
                      {item.details.length ? (
                        <ul className="list-[circle] pl-5">
                          {item.details.map((detail, detailIndex) => (
                            <li key={detailIndex}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AreaSummary({
  area,
  canManage,
  inspectionId,
}: {
  area: SummaryArea;
  canManage: boolean;
  inspectionId: string;
}) {
  const summarize = useSummarizeAreaRecordings(inspectionId, area.inspectionAreaId);
  const state = !area.summary ? 'Not summarized' : area.summary.current ? 'Summarized' : 'Out of date';
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base tracking-wide uppercase">{area.name}</CardTitle>
          {area.floorName ? <CardDescription>{area.floorName}</CardDescription> : null}
        </div>
        <Badge variant={state === 'Summarized' ? 'success' : 'secondary'}>{state}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {area.summary ? (
          <RecordingSummaryBody summary={area.summary} />
        ) : (
          <p className="text-muted-foreground text-sm">
            This room’s recordings have not been summarized yet.
          </p>
        )}
        {area.summary && !area.summary.current ? (
          <p className="text-muted-foreground text-xs">
            {area.summary.staleReason === 'FORMAT'
              ? 'Written before actions were tied to checklist items. Summarize again to put them in the report’s Comments column.'
              : 'A recording arrived after this summary was written. Summarize again to update the report.'}
          </p>
        ) : null}
        {canManage && area.recorded ? (
          <div className="space-y-1">
            <Button
              disabled={summarize.isPending}
              onClick={() => summarize.mutate()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {summarize.isPending ? <Spinner className="size-3" /> : <SparklesIcon />}
              {area.summary ? 'Summarize again' : 'Summarize this room'}
            </Button>
            {summarize.error ? (
              <p className="text-destructive text-xs">{summarize.error.message}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
