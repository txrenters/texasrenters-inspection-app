import { Redirect, Stack } from 'expo-router';

import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { ConnectivitySync } from '@/src/components/ConnectivitySync';
import { UploadQueueRunner } from '@/src/components/UploadQueueRunner';
import { ScreenLoader } from '@/src/components/ui/Loader';
import { useCurrentUser } from '@/src/features/queries';
import { useQueryCacheHydration } from '@/src/features/useQueryCacheHydration';

// Scoped to the signed-in area so a crash inside an inspection recovers here,
// keeping the session and the upload queue rather than resetting to the root.
export const ErrorBoundary = createErrorBoundary('app');

export default function AppLayout() {
  // Runs before the auth gate resolves, so a warm launch paints the technician's
  // last known screens instead of a spinner while `/auth/me` is in flight.
  const hydrated = useQueryCacheHydration();
  const user = useCurrentUser();
  if (!hydrated || user.isLoading) {
    return <ScreenLoader label="Loading your work queue…" />;
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
