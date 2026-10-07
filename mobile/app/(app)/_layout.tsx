import { Redirect, Stack } from 'expo-router';

import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { ConnectivitySync } from '@/src/components/ConnectivitySync';
import { OfflineBanner } from '@/src/components/OfflineBanner';
import { UploadQueueRunner } from '@/src/components/UploadQueueRunner';
import { ScreenLoader } from '@/src/components/ui/Loader';
import { useCurrentUser } from '@/src/features/queries';
import { useQueryCacheHydration } from '@/src/features/useQueryCacheHydration';
import { useStackScreenOptions } from '@/src/lib/native-header';
import { LocationShiftRunner } from '@/src/location/LocationShiftRunner';
import { ShiftAutoStart } from '@/src/location/ShiftAutoStart';

// Scoped to the signed-in area so a crash inside an inspection recovers here,
// keeping the session and the upload queue rather than resetting to the root.
export const ErrorBoundary = createErrorBoundary('app');

/**
 * The tabs are always the bottom of the stack, however a screen was opened.
 *
 * A screen opened from a notification used to be the only one in the stack, so
 * its back button had nothing to go back to and fell back to replacing it with
 * Home. The native bar has no back button at all in that case -- so the tabs
 * are put underneath, and back always leads somewhere.
 */
export const unstable_settings = { initialRouteName: '(tabs)' };

export default function AppLayout() {
  // Runs before the auth gate resolves, so a warm launch paints the technician's
  // last known screens instead of a spinner while `/auth/me` is in flight.
  const hydrated = useQueryCacheHydration();
  const user = useCurrentUser();
  const stackOptions = useStackScreenOptions();
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
      {/* `UpdatePrompt` used to live here. It is mounted at the root instead,
          because an update is not the signed-in area's business: a technician
          who cannot sign in is exactly who needs one, and gating it here meant
          the fix could never reach them. */}
      {/* The platform's own bar on every screen (see `native-header`), the
          title set by each screen. The tabs carry their own stacks and bars. */}
      <Stack screenOptions={stackOptions}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="inspections/[id]" />
        <Stack.Screen name="areas/[id]" />
        <Stack.Screen name="job-filters/[id]" />
        <Stack.Screen name="job-inspection/[id]" />
        <Stack.Screen name="findings/[id]" />
        {/* Full screen: the viewfinder is the whole page. */}
        <Stack.Screen name="camera/[inspectionId]/[areaId]" options={{ headerShown: false }} />
        {/* No way back but the screen's own: it replaced the camera, and the
            take is not saved until it is confirmed here. Home asks first. */}
        <Stack.Screen
          name="recording-review/[inspectionId]/[areaId]"
          options={{ headerBackVisible: false, gestureEnabled: false }}
        />
        <Stack.Screen name="diagnostics" />
        <Stack.Screen name="home-address" />
        {/* `gestureEnabled: false` is the whole reason this screen carries
            options at all. The default iOS back-swipe from the left edge pops
            the screen, and a thumb resting on a phone in a windscreen cradle
            does exactly that — dropping the driver out of navigation mid-leg,
            at speed, with no confirmation. */}
        <Stack.Screen
          name="navigate"
          options={{ headerShown: false, animation: 'fade', gestureEnabled: false }}
        />
      </Stack>
    </>
  );
}
