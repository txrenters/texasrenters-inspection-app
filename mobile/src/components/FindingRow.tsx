import { ChevronRightIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { Finding } from '../domain/models';
import { registerIcons } from '../lib/icons';
import {
  COMPARISON_LABELS,
  describeConfidence,
  findingTone,
  reviewStatusLabel,
  SEVERITY_LABELS,
  type FindingTone,
} from '../utils/ai-review';

registerIcons(ChevronRightIcon);

const TONE_DOT: Record<FindingTone, string> = {
  danger: 'bg-destructive',
  warning: 'bg-chart-4',
  info: 'bg-chart-1',
  neutral: 'bg-muted-foreground',
};

/**
 * One AI finding in a list, sized for a thumb.
 *
 * Leads with the comparison result rather than the severity: "possible new
 * damage" and "pre-existing condition" mean very different things to the person
 * standing in the room, and severity alone would flatten that distinction.
 */
export function FindingRow({
  finding,
  onPress,
  last,
}: {
  finding: Finding;
  onPress: () => void;
  last?: boolean;
}) {
  const tone = findingTone(finding);
  const confidence = describeConfidence(finding.confidence);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        finding.title,
        COMPARISON_LABELS[finding.comparisonResult],
        `${SEVERITY_LABELS[finding.severity]} severity`,
        confidence.label,
        reviewStatusLabel(finding.reviewStatus),
      ].join(', ')}
      accessibilityHint="Opens the full AI finding"
      className={`min-h-[56px] flex-row items-start gap-3 py-3 active:opacity-60 ${
        last ? '' : 'border-b border-border'
      }`}
      onPress={onPress}
    >
      <View className={`mt-1.5 h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={2}>
          {finding.title}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
          {COMPARISON_LABELS[finding.comparisonResult]} · {SEVERITY_LABELS[finding.severity]}{' '}
          severity
        </Text>
        <Text
          className={`mt-0.5 text-xs ${
            confidence.needsVerification ? 'text-chart-4' : 'text-muted-foreground'
          }`}
          numberOfLines={1}
        >
          {confidence.label} · {reviewStatusLabel(finding.reviewStatus)}
        </Text>
      </View>
      <ChevronRightIcon size={15} className="mt-1 text-muted-foreground" />
    </Pressable>
  );
}
