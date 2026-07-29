import { Redirect } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';

import { useCurrentUser } from '@/src/features/queries';

export default function RootIndex() {
  const user = useCurrentUser();
  if (user.isLoading) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background">
        <ActivityIndicator />
        <Text className="text-muted-foreground">Verifying secure access…</Text>
      </View>
    );
  }
  if (user.data?.mustChangePassword) return <Redirect href="/change-password" />;
  return <Redirect href={user.data ? '/(app)/(tabs)' : '/login'} />;
}
