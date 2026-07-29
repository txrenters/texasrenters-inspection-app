import { CheckCircle2, ChevronRight, FileText } from 'lucide-react-native';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { Inspection } from '@/domain/models';

function formatDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * A finished inspection.
 *
 * Deliberately lighter than the active card: completed work is reference
 * material, and giving it equal weight is what made the list hard to scan. The
 * primary action is the summary — that screen already existed but was reachable
 * only from inside the inspection, two taps deep.
 */
export function CompletedInspectionRow({
  inspection,
  onOpen,
  onViewSummary,
}: {
  inspection: Inspection;
  onOpen: () => void;
  onViewSummary: () => void;
}) {
  // There is no completedAt on Inspection; updatedAt is the last state change,
  // which for a finished inspection is when it was completed.
  const completed = formatDate(inspection.updatedAt ?? inspection.scheduledAt);

  return (
    <Card className="p-0">
      <Pressable
        accessibilityLabel={`${inspection.property.address}, completed`}
        accessibilityRole="button"
        className="min-h-[56px] flex-row items-center gap-3 px-4 py-3 active:opacity-70"
        onPress={onOpen}
      >
        <Icon as={CheckCircle2} className="size-5 text-success" />
        <View className="flex-1">
          <Text className="font-medium" numberOfLines={1}>
            {inspection.property.address}
          </Text>
          <Text className="text-sm text-muted-foreground" numberOfLines={1}>
            {inspection.type.replaceAll('_', ' ').toLowerCase()}
            {completed ? ` · ${completed}` : ''}
          </Text>
        </View>
        <Icon as={ChevronRight} className="size-5 text-muted-foreground" />
      </Pressable>

      <View className="px-4 pb-3">
        <Button
          accessibilityLabel={`View summary for ${inspection.property.address}`}
          className="min-h-11 flex-row gap-2"
          onPress={onViewSummary}
          variant="secondary"
        >
          <Icon as={FileText} className="size-4" />
          <Text>View summary</Text>
        </Button>
      </View>
    </Card>
  );
}
