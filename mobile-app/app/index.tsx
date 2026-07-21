import { Redirect } from 'expo-router';

import { ErrorState, LoadingState } from '../src/components/ScreenStates';
import { isDemoMode } from '../src/config/environment';
import { useCurrentUser } from '../src/features/queries';
import { useDemoStore } from '../src/stores/demo.store';

export default function Index() {
  const hasHydrated = useDemoStore((state) => state.hasHydrated);
  const selectedUserId = useDemoStore((state) => state.selectedUserId);
  const user = useCurrentUser();
  if ((isDemoMode && !hasHydrated) || (!isDemoMode && user.isLoading))
    return (
      <LoadingState label={isDemoMode ? 'Preparing your demo workspace…' : 'Restoring session…'} />
    );
  if (!isDemoMode && user.isError)
    return <ErrorState message={user.error.message} onRetry={() => void user.refetch()} />;
  const authenticated = isDemoMode ? Boolean(selectedUserId) : Boolean(user.data);
  if (!isDemoMode && user.data?.mustChangePassword)
    return <Redirect href="/(auth)/change-password" />;
  return authenticated ? (
    <Redirect href="/(app)/(tabs)/dashboard" />
  ) : (
    <Redirect href="/(auth)/welcome" />
  );
}
