import { PlayCircleIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';

registerIcons(PlayCircleIcon);

/**
 * Start job, confirmed (the office, 2026-09-18: "start job then if they confirm
 * time tracker starts").
 *
 * Confirmed because it cannot be taken back: the start is the server's stamp,
 * and the office reads how long the job took from it.
 */
export function StartJobSheet({
  visible,
  busy = false,
  address,
  onClose,
  onStart,
}: {
  visible: boolean;
  busy?: boolean;
  address: string;
  onClose: () => void;
  onStart: () => void;
}) {
  return (
    <BottomSheet accessibilityRole="alert" onClose={onClose} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">Start this job?</Text>
          <Text className="text-sm text-muted-foreground">
            The timer starts now, at {address}.
          </Text>
        </View>
        <Button
          busy={busy}
          busyLabel="Starting…"
          icon={<PlayCircleIcon size={20} className="text-primary-foreground" />}
          label="Start job"
          onPress={onStart}
        />
        <Button disabled={busy} label="Cancel" onPress={onClose} variant="secondary" />
      </View>
    </BottomSheet>
  );
}
