'use client';

import type { AiEvaluationRun, AiEvaluationRunSummary } from '@texasrenters/shared';
import { useState } from 'react';

import { ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { outOf, rejectReasonRow, runRulesLabel } from '@/lib/ai-guidance';
import { formatCount, formatDateTime, humanize } from '@/lib/format';
import { useAiEvaluation, useAiEvaluations } from '@/lib/queries';

/** One measure of a run: what it counts, the number, and which way is better. */
function Measure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
      <dd className="text-muted-foreground text-xs">{hint}</dd>
    </div>
  );
}

/**
 * The AI measured against the office's own decisions: each run analyses the
 * recent recordings the office decided under the rules tried, and says what it
 * found again, what it missed, which rejected findings it would raise again,
 * and whether it cites the moment a reviewer confirmed. Two runs on different
 * rules, side by side, are how a change is judged before it is saved.
 */
export function AiTestRuns() {
  const runs = useAiEvaluations();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test runs</CardTitle>
        <CardDescription>
          Each run analyses the most recent recordings the office has decided, under the rules
          tried, and scores the answer against those decisions. Nothing it finds is saved. Compare
          a draft&apos;s run with the saved rules&apos; before saving it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {runs.isLoading ? (
          <Skeleton className="h-24" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} retry={() => void runs.refetch()} />
        ) : runs.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {runs.data.map((run) => (
              <RunRow
                isOpen={open === run.id}
                key={run.id}
                onToggle={() => setOpen((current) => (current === run.id ? null : run.id))}
                run={run}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            No test runs yet. Use &ldquo;Test on recent recordings&rdquo; on the house rules to
            measure them.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RunRow({
  run,
  isOpen,
  onToggle,
}: {
  run: AiEvaluationRunSummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const totals = run.totals;
  return (
    <li aria-label={`Test run of ${formatDateTime(run.startedAt)}`} className="grid gap-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{runRulesLabel(run)}</p>
          <p className="text-muted-foreground text-xs">
            {formatDateTime(run.startedAt)}
            {run.startedByName ? ` · ${run.startedByName}` : ''}
            {run.modelId ? ` · ${run.modelId}` : ''} · prompt {run.promptVersion} ·{' '}
            {formatCount(run.tokens)} tokens
          </p>
        </div>
        {run.status === 'RUNNING' ? (
          <Badge variant="info">
            <Spinner />
            {run.completedCount} of {run.recordingCount} recordings
          </Badge>
        ) : run.status === 'FAILED' ? (
          <Badge variant="destructive">Failed</Badge>
        ) : (
          <Badge variant="secondary">{run.recordingCount} recordings</Badge>
        )}
      </div>

      {run.status === 'RUNNING' ? (
        <Progress
          aria-label="Test run progress"
          value={(run.completedCount / Math.max(1, run.recordingCount)) * 100}
        />
      ) : null}
      {run.status === 'FAILED' && run.error ? (
        <p className="text-destructive text-sm">{run.error}</p>
      ) : null}

      {totals ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Measure
            hint="Of the findings the office kept. Higher is better."
            label="Found again"
            value={outOf(totals.found, totals.kept)}
          />
          <Measure
            hint="Rejected findings it would raise again. Lower is better."
            label="False alarms repeated"
            value={outOf(totals.repeated, totals.rejected)}
          />
          <Measure
            hint="Findings nobody has decided: for a reviewer to judge."
            label="New findings"
            value={formatCount(totals.added)}
          />
          <Measure
            hint="Cites the moment a reviewer confirmed, within 5 seconds."
            label="On the moment"
            value={outOf(totals.onTime, totals.timed)}
          />
        </dl>
      ) : null}
      {totals?.failed ? (
        <p className="text-muted-foreground text-xs">
          {totals.failed} of {totals.recordings} recordings could not be analysed; they are left
          out of the counts.
        </p>
      ) : null}

      {run.completedCount ? (
        <div>
          <Button aria-expanded={isOpen} onClick={onToggle} size="sm" type="button" variant="outline">
            {isOpen ? 'Hide recordings' : 'Show each recording'}
          </Button>
        </div>
      ) : null}
      {isOpen ? <RunDetail id={run.id} /> : null}
    </li>
  );
}

function RunDetail({ id }: { id: string }) {
  const run = useAiEvaluation(id);
  if (run.isLoading) return <Skeleton className="h-24" />;
  if (run.isError) return <ErrorState error={run.error} retry={() => void run.refetch()} />;
  if (!run.data) return null;
  return <RunResults run={run.data} />;
}

/** Each recording's score, with the titles behind the numbers. */
export function RunResults({ run }: { run: AiEvaluationRun }) {
  return (
    <Table aria-label="Each recording in the test run">
      {/* A short table inside a card: no sticky header to pin. */}
      <TableHeader className="lg:static">
        <TableRow>
          <TableHead>Recording</TableHead>
          <TableHead>Found again</TableHead>
          <TableHead>Missed</TableHead>
          <TableHead>False alarms repeated</TableHead>
          <TableHead className="text-right">New</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {run.results.map((result) => (
          <TableRow key={result.mediaId}>
            <TableCell className="align-top whitespace-normal">
              <p className="font-medium">{result.roomName}</p>
              <p className="text-muted-foreground text-xs">
                {[result.propertyName, humanize(result.inspectionType)].filter(Boolean).join(' · ')}
              </p>
            </TableCell>
            {result.score ? (
              <>
                <TableCell className="align-top tabular-nums">
                  {result.score.found} of {result.score.kept}
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  {result.score.missed.length ? (
                    <ul className="grid gap-0.5 text-xs">
                      {result.score.missed.map((finding) => (
                        <li key={finding.id}>{finding.title}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-muted-foreground text-xs">None</span>
                  )}
                </TableCell>
                <TableCell className="align-top whitespace-normal">
                  {result.score.repeated.length ? (
                    <ul className="grid gap-0.5 text-xs">
                      {result.score.repeated.map((finding) => (
                        <li key={finding.id}>
                          {finding.title}
                          {finding.reasonCode ? (
                            <span className="text-muted-foreground">
                              {' '}
                              · rejected as {rejectReasonRow(finding.reasonCode).toLowerCase()}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-muted-foreground text-xs">None</span>
                  )}
                </TableCell>
                <TableCell className="text-right align-top tabular-nums">
                  {result.score.added.length}
                </TableCell>
              </>
            ) : (
              <TableCell className="text-destructive align-top text-xs whitespace-normal" colSpan={4}>
                {result.error ?? 'Could not be analysed.'}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
