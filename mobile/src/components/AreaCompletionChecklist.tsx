import { AlertTriangleIcon, CheckIcon, CircleIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { AreaRequirement } from '../utils/area-requirements';
import { registerIcons } from '../lib/icons';

registerIcons(AlertTriangleIcon, CheckIcon, CircleIcon);

/**
 * What still stands between this area and completion.
 *
 * Exists so "Mark complete" is never disabled without saying why. Blocking
 * items that are unmet are called out; advisory ones are shown but read as
 * neutral, because a technician may legitimately find nothing wrong at a prior
 * documented defect — the app must not imply they missed something.
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
    <View className="mx-5 mt-4 gap-3 rounded-2xl bg-card p-5">
      <Text className="text-base font-semibold text-foreground">Completion requirements</Text>

      {blockedReason ? (
        <View
          accessibilityRole="alert"
          className="flex-row items-start gap-2 rounded-xl bg-chart-4/10 p-3"
        >
          <AlertTriangleIcon size={15} className="mt-0.5 text-chart-4" />
          <Text className="min-w-0 flex-1 text-sm leading-5 text-chart-4">{blockedReason}</Text>
        </View>
      ) : null}

      <View className="gap-2.5">
        {requirements.map((item) => {
          const blockingUnmet = item.blocking && !item.met;
          return (
            <View
              accessible
              accessibilityLabel={`${item.label}. ${
                item.met ? 'Done' : blockingUnmet ? 'Required, not done' : 'Optional, not done'
              }${item.hint && !item.met ? `. ${item.hint}` : ''}`}
              className="flex-row items-start gap-2.5"
              key={item.key}
            >
              {item.met ? (
                <CheckIcon size={15} className="mt-0.5 text-chart-3" />
              ) : blockingUnmet ? (
                <AlertTriangleIcon size={15} className="mt-0.5 text-chart-4" />
              ) : (
                <CircleIcon size={15} className="mt-0.5 text-muted-foreground" />
              )}
              <View className="min-w-0 flex-1">
                <Text
                  className={`text-sm ${
                    item.met
                      ? 'text-foreground'
                      : blockingUnmet
                        ? 'font-medium text-chart-4'
                        : 'text-muted-foreground'
                  }`}
                >
                  {item.label}
                  {item.blocking ? '' : ' (optional)'}
                </Text>
                {item.hint && !item.met ? (
                  <Text className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {item.hint}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
