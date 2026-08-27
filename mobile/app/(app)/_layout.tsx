import { Redirect, Stack } from 'expo-router';

import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { ConnectivitySync } from '@/src/components/ConnectivitySync';
import { OfflineBanner } from '@/src/components/OfflineBanner';
import { UploadQueueRunner } from '@/src/components/UploadQueueRunner';
import { ScreenLoader } from '@/src/components/ui/Loader';
import { useCurrentUser } from '@/src/features/queries';
import { useQueryCacheHydration } from '@/src/features/useQueryCacheHydration';
import { LocationShiftRunner } from '@/src/location/LocationShiftRunner';
import { ShiftAutoStart } from '@/src/location/ShiftAutoStart';
import { UpdatePrompt } from '@/src/updates/UpdatePrompt';

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
      {/* Above the navigator so it sits over every screen — being offline is
          not the concern of any one of them. */}
      <OfflineBanner />
      <UploadQueueRunner />
      {/* Sends whatever the location task collected, whether or not a shift is
          currently on — fixes taken in a basement must not sit on the handset
          because the technician clocked off before signal returned. */}
      <LocationShiftRunner />
      {/* Starts recording because the app is open, rather than because somebody
          remembered a switch. Inside the auth gate, so it can only ever run for
          a signed-in technician. */}
      <ShiftAutoStart />
      {/* A sibling of the navigator, like the offline banner: which build is
          running is not the concern of any one screen, and the prompt has to be
          able to appear over all of them. It knows to stay quiet on the two
          that would lose work. */}
      <UpdatePrompt />
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
