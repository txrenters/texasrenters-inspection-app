import { AlertTriangleIcon, EyeIcon, InfoIcon, SparklesIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';
import { AI_REVIEW_DISCLAIMER } from '../utils/ai-review';
import {
  countByPriority,
  type AuditPriority,
  type PriorityItem,
  type SummaryCoverage,
} from '../utils/inspection-audit';

registerIcons(AlertTriangleIcon, EyeIcon, InfoIcon, SparklesIcon);

const BAND: Record<AuditPriority, { label: string; text: string; surface: string }> = {
  ACT_NOW: { label: 'Act now', text: 'text-destructive', surface: 'bg-destructive/10' },
  REVIEW: { label: 'Review', text: 'text-chart-4', surface: 'bg-chart-4/15' },
  MONITOR: { label: 'Monitor', text: 'text-muted-foreground', surface: 'bg-muted' },
};

/**
 * The AI audit as an ordered queue of attention, not a flat list.
 *
 * Findings were only ever shown grouped by area, so nothing told a technician
 * which of nineteen items mattered before they left the property. Missing or
 * insufficient evidence sorts to the top because it is the one class of problem
 * that is still fixable while they are standing there.
 */
export function PriorityAuditList({
  items,
  coverage,
  onOpenFinding,
  onOpenArea,
}: {
  items: PriorityItem[];
  coverage: SummaryCoverage;
  onOpenFinding: (findingId: string) => void;
  onOpenArea?: (roomId: string) => void;
}) {
  const counts = countByPriority(items);
  const [firstMissing] = coverage.missing;

  return (
    <View className="mt-6">
      <View className="mb-3 flex-row items-center gap-2 px-5">
        <SparklesIcon size={17} className="text-primary" />
        <Text className="text-lg font-semibold text-foreground">Priority audit</Text>
      </View>

      {/* The gap the pipeline could not report on itself: an area whose video
          processed but produced no summary looks identical to one the AI had
          nothing to say about. */}
      {coverage.missing.length && firstMissing ? (
        <View className="mx-5 mb-3 rounded-2xl border border-chart-4/30 bg-chart-4/10 p-4">
          <View className="flex-row items-center gap-2">
            <AlertTriangleIcon size={16} className="text-chart-4" />
            <Text className="font-semibold text-chart-4">
              {coverage.missing.length} area{coverage.missing.length === 1 ? '' : 's'} without an AI
              summary
            </Text>
          </View>
          <Text className="mt-1 text-xs leading-5 text-muted-foreground">
            {coverage.missing.map((area) => area.roomName).join(', ')} finished but produced no
            summary. The recording may still be processing, or its analysis failed.
          </Text>
          {onOpenArea ? (
            <Pressable
              accessibilityLabel={`Open ${firstMissing.roomName}`}
              accessibilityRole="button"
              className="mt-3 min-h-11 justify-center"
              onPress={() => onOpenArea(firstMissing.roomId)}
            >
              <Text className="text-sm font-semibold text-primary">
                Open {firstMissing.roomName}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {items.length ? (
        <>
          <View className="mb-3 flex-row gap-2 px-5">
            <Tally count={counts.actNow} priority="ACT_NOW" />
            <Tally count={counts.review} priority="REVIEW" />
            <Tally count={counts.monitor} priority="MONITOR" />
          </View>
          {items.map((item) => (
            <Pressable
              accessibilityHint="Opens this finding"
              accessibilityLabel={`${BAND[item.priority].label}. ${item.title}. ${item.roomName}. ${item.reason}`}
              accessibilityRole="button"
              className="mx-5 mb-2 min-h-14 flex-row items-center gap-3 rounded-xl bg-card p-4"
              key={item.findingId}
              onPress={() => onOpenFinding(item.findingId)}
            >
              <View
                importantForAccessibility="no-hide-descendants"
                className={`h-9 w-9 items-center justify-center rounded-full ${BAND[item.priority].surface}`}
              >
                {item.priority === 'ACT_NOW' ? (
                  <AlertTriangleIcon size={17} className={BAND[item.priority].text} />
                ) : item.priority === 'REVIEW' ? (
                  <EyeIcon size={17} className={BAND[item.priority].text} />
                ) : (
                  <InfoIcon size={17} className={BAND[item.priority].text} />
                )}
              </View>
              <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-sm font-semibold text-foreground">
                  {item.title}
                </Text>
                <Text numberOfLines={1} className="mt-0.5 text-xs text-muted-foreground">
                  {item.roomName} · {item.reason}
                </Text>
              </View>
              {/* Band in words as well as colour — the whole list is one hue
                  apart otherwise, and severity must survive colour blindness. */}
              <Text
                importantForAccessibility="no"
                className={`text-xs font-bold ${BAND[item.priority].text}`}
              >
                {BAND[item.priority].label}
              </Text>
            </Pressable>
          ))}
          <Text className="mx-5 mt-1 text-xs leading-4 text-muted-foreground">
            {AI_REVIEW_DISCLAIMER}
          </Text>
        </>
      ) : (
        <View className="mx-5 items-center gap-2 rounded-2xl bg-card p-5">
          <SparklesIcon size={24} className="text-muted-foreground" />
          <Text className="text-center text-sm text-muted-foreground">
            No AI findings yet. They appear once each recording finishes processing.
          </Text>
        </View>
      )}
    </View>
  );
}

function Tally({ count, priority }: { count: number; priority: AuditPriority }) {
  return (
    <View
      accessible
      accessibilityLabel={`${count} ${BAND[priority].label}`}
      className={`flex-1 rounded-xl px-3 py-2 ${BAND[priority].surface}`}
    >
      <Text className={`text-lg font-bold ${BAND[priority].text}`}>{count}</Text>
      <Text className="text-xs text-muted-foreground">{BAND[priority].label}</Text>
    </View>
  );
}
