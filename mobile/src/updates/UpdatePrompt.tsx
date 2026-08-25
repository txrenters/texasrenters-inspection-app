import { useEffect, useState } from 'react';
import * as Updates from 'expo-updates';
import { usePathname } from 'expo-router';
import { AppState, Text, View } from 'react-native';

import { BottomSheet } from '../components/BottomSheet';
import { Button } from '../components/ui';
import { announce } from '../lib/announce';
import { reportError } from '../lib/error-log';
import { shouldPromptForUpdate } from './update-prompt-rules';

/**
 * Tells a technician when a downloaded update is ready, and restarts into it.
 *
 * Updates already reached the device on their own — expo-updates checks at
 * launch, downloads in the background and applies on the *next* launch. Nothing
 * ever said so, so the only way to pick one up was to happen to close and
 * reopen the app twice, and a technician who never fully quits the app could
 * run an old build for weeks without knowing a fix had shipped.
 *
 * The restart is the point. `reloadAsync` applies the downloaded update
 * immediately, which turns "close it twice and hope" into one button.
 *
 * Deliberately not a push notification: the server has no idea which build any
 * handset is running, so it could only guess who needs telling. The device
 * already knows, and it knows the moment the download lands.
 */
export function UpdatePrompt() {
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Downloading is not automatic for an update found mid-session — only the
  // one found at launch. Without this the prompt would never appear for
  // anything published while the app was open.
  useEffect(() => {
    if (!Updates.isEnabled || !isUpdateAvailable || isUpdatePending) return;
    void Updates.fetchUpdateAsync().catch((cause) => {
      // Not surfaced: failing to fetch an update is not the technician's
      // problem to solve, and the next launch tries again anyway.
      void reportError(cause, { source: 'update-fetch' });
    });
  }, [isUpdateAvailable, isUpdatePending]);

  // Checked again whenever the app comes back to the foreground. expo-updates
  // only checks at launch, and a phone that lives in a pocket between rooms is
  // resumed far more often than it is started.
  useEffect(() => {
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void Updates.checkForUpdateAsync().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  const visible = shouldPromptForUpdate({ dismissed, isUpdatePending, pathname });

  useEffect(() => {
    if (visible) announce('An app update is ready to install.');
  }, [visible]);

  const restart = async () => {
    setRestarting(true);
    setError(null);
    try {
      await Updates.reloadAsync();
    } catch (cause) {
      // Only reached if the reload itself fails; a successful one never
      // returns, because the app has already been torn down.
      void reportError(cause, { source: 'update-reload' });
      setError('The app could not restart. Close it fully and open it again to finish updating.');
      setRestarting(false);
    }
  };

  return (
    <BottomSheet
      accessibilityRole="alert"
      animationType="fade"
      // Dismissing with the Android back button means the same as Later.
      onClose={() => setDismissed(true)}
      visible={visible}
    >
      <Text className="text-xl font-bold text-foreground">Update ready</Text>
      <Text className="mt-2 text-sm leading-5 text-muted-foreground">
        A new version has finished downloading. Restarting takes a few seconds — nothing you have
        captured is lost, and any uploads still running pick up where they left off.
      </Text>
      {error ? (
        <Text
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          className="mt-3 text-sm text-destructive"
        >
          {error}
        </Text>
      ) : null}
      <View className="mt-4 flex-row gap-3">
        <Button
          className="flex-1"
          disabled={restarting}
          label="Later"
          onPress={() => setDismissed(true)}
          variant="secondary"
        />
        <Button
          accessibilityHint="Restarts the app to finish updating"
          busy={restarting}
          busyLabel="Restarting…"
          className="flex-1"
          label="Restart now"
          onPress={() => void restart()}
        />
      </View>
    </BottomSheet>
  );
}
