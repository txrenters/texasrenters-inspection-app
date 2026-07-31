import { Redirect } from 'expo-router';

import { ScreenLoader } from '@/src/components/ui/Loader';
import { useCurrentUser } from '@/src/features/queries';

export default function RootIndex() {
  const user = useCurrentUser();
  if (user.isLoading) {
    return <ScreenLoader label="Verifying secure access…" />;
  }
  if (user.data?.mustChangePassword) return <Redirect href="/change-password" />;
  return <Redirect href={user.data ? '/(app)/(tabs)' : '/login'} />;
}
