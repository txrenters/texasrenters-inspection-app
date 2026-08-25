import { FileTextIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { BaselineCondition } from '../domain/models';
import { Badge } from '../components/ui';
import { registerIcons } from '../lib/icons';

registerIcons(FileTextIcon);

/**
 * What the room looked like at move-in.
 *
 * Condensed from five stacked blocks — condition pill, full summary, a photo
 * count, a defects list and a "Baseline is read-only" chip — to a heading, a
 * three-line summary and one defects line.
 *
 * The read-only chip is gone. It explained the absence of a control nobody was
 * looking for: there is no edit affordance here, so the only thing the chip
 * added was a row telling the technician they could not do something they had
 * not tried to do.
 *
 * The summary is clamped rather than truncated with a "more" control. This is
 * reference material a technician skims for anything that contradicts what they
 * are looking at, and the defects line below carries the part that would
 * actually change what they film.
 */
export function BaselineCard({ baseline }: { baseline: BaselineCondition }) {
  return (
    <View className="mx-5 mt-4 gap-2 rounded-2xl bg-card p-5">
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          <FileTextIcon size={18} className="text-primary" />
          <Text className="text-base font-semibold text-foreground">Move-in baseline</Text>
        </View>
        {/* Pre-cased for the Badge, which never transforms its label — round
            tripping through lowercase mangles a hyphenated condition. */}
        <Badge label={formatCondition(baseline.condition)} />
      </View>
      <Text numberOfLines={3} className="text-sm leading-6 text-muted-foreground">
        {baseline.summary || 'No baseline condition is available for this room.'}
      </Text>
      <Text className="text-sm leading-6 text-muted-foreground">
        <Text className="font-semibold text-foreground">Existing defects: </Text>
        {baseline.existingDefects.length ? baseline.existingDefects.join(' · ') : 'none documented'}
      </Text>
    </View>
  );
}

/** `GOOD_CONDITION` reads as "Good condition", not "good condition". */
function formatCondition(condition: string) {
  const words = condition.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
