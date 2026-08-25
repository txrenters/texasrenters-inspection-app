import { RotateCwIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { Finding, ProcessingStatus } from '../domain/models';
import { Badge, Button } from '../components/ui';
import { FindingRow } from '../components/FindingRow';
import { registerIcons } from '../lib/icons';

registerIcons(RotateCwIcon);

/**
 * What the analysis made of this area.
 *
 * One card where there were two. "AI analysis" carried the status and "AI
 * findings" carried the results, and they are the same subject at two moments —
 * they were never both on screen, so the second was only ever a second heading
 * for the same thing. Two cards also meant a technician scanning the screen had
 * to work out which of them applied.
 *
 * The empty case is deliberately worded as an outcome rather than a blank. "No
 * findings" during processing would be a claim that nothing is wrong, which is
 * a very different and much more dangerous statement than "not analysed yet".
 */
export function AreaAnalysisCard({
  analysisPending,
  findings,
  onOpenFinding,
  onRetry,
  primaryMediaId,
  processingStatus,
  retryError,
  retrying,
}: {
  analysisPending?: boolean;
  findings: readonly Finding[];
  onOpenFinding: (findingId: string) => void;
  onRetry: (mediaId: string) => void;
  primaryMediaId: string | null;
  processingStatus: ProcessingStatus;
  retryError?: Error | null;
  retrying: boolean;
}) {
  const hasFindings = findings.length > 0;

  return (
    <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold text-foreground">Analysis</Text>
        {hasFindings ? (
          <Badge
            label={`${findings.length} finding${findings.length === 1 ? '' : 's'}`}
            tone="attention"
          />
        ) : analysisPending ? (
          <Badge label="Running" tone="active" />
        ) : null}
      </View>

      {hasFindings ? (
        findings.map((finding, index) => (
          <FindingRow
            finding={finding}
            key={finding.id}
            last={index === findings.length - 1}
            onPress={() => onOpenFinding(finding.id)}
          />
        ))
      ) : (
        <Text className="mt-1 text-sm leading-6 text-muted-foreground">
          {analysisPending
            ? 'Running now. Findings appear here on their own, usually within a minute.'
            : processingStatus === 'FAILED'
              ? 'Analysis could not be completed for this recording. Your video and photos are still saved.'
              : 'No findings were produced from this recording.'}
        </Text>
      )}

      {/* Offered only once analysis has stopped, and only when there is nothing
          to show for it: asking to re-run something already running would queue
          a second pass over the same recording, and re-running a pass that
          produced findings would throw them away. */}
      {!analysisPending && !hasFindings && primaryMediaId ? (
        <Button
          busy={retrying}
          busyLabel="Starting…"
          className="mt-4"
          icon={<RotateCwIcon size={16} className="text-primary" />}
          label="Run analysis again"
          onPress={() => onRetry(primaryMediaId)}
          variant="ghost"
        />
      ) : null}
      {retryError ? (
        <Text className="mt-2 text-xs leading-5 text-muted-foreground">{retryError.message}</Text>
      ) : null}
    </View>
  );
}
