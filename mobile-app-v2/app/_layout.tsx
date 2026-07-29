import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/global.css';
import { ThemeProvider } from '@/src/providers/ThemeProvider';
import { TexasRentersProviders } from '@/src/providers/TexasRentersProviders';

function RootLayoutNav() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="change-password" />
        <Stack.Screen name="(app)" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <TexasRentersProviders>
          <RootLayoutNav />
        </TexasRentersProviders>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
