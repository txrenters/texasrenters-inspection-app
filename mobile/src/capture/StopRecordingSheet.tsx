import { Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { Button } from '../components/ui';

/**
 * Asks before ending a take.
 *
 * Stopping used to be a single unguarded tap, from either the red button or the
 * header back arrow — and the back arrow sits exactly where a thumb reaches to
 * go back, so the take most likely to be lost was the one nobody meant to end.
 * A walkthrough cannot be resumed: stopping closes the recording and moves on
 * to review, so the second tap is cheap next to filming a room again.
 *
 * The count is here rather than implied because it is the thing that decides
 * the answer — someone who has taken one photo in forty seconds usually has not
 * finished the room, and someone who has taken nine in six minutes has.
 *
 * Not styled as destructive. Finishing opens the review screen, where the take
 * can still be retaken or discarded; red would claim a finality this does not
 * have, and would make the safe, ordinary end of every room feel like a
 * warning.
 */
export function StopRecordingSheet({
  elapsedLabel,
  onFinish,
  onKeepRecording,
  photoCount,
  visible,
}: {
  /** Already formatted by the screen, which owns the recording clock. */
  elapsedLabel: string;
  onFinish: () => void;
  onKeepRecording: () => void;
  photoCount: number;
  visible: boolean;
}) {
  return (
    <BottomSheet
      accessibilityRole="alert"
      animationType="fade"
      // The Android back button lands here too, and backing out of a question
      // about ending a recording must never be what ends it.
      onClose={onKeepRecording}
      visible={visible}
    >
      <Text className="text-xl font-bold text-foreground">Finish this recording?</Text>
      <Text className="mt-2 text-sm leading-5 text-muted-foreground">
        {elapsedLabel} recorded, {photoCount} photo{photoCount === 1 ? '' : 's'} taken. You can
        retake or discard it on the next screen.
      </Text>
      <View className="mt-4 flex-row gap-3">
        <Button
          className="flex-1"
          label="Keep recording"
          onPress={onKeepRecording}
          variant="secondary"
        />
        <Button
          accessibilityHint="Ends the take and opens the review screen"
          className="flex-1"
          label="Finish"
          onPress={onFinish}
        />
      </View>
    </BottomSheet>
  );
}
