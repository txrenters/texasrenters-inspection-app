import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';

import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { ConnectivitySync } from '@/src/components/ConnectivitySync';
import { UploadQueueRunner } from '@/src/components/UploadQueueRunner';
import { useCurrentUser } from '@/src/features/queries';

// Scoped to the signed-in area so a crash inside an inspection recovers here,
// keeping the session and the upload queue rather than resetting to the root.
export const ErrorBoundary = createErrorBoundary('app');

export default function AppLayout() {
  const user = useCurrentUser();
  if (user.isLoading) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background">
        <ActivityIndicator />
        <Text className="text-muted-foreground">Loading your work queue…</Text>
      </View>
    );
  }
  if (!user.data) return <Redirect href="/login" />;
  if (user.data.mustChangePassword) return <Redirect href="/change-password" />;

  return (
    <>
      <ConnectivitySync />
      <UploadQueueRunner />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="inspections/[id]" />
        <Stack.Screen name="areas/[id]" />
        <Stack.Screen name="findings/[id]" />
        <Stack.Screen name="camera/[inspectionId]/[areaId]" />
        <Stack.Screen name="recording-review/[inspectionId]/[areaId]" />
        <Stack.Screen name="review/[id]" />
        <Stack.Screen name="diagnostics" />
      </Stack>
    </>
  );
}
