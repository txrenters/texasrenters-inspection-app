import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/global.css';
import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { StartupErrorOverlay } from '@/src/components/StartupErrorOverlay';
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
      {/* TEMPORARY — diagnostic build only. Outside the providers on purpose:
          if one of them is what throws, an overlay mounted inside it would go
          down with it and show nothing. */}
      <StartupErrorOverlay>
        <ThemeProvider>
          <TexasRentersProviders>
            <RootLayoutNav />
          </TexasRentersProviders>
        </ThemeProvider>
      </StartupErrorOverlay>
    </SafeAreaProvider>
  );
}
