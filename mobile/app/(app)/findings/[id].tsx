import { router, useLocalSearchParams } from 'expo-router';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClockIcon,
  EyeIcon,
  HistoryIcon,
  InfoIcon,
  ScaleIcon,
  SparklesIcon,
} from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useFinding } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import {
  AI_REVIEW_DISCLAIMER,
  COMPARISON_LABELS,
  describeConfidence,
  findingTone,
  formatTimestampRange,
  reviewStatusLabel,
  SEVERITY_LABELS,
  type FindingTone,
} from '@/src/utils/ai-review';

registerIcons(
  AlertTriangleIcon,
  ArrowLeftIcon,
  ClockIcon,
  EyeIcon,
  HistoryIcon,
  InfoIcon,
  ScaleIcon,
  SparklesIcon,
);

const TONE_TEXT: Record<FindingTone, string> = {
  danger: 'text-destructive',
  warning: 'text-chart-4',
  info: 'text-chart-1',
  neutral: 'text-muted-foreground',
};

const TONE_SURFACE: Record<FindingTone, string> = {
  danger: 'bg-destructive/10 border-destructive/20',
  warning: 'bg-chart-4/10 border-chart-4/20',
  info: 'bg-chart-1/10 border-chart-1/20',
  neutral: 'bg-muted border-border',
};

/** A labelled block of AI prose. Long text wraps rather than truncating. */
function DetailBlock({
  icon: Icon,
  label,
  value,
  emphasis,
}: {
  icon: typeof EyeIcon;
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <View className="mt-4">
      <View className="mb-1.5 flex-row items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </Text>
      </View>
      <Text
        className={`text-sm leading-6 ${emphasis ? 'font-medium text-foreground' : 'text-foreground'}`}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * One AI finding, in full, read-only.
 *
 * A technician can see everything the model produced and everything it compared
 * against, but cannot accept, edit or dismiss it — that decision belongs to an
 * authorized reviewer in the office. The screen states this outright rather
 * than merely omitting the buttons, so the absence never reads as a bug.
 */
export default function FindingDetailScreen() {
  const { id = '', inspectionId = '' } = useLocalSearchParams<{
    id: string;
    inspectionId?: string;
  }>();
  const finding = useFinding(id, inspectionId);

  if (finding.isLoading) {
    return (
      <SafeAreaView edges={['top']} className="flex-1 bg-background">
        <DetailSkeleton sections={3} />
      </SafeAreaView>
    );
  }

  if (!finding.data) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-6">
        <AlertTriangleIcon size={34} className="text-destructive" />
        <Text className="mt-4 text-xl font-bold text-foreground">Finding unavailable</Text>
        <Text className="mt-2 text-center text-sm leading-6 text-muted-foreground">
          {finding.error instanceof Error
            ? finding.error.message
            : 'This finding could not be loaded.'}
        </Text>
        <Pressable
          accessibilityLabel="Try loading this finding again"
          accessibilityRole="button"
          className="mt-5 min-h-12 justify-center rounded-xl bg-primary px-6 py-3 active:scale-[0.98]"
          onPress={() => void finding.refetch()}
        >
          <Text className="font-bold text-primary-foreground">Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const item = finding.data;
  const tone = findingTone(item);
  const confidence = describeConfidence(item.confidence);
  const timestamps = formatTimestampRange(item.videoTimestampStart, item.videoTimestampEnd);

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-95"
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
              AI Finding
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {item.roomName}
            </Text>
          </View>
        </View>

        <View className={`mx-5 mt-2 rounded-2xl border p-5 ${TONE_SURFACE[tone]}`}>
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {COMPARISON_LABELS[item.comparisonResult]}
          </Text>
          <Text className="mt-1.5 text-xl font-bold leading-7 text-foreground">{item.title}</Text>
          <View className="mt-3 flex-row flex-wrap items-center gap-2">
            <View className="rounded-full bg-background/70 px-3 py-1">
              <Text className={`text-xs font-semibold ${TONE_TEXT[tone]}`}>
                {SEVERITY_LABELS[item.severity]} severity
              </Text>
            </View>
            <View className="rounded-full bg-background/70 px-3 py-1">
              <Text className="text-xs font-semibold text-muted-foreground">{item.category}</Text>
            </View>
          </View>
        </View>

        {/* Confidence as a band, with an explicit instruction when the model is
            unsure — a bare percentage reads as more authoritative than it is. */}
        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-foreground">{confidence.label}</Text>
            <Text className="text-sm font-bold text-muted-foreground">{confidence.percent}%</Text>
          </View>
          <View className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <View
              className={`h-full rounded-full ${
                confidence.needsVerification ? 'bg-chart-4' : 'bg-chart-3'
              }`}
              style={{ width: `${Math.max(confidence.percent, 3)}%` }}
            />
          </View>
          {confidence.needsVerification ? (
            <Text className="mt-2.5 text-xs leading-5 text-chart-4">
              Verify this one yourself before relying on it. Add a photo or a note if what you see
              differs.
            </Text>
          ) : null}
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-center gap-2">
            <SparklesIcon size={16} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">What the AI reported</Text>
          </View>

          <DetailBlock
            emphasis
            icon={EyeIcon}
            label="Observed in this inspection"
            value={item.observation || 'No observation text was returned.'}
          />
          <DetailBlock
            icon={HistoryIcon}
            label="Baseline condition on file"
            value={item.baselineCondition || 'No baseline condition was recorded for this area.'}
          />
          <DetailBlock
            icon={ScaleIcon}
            label="Comparison"
            value={COMPARISON_LABELS[item.comparisonResult]}
          />
          {item.recommendedReview ? (
            <DetailBlock
              icon={InfoIcon}
              label="Recommended review"
              value={item.recommendedReview}
            />
          ) : null}
          {timestamps ? (
            <DetailBlock icon={ClockIcon} label="Seen in the walkthrough at" value={timestamps} />
          ) : null}
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Office review status
          </Text>
          <Text className="mt-1.5 text-base font-semibold text-foreground">
            {reviewStatusLabel(item.reviewStatus)}
          </Text>
          {item.reviewerNotes ? (
            <Text className="mt-2 text-sm leading-6 text-muted-foreground">
              {item.reviewerNotes}
            </Text>
          ) : null}
        </View>

        {/* Stated, not implied. A technician who finds no accept/dismiss control
            should understand it is by design and not a broken screen. */}
        <View
          accessibilityRole="summary"
          className="mx-5 mb-2 mt-4 flex-row items-start gap-3 rounded-2xl border border-border bg-muted p-4"
        >
          <InfoIcon size={17} className="mt-0.5 text-muted-foreground" />
          <Text className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
            {AI_REVIEW_DISCLAIMER}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
