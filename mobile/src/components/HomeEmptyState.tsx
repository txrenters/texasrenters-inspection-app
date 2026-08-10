import { ClipboardListIcon, BellIcon, RefreshCwIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';

registerIcons(ClipboardListIcon, BellIcon, RefreshCwIcon);

/**
 * What the home screen shows a technician who has no work at all.
 *
 * Two different states used to collapse into one card reading "All caught up —
 * no pending inspections". For somebody who has just been given an account that
 * is not reassuring, it is wrong: it congratulates them for finishing work they
 * were never assigned, on a screen that is otherwise three zeroes. Nothing on
 * it says whether the app is working, whether setup is finished, or what
 * happens next.
 *
 * So `neverAssigned` splits them. Somebody with history who has cleared their
 * queue still gets "All caught up"; somebody with none gets told how work will
 * arrive.
 *
 * Deliberately no call to action. A technician cannot assign themselves an
 * inspection, and a button that only opens an empty list would be a dead end
 * dressed as progress. The useful thing is knowing the wait is expected.
 */
export function HomeEmptyState({ neverAssigned }: { neverAssigned: boolean }) {
  if (!neverAssigned)
    return (
      <View className="mx-5 items-center gap-2 rounded-2xl bg-card p-6">
        <ClipboardListIcon size={28} className="text-muted-foreground" />
        <Text className="text-center text-sm text-muted-foreground">
          All caught up — no pending inspections
        </Text>
      </View>
    );

  return (
    <View
      // One announcement rather than seven. Read ungrouped, VoiceOver stops on
      // every heading, line and bullet in turn.
      accessible
      accessibilityLabel={
        'No inspections yet. ' +
        'When the office assigns you an inspection it appears here, ' +
        'your phone gets a notification, ' +
        'and you can pull down to refresh at any time.'
      }
      className="mx-5 gap-4 rounded-2xl bg-card p-6"
    >
      <View className="items-center gap-2">
        <View className="h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <ClipboardListIcon size={26} className="text-primary" />
        </View>
        <Text className="mt-1 text-center text-base font-semibold text-foreground">
          No inspections yet
        </Text>
        <Text className="text-center text-sm leading-relaxed text-muted-foreground">
          Your account is set up and connected. Work appears here as soon as the office assigns it
          to you.
        </Text>
      </View>

      <View className="gap-3 border-t border-border pt-4">
        <View className="flex-row items-start gap-3">
          <BellIcon size={16} className="mt-0.5 text-muted-foreground" />
          <Text className="flex-1 text-sm text-muted-foreground">
            You will get a notification when an inspection is assigned.
          </Text>
        </View>
        <View className="flex-row items-start gap-3">
          <RefreshCwIcon size={16} className="mt-0.5 text-muted-foreground" />
          <Text className="flex-1 text-sm text-muted-foreground">
            Pull down to refresh if you are expecting something now.
          </Text>
        </View>
      </View>
    </View>
  );
}
