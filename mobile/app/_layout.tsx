import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import '@/global.css';
import { getSession } from '@/src/auth/session';
import { createErrorBoundary } from '@/src/components/AppErrorBoundary';
import { installGlobalErrorHandlers } from '@/src/lib/error-log';
import { startErrorReporting } from '@/src/lib/error-reporter';
import { ThemeProvider } from '@/src/providers/ThemeProvider';
import { TexasRentersProviders } from '@/src/providers/TexasRentersProviders';
import { UpdatePrompt } from '@/src/updates/UpdatePrompt';

// Installed at module scope so errors thrown during the very first render —
// before any effect has run — are still captured.
installGlobalErrorHandlers();

// Ships the log those handlers write. Started here rather than inside `(app)`
// for the same reason the update prompt is: a crash on the login screen is
// exactly the report that was impossible to see, and it has no session to
// report under. The token, when there is one, only decides attribution.
startErrorReporting(async () => (await getSession())?.accessToken ?? null);

/** expo-router renders this instead of a white screen when a route throws. */
export const ErrorBoundary = createErrorBoundary('root');

function RootLayoutNav() {
  return (
    <>
      <StatusBar style="auto" />
      {/* Above the auth gate, deliberately.
          This used to be mounted inside `(app)`, so nothing checked for an
          update, downloaded one, or offered the restart that applies it until
          somebody had signed in -- and a technician who *cannot* sign in is
          exactly who a fix is usually for. A build with a broken API address
          could not repair itself, because repairing it required getting past
          the screen it had broken.
          expo-updates still checks at launch on its own; what was gated was
          the mid-session check, the download, and the only button that applies
          one without quitting the app twice. It has no session of its own and
          knows to stay quiet on the screens that would lose work. */}
      <UpdatePrompt />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="forgot-password" />
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
