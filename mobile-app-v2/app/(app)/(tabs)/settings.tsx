import { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { cssInterop, useColorScheme } from 'nativewind';
import {
  BellIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  DatabaseIcon,
  HelpCircleIcon,
  InfoIcon,
  LogOutIcon,
  MoonIcon,
  ServerIcon,
  SunIcon,
  UserIcon,
  WifiIcon,
} from 'lucide-react-native';
import { Alert, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { environment } from '@/src/config/environment';
import { useCurrentUser, useSignOut } from '@/src/features/queries';
import { usePreferencesStore, type ThemePreference } from '@/src/stores/preferences.store';

for (const icon of [
  BellIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  DatabaseIcon,
  HelpCircleIcon,
  InfoIcon,
  LogOutIcon,
  MoonIcon,
  ServerIcon,
  SunIcon,
  UserIcon,
  WifiIcon,
]) {
  cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
}

export default function SettingsScreen() {
  const user = useCurrentUser();
  const signOut = useSignOut();
  const { setColorScheme } = useColorScheme();
  const preference = usePreferencesStore((state) => state.themePreference);
  const setPreference = usePreferencesStore((state) => state.setThemePreference);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [backendStatus, setBackendStatus] = useState(
    environment.apiBaseUrl ? 'Checking…' : 'Not configured',
  );
  const appName = Constants.expoConfig?.name ?? 'TexasRenters Inspect';
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';

  useEffect(() => {
    if (!environment.apiBaseUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    void fetch(`${environment.apiBaseUrl}/health`, { signal: controller.signal })
      .then((response) => setBackendStatus(response.ok ? 'Reachable' : 'Unavailable'))
      .catch(() => setBackendStatus('Unavailable'))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const chooseTheme = useCallback(
    (value: ThemePreference) => {
      setPreference(value);
      setColorScheme(value);
    },
    [setColorScheme, setPreference],
  );

  const logout = () => {
    Alert.alert('Sign out?', 'Queued evidence remains stored securely on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          signOut.mutate(undefined, { onSuccess: () => router.replace('/login') });
        },
      },
    ]);
  };

  const handleHelp = () =>
    Alert.alert(
      'Technician help',
      'If an inspection or floor plan is missing, contact your TexasRenters administrator.',
    );
  const handleAbout = () =>
    Alert.alert(
      `About ${appName}`,
      `Version ${appVersion}\n\nSecure field inspection and evidence capture.`,
    );

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="px-5 pb-2 pt-4">
          <Text className="text-2xl font-bold tracking-tight text-foreground">Settings</Text>
          <Text className="mt-0.5 text-sm text-muted-foreground">
            Configure your inspection workflow
          </Text>
        </View>

        <View className="mx-5 mt-5 flex-row items-center gap-4 rounded-2xl bg-card p-5">
          <View className="h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <UserIcon size={24} className="text-primary" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-bold text-foreground">
              {user.data?.name ?? 'Inspection technician'}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {user.data?.roleLabel ?? 'Authorized field account'}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">
              Secure TexasRenters mobile access
            </Text>
          </View>
          <View className="flex-row items-center gap-1 rounded-full bg-chart-3/15 px-3 py-1">
            <CheckCircle2Icon size={13} className="text-chart-3" />
            <Text className="text-xs font-bold text-chart-3">Secure</Text>
          </View>
        </View>

        <Text className="mb-2 mt-6 px-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Preferences
        </Text>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <View className="flex-row items-center gap-3 border-b border-border px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-chart-4/15">
              <BellIcon size={18} className="text-chart-4" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">Push Notifications</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                Assignment, reminder, and upload alerts
              </Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={setNotificationsEnabled}
              trackColor={{ false: '#d1d5db', true: '#14967d' }}
              thumbColor="#fff"
            />
          </View>
          <View className="px-4 py-4">
            <View className="mb-3 flex-row items-center gap-3">
              <View className="h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                {preference === 'light' ? (
                  <SunIcon size={18} className="text-primary" />
                ) : (
                  <MoonIcon size={18} className="text-primary" />
                )}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">Color Theme</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  System follows your device appearance automatically
                </Text>
              </View>
            </View>
            <View className="flex-row gap-2">
              {(['light', 'dark', 'system'] as const).map((value) => (
                <Pressable
                  key={value}
                  className={`flex-1 items-center rounded-xl px-3 py-2.5 active:scale-[0.97] ${
                    preference === value ? 'bg-primary' : 'bg-muted'
                  }`}
                  onPress={() => chooseTheme(value)}
                >
                  <Text
                    className={`text-xs font-semibold capitalize ${
                      preference === value
                        ? 'text-primary-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {value}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <Text className="mb-2 mt-6 px-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Environment
        </Text>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <View className="flex-row items-center gap-3 border-b border-border px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-chart-2/15">
              <ServerIcon size={18} className="text-chart-2" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">TexasRenters REST API</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                Backend {backendStatus.toLowerCase()}
              </Text>
            </View>
            <Text className="text-xs font-semibold text-primary">{backendStatus}</Text>
          </View>
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-chart-3/15">
              <WifiIcon size={18} className="text-chart-3" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">Offline-first evidence</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                Saved work queues locally until the server confirms it
              </Text>
            </View>
          </View>
        </View>

        <Text className="mb-2 mt-6 px-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Support
        </Text>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <Pressable
            className="flex-row items-center gap-3 border-b border-border px-4 py-3.5 active:opacity-60"
            onPress={handleHelp}
          >
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-chart-4/15">
              <HelpCircleIcon size={18} className="text-chart-4" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">
                Help & Documentation
              </Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                Inspection guidance and support
              </Text>
            </View>
            <ChevronRightIcon size={16} className="text-muted-foreground" />
          </Pressable>
          <Pressable
            className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-60"
            onPress={handleAbout}
          >
            <View className="h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <InfoIcon size={18} className="text-muted-foreground" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">About</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {appName} v{appVersion}
              </Text>
            </View>
            <ChevronRightIcon size={16} className="text-muted-foreground" />
          </Pressable>
        </View>

        <Pressable
          className="mx-5 mt-8 flex-row items-center gap-3 rounded-2xl border border-destructive/20 bg-card p-4 active:scale-[0.98]"
          onPress={logout}
          disabled={signOut.isPending}
        >
          <LogOutIcon size={20} className="text-destructive" />
          <Text className="text-base font-semibold text-destructive">
            {signOut.isPending ? 'Signing out…' : 'Sign Out'}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
