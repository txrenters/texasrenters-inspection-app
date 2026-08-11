import { RotateCwIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { registerIcons } from '../lib/icons';

registerIcons(RotateCwIcon);

/**
 * The first instruction of an area: film the room before assessing it.
 *
 * Shown when the walkthrough starts, so the order is stated rather than assumed.
 * The condition questions come after, when the sensor confirms the sweep — a
 * technician who scores the room first ends up describing it from memory, which
 * is what the recording is meant to replace.
 *
 * Dismissible immediately: this is a reminder, not a gate. Someone on their
 * twentieth area of the day already knows, and blocking the camera behind an
 * acknowledgement would cost them a tap in every room.
 */
export function SweepPromptSheet({
  areaName,
  onClose,
  visible,
}: {
  areaName: string;
  onClose: () => void;
  visible: boolean;
}) {
  return (
    <BottomSheet onClose={onClose} visible={visible}>
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/15">
          <RotateCwIcon size={20} className="text-primary" />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-bold text-foreground">Record a 360 of {areaName}</Text>
          <Text className="mt-0.5 text-sm leading-5 text-muted-foreground">
            Turn slowly clockwise from where you are standing, back to where you started. The
            checklist questions start on their own once the turn is complete.
          </Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        className="mt-5 min-h-14 items-center justify-center rounded-2xl bg-primary active:scale-[0.98]"
        onPress={onClose}
      >
        <Text className="text-base font-semibold text-primary-foreground">Start turning</Text>
      </Pressable>
    </BottomSheet>
  );
}
