import { AlertTriangle, Check, Circle } from 'lucide-react-native';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AreaRequirement } from '@/utils/area-requirements';

/**
 * What still stands between this area and completion.
 *
 * Exists so "Mark complete" is never disabled without saying why. Blocking items
 * that are unmet are called out; advisory ones are shown but read as neutral,
 * because a technician may legitimately find nothing wrong at a prior defect.
 */
export function AreaCompletionChecklist({
  requirements,
  blockedReason,
}: {
  requirements: readonly AreaRequirement[];
  /** Why completion is unavailable. Shown verbatim so the block is never silent. */
  blockedReason?: string;
}) {
  if (!requirements.length) return null;

  return (
    <Card className="gap-3 p-4">
      <Text className="font-semibold">Completion requirements</Text>

      {blockedReason ? (
        <View
          accessibilityRole="alert"
          className="flex-row items-start gap-2 rounded-md bg-warning/10 p-2.5"
        >
          <Icon as={AlertTriangle} className="mt-0.5 size-4 text-warning" />
          <Text className="flex-1 text-sm text-warning-foreground">{blockedReason}</Text>
        </View>
      ) : null}

      <View className="gap-2">
        {requirements.map((item) => {
          const blockingUnmet = item.blocking && !item.met;
          return (
            <View className="flex-row items-start gap-2.5" key={item.key}>
              <Icon
                as={item.met ? Check : blockingUnmet ? AlertTriangle : Circle}
                className={`mt-0.5 size-4 ${
                  item.met
                    ? 'text-success'
                    : blockingUnmet
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                }`}
              />
              <View className="flex-1">
                {/* Requirement state is spoken, not just coloured. */}
                <Text
                  accessibilityLabel={`${item.label}: ${
                    item.met ? 'done' : blockingUnmet ? 'required, not done' : 'optional, not done'
                  }`}
                  className={`text-sm ${item.met ? 'text-muted-foreground' : ''}`}
                >
                  {item.label}
                </Text>
                {!item.met && item.hint ? (
                  <Text className="text-xs text-muted-foreground">{item.hint}</Text>
                ) : null}
              </View>
              {!item.blocking && !item.met ? (
                <Text className="text-xs text-muted-foreground">Optional</Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Card>
  );
}
