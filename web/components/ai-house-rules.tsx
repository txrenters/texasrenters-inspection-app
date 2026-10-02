'use client';

import type { AiAnalysisPreview, AiGuidanceSample } from '@texasrenters/shared';
import { MAX_AI_GUIDANCE_LENGTH } from '@texasrenters/shared';
import { useEffect, useRef, useState } from 'react';

import { ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  comparePreview,
  HOUSE_RULES_TEMPLATE,
  officeDecision,
  previewVerdict,
} from '@/lib/ai-guidance';
import { formatSeconds } from '@/lib/finding-review';
import { formatCount, formatDate, formatRelative, humanize } from '@/lib/format';
import { useAiGuidance, useAiGuidanceMutations, useAiGuidanceSamples } from '@/lib/queries';

/**
 * The office's house rules for the AI: what counts as damage, normal wear and
 * cleaning here. Given to every analysis of a recording and to the AI's look at
 * the video, kept in versions, and tried on a real recording before saving.
 */
export function AiHouseRules({ canConfigure }: { canConfigure: boolean }) {
  const guidance = useAiGuidance();
  const { save, preview } = useAiGuidanceMutations();
  const saved = guidance.data?.current.text ?? '';
  const version = guidance.data?.current.version ?? 0;
  // From the rules already cached, when the page is opened again.
  const [text, setText] = useState(saved);
  const [trying, setTrying] = useState(false);

  // The editor starts from the rules in use and follows them when they change,
  // unless it holds unsaved edits: a colleague saving a version must not wipe
  // a draft being written here. Saving the draft then makes a version of its
  // own, and both stay in the history.
  const synced = useRef(saved);
  useEffect(() => {
    const previous = synced.current;
    synced.current = saved;
    setText((current) => (current.trim() === previous.trim() ? saved : current));
  }, [saved, version]);

  const changed = text.trim() !== saved.trim();
  const latest = guidance.data?.versions[0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>House rules for the AI</CardTitle>
        <CardDescription>
          What counts as damage, normal wear and cleaning at TexasRenters, in the office&apos;s
          words. The AI reads them with every recording it analyses. They decide how it judges, never
          what it may do: every finding stays a suggestion for review.
        </CardDescription>
        <CardAction>
          {version ? (
            <Badge variant="secondary">Version {version}</Badge>
          ) : (
            <Badge variant="outline">No rules yet</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {guidance.isLoading ? (
          <Skeleton className="h-40" />
        ) : guidance.isError ? (
          <ErrorState error={guidance.error} retry={() => void guidance.refetch()} />
        ) : (
          <>
            <Textarea
              aria-label="House rules"
              className="min-h-56 font-mono text-xs leading-relaxed"
              disabled={!canConfigure || save.isPending}
              maxLength={MAX_AI_GUIDANCE_LENGTH}
              onChange={(event) => setText(event.target.value)}
              placeholder={HOUSE_RULES_TEMPLATE}
              value={text}
            />
            <div className="flex flex-wrap items-center gap-2">
              {canConfigure ? (
                <>
                  <Button
                    disabled={!changed || save.isPending}
                    onClick={() => save.mutate(text)}
                    size="sm"
                    type="button"
                  >
                    {save.isPending ? <Spinner /> : null}
                    {save.isPending ? 'Saving…' : `Save as version ${version + 1}`}
                  </Button>
                  {changed ? (
                    <Button
                      disabled={save.isPending}
                      onClick={() => setText(saved)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Discard changes
                    </Button>
                  ) : null}
                  {!text.trim() ? (
                    <Button
                      onClick={() => setText(HOUSE_RULES_TEMPLATE)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Start from the example
                    </Button>
                  ) : null}
                  <Button
                    aria-expanded={trying}
                    onClick={() => setTrying((open) => !open)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {trying ? 'Hide the trial' : 'Try on a recording'}
                  </Button>
                </>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Only people who configure the AI can change these.
                </p>
              )}
              <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                {formatCount(text.length)} / {formatCount(MAX_AI_GUIDANCE_LENGTH)}
              </span>
            </div>
            {latest ? (
              <p className="text-muted-foreground text-xs">
                Version {latest.version} saved {formatRelative(latest.createdAt)}
                {latest.createdByName ? ` by ${latest.createdByName}` : ''}.
                {guidance.data && guidance.data.versions.length > 1
                  ? ` ${guidance.data.versions.length - 1} earlier ${
                      guidance.data.versions.length === 2 ? 'version' : 'versions'
                    } kept, so the scorecard can compare them.`
                  : ''}
              </p>
            ) : null}
            {save.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            ) : null}
            {trying && canConfigure ? (
              <RulesTrial
                error={preview.error?.message}
                onTry={(mediaId) => preview.mutate({ mediaId, houseRules: text })}
                pending={preview.isPending}
                pendingFor={preview.isPending ? preview.variables?.mediaId : undefined}
                result={preview.data}
              />
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function sampleLabel(sample: AiGuidanceSample) {
  return [sample.roomName, sample.propertyName, humanize(sample.inspectionType)]
    .filter(Boolean)
    .join(' · ');
}

/** Run the analysis on one recording the office has decided, under the rules as typed. */
function RulesTrial({
  onTry,
  pending,
  pendingFor,
  result,
  error,
}: {
  onTry: (mediaId: string) => void;
  pending: boolean;
  pendingFor?: string;
  result?: AiAnalysisPreview;
  error?: string;
}) {
  const samples = useAiGuidanceSamples(true);
  return (
    <section aria-label="Try the rules on a recording" className="grid gap-3 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">
        Runs the AI on a recording the office has already decided, with the rules as they are typed
        above, and sets what it would find beside what was decided. Nothing is saved; it costs one
        analysis, a few cents.
      </p>
      {samples.isLoading ? (
        <Skeleton className="h-24" />
      ) : samples.isError ? (
        <ErrorState error={samples.error} retry={() => void samples.refetch()} />
      ) : samples.data?.length ? (
        <ul className="grid max-h-56 gap-1 overflow-y-auto">
          {samples.data.map((sample) => (
            <li
              className="hover:bg-muted/50 flex items-center gap-2 rounded-md px-2 py-1"
              key={sample.mediaId}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{sampleLabel(sample)}</p>
                <p className="text-muted-foreground text-xs">
                  {formatDate(sample.recordedAt)} · {sample.findings}{' '}
                  {sample.findings === 1 ? 'finding' : 'findings'}
                </p>
              </div>
              <Button
                aria-label={`Try the rules on ${sampleLabel(sample)}`}
                disabled={pending}
                onClick={() => onTry(sample.mediaId)}
                size="sm"
                type="button"
                variant="outline"
              >
                {pendingFor === sample.mediaId ? <Spinner /> : null}
                {pendingFor === sample.mediaId ? 'Running…' : 'Try'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          No recording has decided findings yet. Review one inspection&apos;s findings, then try
          the rules on it.
        </p>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {result && !pending ? <TrialResult result={result} /> : null}
    </section>
  );
}

function moment(start: number, end: number) {
  if (!start && !end) return null;
  return end > start ? `${formatSeconds(start)}–${formatSeconds(end)}` : formatSeconds(start);
}

/**
 * A finding the draft no longer makes is good news when the office rejected
 * it and a warning when the office kept it, so the two do not look alike.
 */
function droppedBadge(finding: AiAnalysisPreview['current'][number], dropped: boolean) {
  if (!dropped) return null;
  if (finding.reviewStatus === 'REJECTED')
    return { label: 'Gone in the draft', variant: 'success' as const };
  if (finding.reviewStatus === 'APPROVED' || finding.reviewStatus === 'EDITED')
    return { label: 'Missed by the draft', variant: 'warning' as const };
  return { label: 'Not in the draft', variant: 'outline' as const };
}

function TrialResult({ result }: { result: AiAnalysisPreview }) {
  const comparison = comparePreview(result);
  return (
    <div aria-label="Trial result" className="grid gap-3" role="region">
      <p className="text-sm font-medium">
        {result.roomName}: {previewVerdict(comparison)}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="grid content-start gap-1">
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Found now · as the office decided
          </p>
          {[...comparison.matched.map((pair) => pair.current), ...comparison.dropped].map(
            (finding) => {
              const gone = droppedBadge(finding, comparison.dropped.includes(finding));
              return (
                <div className="rounded-md border px-2 py-1" key={finding.id}>
                  <p className="text-sm">
                    {finding.title}
                    {gone ? (
                      <Badge className="ml-2" variant={gone.variant}>
                        {gone.label}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {officeDecision(finding)} · {humanize(finding.severity)}
                  </p>
                </div>
              );
            },
          )}
          {!result.current.length ? (
            <p className="text-muted-foreground text-xs">No findings now.</p>
          ) : null}
        </div>
        <div className="grid content-start gap-1">
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            With these rules · draft
          </p>
          {[...comparison.matched.map((pair) => pair.draft), ...comparison.added].map(
            (finding, index) => {
              const fresh = comparison.added.includes(finding);
              const at = moment(finding.videoTimestampStart, finding.videoTimestampEnd);
              return (
                <div className="rounded-md border px-2 py-1" key={`${index}-${finding.title}`}>
                  <p className="text-sm">
                    {finding.title}
                    {fresh ? (
                      <Badge className="ml-2" variant="info">
                        New
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {humanize(finding.findingType)} · {humanize(finding.severity)}
                    {at ? ` · ${at}` : ''}
                  </p>
                </div>
              );
            },
          )}
          {!result.draft.length ? (
            <p className="text-muted-foreground text-xs">No findings under the draft.</p>
          ) : null}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {result.modelId} · {formatCount(result.tokens)} tokens. Findings are matched by title, so
        a reworded finding can show as one dropped and one new.
      </p>
    </div>
  );
}
