import { Redirect, Stack } from 'expo-router';

import { ErrorState, LoadingState } from '../../src/components/ScreenStates';
import { useCurrentUser } from '../../src/features/queries';
import { useAppTheme } from '../../src/theme';

export default function AppLayout() {
  const { colors } = useAppTheme();
  const user = useCurrentUser();
  if (user.isLoading) return <LoadingState label="Verifying secure access…" />;
  if (user.isError)
    return <ErrorState message={user.error.message} onRetry={() => void user.refetch()} />;
  if (!user.data) return <Redirect href="/(auth)/login" />;
  if (user.data.mustChangePassword) return <Redirect href="/(auth)/change-password" />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
        headerTitleStyle: { fontWeight: '800', fontSize: 17 },
        headerBackButtonDisplayMode: 'minimal',
        animation: 'slide_from_right',
        gestureEnabled: true,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="inspections/[inspectionId]/index"
        options={{ title: 'Inspection overview' }}
      />
      <Stack.Screen name="inspections/[inspectionId]/areas" options={{ title: 'Rooms' }} />
      <Stack.Screen name="inspections/[inspectionId]/findings" options={{ title: 'Findings' }} />
      <Stack.Screen
        name="inspections/[inspectionId]/finding/[findingId]"
        options={{ title: 'Finding review' }}
      />
      <Stack.Screen
        name="inspections/[inspectionId]/area/[areaId]/index"
        options={{ title: 'Room details' }}
      />
      <Stack.Screen
        name="inspections/[inspectionId]/area/[areaId]/record"
        options={{ title: 'Record room' }}
      />
      <Stack.Screen
        name="inspections/[inspectionId]/area/[areaId]/review"
        options={{ title: 'Review recording' }}
      />
      <Stack.Screen
        name="inspections/[inspectionId]/area/[areaId]/processing"
        options={{ title: 'Processing status' }}
      />
      <Stack.Screen name="properties/[propertyId]/index" options={{ title: 'Property' }} />
      <Stack.Screen name="properties/[propertyId]/floor-plan" options={{ title: 'Floor plan' }} />
    </Stack>
  );
}
