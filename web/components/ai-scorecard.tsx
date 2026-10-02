'use client';

import type { AiScorecard as Scorecard, AiScoreTally } from '@texasrenters/shared';
import { useState } from 'react';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { decidedShares, rejectReasonRow } from '@/lib/ai-guidance';
import { formatCount } from '@/lib/format';
import { useAiScorecard } from '@/lib/queries';
import { cn } from '@/lib/utils';

const WINDOWS = [30, 90, 180] as const;

function percent(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '–';
}

/** One number with what it counts, in the scorecard's top row. */
function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="text-muted-foreground text-xs">{note}</dd> : null}
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
      {children}
    </h3>
  );
}

function TallyLine({ label, tally }: { label: string; tally: AiScoreTally }) {
  const shares = decidedShares(tally);
  return (
    <p className="text-sm">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">
        {' '}
        · {formatCount(tally.findings)} findings · {shares.kept}% kept · {shares.corrected}%
        corrected · {shares.rejected}% rejected
        {tally.pending ? ` · ${formatCount(tally.pending)} waiting` : ''}
      </span>
    </p>
  );
}

/**
 * How the AI's findings fared with the office, from the decisions people
 * already made: nothing is re-run to produce it. The way to judge a change to
 * the house rules is the "By version" rows after enough rooms ran under it.
 */
export function AiScorecard() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(90);
  const scorecard = useAiScorecard(days);

  return (
    <Card>
      <CardHeader>
        <CardTitle>How the AI is doing</CardTitle>
        <CardDescription>
          The AI&apos;s findings against what reviewers decided: kept as written, corrected, or
          rejected and why. Room summaries are left out.
        </CardDescription>
        <CardAction>
          <div aria-label="Scorecard period" className="bg-muted flex gap-1 rounded-lg p-1" role="group">
            {WINDOWS.map((window) => (
              <Button
                aria-pressed={days === window}
                className={cn('h-7 px-2 text-xs', days !== window && 'text-muted-foreground')}
                key={window}
                onClick={() => setDays(window)}
                size="sm"
                type="button"
                variant={days === window ? 'default' : 'ghost'}
              >
                {window} days
              </Button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {scorecard.isLoading ? (
          <Skeleton className="h-48" />
        ) : scorecard.isError ? (
          <ErrorState error={scorecard.error} retry={() => void scorecard.refetch()} />
        ) : scorecard.data ? (
          <ScorecardBody data={scorecard.data} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScorecardBody({ data }: { data: Scorecard }) {
  const shares = decidedShares(data.totals);
  if (!data.totals.findings)
    return (
      <p className="text-muted-foreground text-sm">
        The AI made no findings in the last {data.window.days} days.
      </p>
    );
  const reasons = Object.entries(data.rejectReasons).sort((left, right) => right[1] - left[1]);
  const mostReasons = Math.max(1, ...reasons.map(([, count]) => count));

  return (
    <div className="grid gap-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Findings" value={formatCount(data.totals.findings)} />
        <Stat
          label="Kept as written"
          note={`${formatCount(data.totals.kept)} of ${formatCount(shares.decided)} decided`}
          value={`${shares.kept}%`}
        />
        <Stat
          label="Corrected"
          note={`${formatCount(data.totals.corrected)} approved with edits`}
          value={`${shares.corrected}%`}
        />
        <Stat
          label="Rejected"
          note={`${formatCount(data.totals.rejected)} findings`}
          value={`${shares.rejected}%`}
        />
        <Stat label="Waiting for review" value={formatCount(data.totals.pending)} />
      </dl>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="grid content-start gap-2">
          <SectionTitle>Why findings were rejected</SectionTitle>
          {reasons.length ? (
            <ul className="grid gap-1.5">
              {reasons.map(([code, count]) => (
                <li className="grid grid-cols-[9rem_1fr_2.5rem] items-center gap-2" key={code}>
                  <span className="truncate text-sm">{rejectReasonRow(code)}</span>
                  <Progress
                    aria-label={`${rejectReasonRow(code)}: ${count}`}
                    value={(count / mostReasons) * 100}
                  />
                  <span className="text-right text-sm tabular-nums">{formatCount(count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing rejected.</p>
          )}
        </section>

        <section className="grid content-start gap-2">
          <SectionTitle>Where findings came from</SectionTitle>
          {data.bySource.NARRATION ? (
            <TallyLine label="The technician's narration" tally={data.bySource.NARRATION} />
          ) : null}
          {data.bySource.AI_VISION ? (
            <TallyLine label="Spotted by the AI in the video" tally={data.bySource.AI_VISION} />
          ) : null}
          <p className="text-muted-foreground text-xs">
            {formatCount(data.timing.withMoment)} of {formatCount(data.timing.narration)} narrated
            findings ({percent(data.timing.withMoment, data.timing.narration)}) point to their moment
            in the recording.
          </p>
        </section>

        {data.visual.checked ? (
          <section className="grid content-start gap-2">
            <SectionTitle>Checking the video</SectionTitle>
            <p className="text-sm">
              {formatCount(data.visual.checked)} findings checked: {formatCount(data.visual.seen)}{' '}
              seen, {formatCount(data.visual.notSeen)} not seen, {formatCount(data.visual.unclear)}{' '}
              unclear.
            </p>
            <p className="text-muted-foreground text-xs">
              When the AI could not see a finding, reviewers rejected{' '}
              {formatCount(data.visual.notSeenRejected)} and kept{' '}
              {formatCount(data.visual.notSeenKept)}. Of those it saw,{' '}
              {formatCount(data.visual.seenRejected)} were rejected anyway.
            </p>
          </section>
        ) : null}

        {data.photos.offered ? (
          <section className="grid content-start gap-2">
            <SectionTitle>Suggested photographs</SectionTitle>
            <p className="text-sm">
              Offered for {formatCount(data.photos.offered)} findings:{' '}
              {formatCount(data.photos.accepted)} filed (
              {percent(data.photos.accepted, data.photos.offered)}),{' '}
              {formatCount(data.photos.allDismissed)} set aside.
            </p>
          </section>
        ) : null}
      </div>

      {data.byVersion.length ? (
        <section className="grid gap-2">
          <SectionTitle>By version</SectionTitle>
          <Table>
            {/* A short table inside a card: no sticky header to pin. */}
            <TableHeader className="lg:static">
              <TableRow>
                <TableHead>Prompt</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>House rules</TableHead>
                <TableHead className="text-right">Findings</TableHead>
                <TableHead className="text-right">Kept</TableHead>
                <TableHead className="text-right">Corrected</TableHead>
                <TableHead className="text-right">Rejected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byVersion.map((row) => {
                const rowShares = decidedShares(row);
                return (
                  <TableRow key={`${row.promptVersion}|${row.modelId}|${row.guidanceVersion ?? ''}`}>
                    <TableCell className="tabular-nums">{row.promptVersion}</TableCell>
                    <TableCell>{row.modelId}</TableCell>
                    <TableCell>
                      {row.guidanceVersion ? `Version ${row.guidanceVersion}` : 'None'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(row.findings)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{rowShares.kept}%</TableCell>
                    <TableCell className="text-right tabular-nums">{rowShares.corrected}%</TableCell>
                    <TableCell className="text-right tabular-nums">{rowShares.rejected}%</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      ) : null}

      {data.window.truncated ? (
        <p className="text-muted-foreground text-xs">
          Counted from the most recent 10,000 findings in the period.
        </p>
      ) : null}
    </div>
  );
}
