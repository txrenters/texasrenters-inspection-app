import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';
import { useThemeColors } from '@/src/lib/theme-colors';

/**
 * Nobody let the technician in.
 *
 * The office's decision (2026-09-18): a refused entry, a locked gate or an
 * empty house ends the whole job rather than being ticked task by task. Every
 * service the visit booked is recorded as not done and marked for rebooking,
 * and the reason travels to Jobber — which is what a coordinator reads before
 * booking it again.
 *
 * Deliberately blunt about what it does. This ends the visit, so the copy says
 * so before the button is pressed rather than in a toast afterwards.
 */
export function NoAccessSheet({
  visible,
  busy = false,
  onClose,
  onReport,
}: {
  visible: boolean;
  busy?: boolean;
  onClose: () => void;
  onReport: (reason: string) => void;
}) {
  const theme = useThemeColors();
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 3 && !busy;

  const close = () => {
    setReason('');
    onClose();
  };

  return (
    <BottomSheet accessibilityRole="alert" className="max-h-[88%]" onClose={close} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">Could not get in</Text>
          <Text className="text-sm text-muted-foreground">
            This ends the job and asks the office to book it again. Say what happened.
          </Text>
        </View>
        <TextInput
          accessibilityLabel="What happened"
          autoFocus
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          multiline
          onChangeText={setReason}
          placeholder="Nobody home, gate locked, tenant refused…"
          placeholderTextColor={theme.mutedForeground}
          value={reason}
        />
        <View className="flex-row gap-3">
          <Button className="flex-1" disabled={busy} label="Cancel" onPress={close} variant="secondary" />
          <Button
            busy={busy}
            busyLabel="Reporting…"
            className="flex-1"
            disabled={!ready}
            label="End the job"
            onPress={() => onReport(reason.trim())}
            variant="destructive"
          />
        </View>
      </View>
    </BottomSheet>
  );
}
