import { CheckCircle2Icon, InfoIcon, Loader2Icon, SparklesIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { Finding, InspectionRoom } from '../domain/models';
import { AI_REVIEW_DISCLAIMER, describeConfidence } from '../utils/ai-review';
import { registerIcons } from '../lib/icons';

registerIcons(CheckCircle2Icon, InfoIcon, Loader2Icon, SparklesIcon);

/**
 * The AI's narrative summary of one room.
 *
 * Deliberately distinguishes "not analyzed yet" from "analyzed, nothing to
 * report". Rendering nothing in both cases would leave a technician unsure
 * whether the pipeline had run at all, and tempted to re-record a room that was
 * already fine.
 */
export function AiSummaryCard({
  summary,
  processingStatus,
  confirmedAt,
  onConfirm,
  confirming = false,
}: {
  /** The summary finding for this room, or undefined if none exists yet. */
  summary?: Finding;
  processingStatus: InspectionRoom['processingStatus'];
  /** When the technician attested this matches the area; undefined if not yet. */
  confirmedAt?: string;
  /** Omitted on read-only surfaces, which then show state without an action. */
  onConfirm?: () => void;
  confirming?: boolean;
}) {
  const analyzing =
    !summary && processingStatus !== 'READY_FOR_REVIEW' && processingStatus !== 'FAILED';
  const failed = !summary && processingStatus === 'FAILED';

  return (
    <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
      <View className="flex-row items-center gap-2">
        <SparklesIcon size={17} className="text-primary" />
        <Text className="text-base font-semibold text-foreground">AI room summary</Text>
      </View>

      {summary ? (
        <>
          <Text className="mt-3 text-sm leading-6 text-foreground">{summary.observation}</Text>
          {(() => {
            const confidence = describeConfidence(summary.confidence);
            return confidence.needsVerification ? (
              <Text className="mt-2.5 text-xs leading-5 text-chart-4">
                {confidence.label} ({confidence.percent}%) — read this as a prompt to look again,
                not a conclusion.
              </Text>
            ) : null;
          })()}
        </>
      ) : analyzing ? (
        <View className="mt-3 flex-row items-center gap-2">
          <Loader2Icon size={15} className="text-muted-foreground" />
          <Text className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
            Analysis is still running. The summary appears here once the recording finishes
            processing — you can keep working.
          </Text>
        </View>
      ) : failed ? (
        <Text className="mt-3 text-sm leading-6 text-chart-4">
          Analysis could not be completed for this area. Your recording and photos are still saved,
          and the office can review them directly.
        </Text>
      ) : (
        <Text className="mt-3 text-sm leading-6 text-muted-foreground">
          No summary was produced for this area.
        </Text>
      )}

      {/* Confirmation is only offered once there is something to confirm.
          Showing the control while analysis runs would invite a technician to
          vouch for text they have not read.

          What this attests is deliberately narrow: that the description matches
          the room they walked. Approving, rejecting or editing the findings
          themselves is an administrator decision, and no control here — or on
          any technician screen — can reach it. */}
      {summary ? (
        confirmedAt ? (
          <View className="mt-4 flex-row items-center gap-2 border-t border-border pt-3">
            <CheckCircle2Icon size={15} className="text-chart-3" />
            <Text className="min-w-0 flex-1 text-xs font-semibold leading-5 text-chart-3">
              You confirmed this summary matches the area
            </Text>
          </View>
        ) : onConfirm ? (
          <>
            <Pressable
              accessibilityLabel="Confirm this summary matches the area"
              accessibilityRole="button"
              accessibilityState={{ busy: confirming, disabled: confirming }}
              className="mt-4 min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-primary py-3 active:opacity-80"
              disabled={confirming}
              onPress={onConfirm}
            >
              {confirming ? (
                <Loader2Icon size={16} className="text-primary-foreground" />
              ) : (
                <CheckCircle2Icon size={16} className="text-primary-foreground" />
              )}
              <Text className="font-semibold text-primary-foreground">
                {confirming ? 'Confirming…' : 'Confirm summary'}
              </Text>
            </Pressable>
            <Text className="mt-2 text-center text-xs leading-5 text-muted-foreground">
              Confirm that this describes what you saw. The office reviews the findings.
            </Text>
          </>
        ) : null
      ) : null}

      {summary ? (
        <View className="mt-4 flex-row items-start gap-2.5 border-t border-border pt-3">
          <InfoIcon size={14} className="mt-0.5 text-muted-foreground" />
          <Text className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
            {AI_REVIEW_DISCLAIMER}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
