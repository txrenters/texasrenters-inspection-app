import { router } from 'expo-router';
import { AlertTriangleIcon, RefreshCwIcon, StethoscopeIcon } from 'lucide-react-native';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { reportError } from '../lib/error-log';
import { registerIcons } from '../lib/icons';

registerIcons(AlertTriangleIcon, RefreshCwIcon, StethoscopeIcon);

/**
 * What a technician sees instead of a white screen.
 *
 * Two things matter more than the error text. First, that captured evidence is
 * still on the device — a technician who thinks a crash lost an hour of work
 * will re-record rooms unnecessarily, or worse, stop trusting the app. Second,
 * a way forward that is not "force-quit and hope".
 *
 * Expo Router renders this via the `ErrorBoundary` export convention, which
 * passes `retry` to remount the failed segment.
 */
export function AppErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        className="px-6"
      >
        <View className="items-center">
          <View className="h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
            <AlertTriangleIcon size={32} className="text-destructive" />
          </View>
          <Text className="mt-4 text-center text-xl font-bold text-foreground">
            This screen ran into a problem
          </Text>
          <Text className="mt-2 text-center text-sm leading-6 text-muted-foreground">
            Nothing you captured has been lost. Recordings and photos stay on this device and upload
            once you continue.
          </Text>
        </View>

        <View className="mt-6 rounded-2xl bg-card p-4">
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            What happened
          </Text>
          <Text className="mt-1.5 text-sm leading-6 text-foreground">
            {error?.message || 'An unexpected error occurred.'}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try this screen again"
          className="mt-5 min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-primary py-3.5 active:scale-[0.98]"
          onPress={() => void retry()}
        >
          <RefreshCwIcon size={17} className="text-primary-foreground" />
          <Text className="font-bold text-primary-foreground">Try again</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open diagnostics to report this problem"
          className="mt-3 min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-card py-3.5 active:scale-[0.98]"
          onPress={() => {
            // Replace, not push: the failed screen must not stay on the stack
            // where "back" would immediately crash again.
            router.replace('/(app)/diagnostics');
          }}
        >
          <StethoscopeIcon size={17} className="text-primary" />
          <Text className="font-semibold text-primary">Open diagnostics</Text>
        </Pressable>

        <Text className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          Diagnostics has the details your coordinator needs. Copy them into your report.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Factory for the `ErrorBoundary` export expo-router looks for on a route.
 * Logging happens here so every boundary records, regardless of segment.
 */
export function createErrorBoundary(source: string) {
  return function RouteErrorBoundary(props: { error: Error; retry: () => Promise<void> }) {
    void reportError(props.error, { source, fatal: true });
    return <AppErrorBoundary {...props} />;
  };
}
