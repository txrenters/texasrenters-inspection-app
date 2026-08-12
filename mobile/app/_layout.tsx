import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/global.css';
// Side-effect import, before any screen renders: registers third-party
// components that are styled with `className`. See the file for why an
// unregistered SafeAreaView surfaced as a navigation-context error.
import '@/src/lib/css-interop';
import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { installGlobalErrorHandlers } from '@/src/lib/error-log';
import { ThemeProvider } from '@/src/providers/ThemeProvider';
import { TexasRentersProviders } from '@/src/providers/TexasRentersProviders';

// Installed at module scope so errors thrown during the very first render —
// before any effect has run — are still captured.
installGlobalErrorHandlers();

/** expo-router renders this instead of a white screen when a route throws. */
export const ErrorBoundary = createErrorBoundary('root');

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
