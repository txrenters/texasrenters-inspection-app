import { useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useColorScheme } from 'nativewind';
import {
  BellIcon,
  ChevronRightIcon,
  DatabaseIcon,
  HardDriveIcon,
  HelpCircleIcon,
  InfoIcon,
  LogOutIcon,
  MoonIcon,
  Trash2Icon,
  UserIcon,
  WifiIcon,
  MapPinIcon,
  WrenchIcon,
} from 'lucide-react-native';
import { Alert, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTabBarInset } from '@/src/lib/tab-bar-inset';
import {
  isShiftTrackingActive,
  startShiftTracking,
  stopShiftTracking,
} from '@/src/location/shift-tracking';
import { useCurrentUser, useSignOut, useUploads } from '@/src/features/queries';
import { clearLocalRecordings } from '@/src/media/local-recordings';
import { clearLocalSnapshots } from '@/src/media/local-snapshots';
import { useDemoStore } from '@/src/stores/demo.store';
import { useNetworkStore } from '@/src/stores/network.store';
import { usePreferencesStore } from '@/src/stores/preferences.store';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { GroupLabel, ScreenHeader } from '@/src/components/ui';

registerIcons(
  BellIcon,
  ChevronRightIcon,
  DatabaseIcon,
  HardDriveIcon,
  HelpCircleIcon,
  InfoIcon,
  LogOutIcon,
  MapPinIcon,
  MoonIcon,
  Trash2Icon,
  UserIcon,
  WifiIcon,
  WrenchIcon,
);

export default function SettingsScreen() {
  const tabBarInset = useTabBarInset();
  // The OS is the source of truth for whether a shift is running, not a stored
  // preference: the service can be stopped from the notification, and a switch
  // that disagreed with the notification would be worse than no switch.
  const [onShift, setOnShift] = useState(false);
  const [shiftBusy, setShiftBusy] = useState(false);
  useEffect(() => {
    void isShiftTrackingActive().then(setOnShift);
  }, []);
  const user = useCurrentUser();
  const uploads = useUploads();
  const signOut = useSignOut();
  const { colorScheme, setColorScheme } = useColorScheme();
  const themePreference = usePreferencesStore((state) => state.themePreference);
  const setThemePreference = usePreferencesStore((state) => state.setThemePreference);
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);
  const setNotificationsEnabled = usePreferencesStore((state) => state.setNotificationsEnabled);
  const autoUpload = usePreferencesStore((state) => state.autoUpload);
  const setAutoUpload = usePreferencesStore((state) => state.setAutoUpload);
  const wifiOnlyUploads = usePreferencesStore((state) => state.wifiOnlyUploads);
  const setWifiOnlyUploads = usePreferencesStore((state) => state.setWifiOnlyUploads);
  const isMetered = useNetworkStore((state) => state.isMetered);
  const clearLocalEvidence = useDemoStore((state) => state.clearLocalEvidence);
  const [darkModeEnabled, setDarkModeEnabled] = useState(colorScheme === 'dark');
  const appName = Constants.expoConfig?.name ?? 'TexasRenters Inspect';
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';

  useEffect(() => {
    setDarkModeEnabled(colorScheme === 'dark');
  }, [colorScheme]);

  const localStorageMb = useMemo(
    () =>
      (uploads.data ?? [])
        .filter((item) => item.status !== 'COMPLETED')
        .reduce((total, item) => total + item.estimatedSizeMb, 0),
    [uploads.data],
  );
  const pendingUploads = (uploads.data ?? []).filter((item) => item.status !== 'COMPLETED').length;

  const handleDarkModeChange = (enabled: boolean) => {
    setDarkModeEnabled(enabled);
    const preference = enabled ? 'dark' : 'light';
    setThemePreference(preference);
    setColorScheme(preference);
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Any pending uploads remain safely queued on this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          signOut.mutate(undefined, { onSuccess: () => router.replace('/login') });
        },
      },
    ]);
  };

  const handleClearCache = () => {
    if (pendingUploads > 0) {
      Alert.alert(
        'Uploads Still Pending',
        `Finish the ${pendingUploads} pending upload${pendingUploads === 1 ? '' : 's'} before clearing local evidence.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Upload Center', onPress: () => router.push('/uploads') },
        ],
      );
      return;
    }
    Alert.alert(
      'Clear Local Cache',
      'Remove local copies of evidence that has already been uploaded? Server evidence is not deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            clearLocalRecordings();
            clearLocalSnapshots();
            clearLocalEvidence();
            Alert.alert('Cache Cleared', 'Uploaded evidence remains available from TexasRenters.');
          },
        },
      ],
    );
  };

  const handleStorageUsage = () =>
    Alert.alert(
      'Storage Usage',
      `${localStorageMb.toFixed(1)} MB is currently retained for pending room evidence.`,
    );
  const handleHelp = () =>
    Alert.alert(
      'Help & Documentation',
      'If an inspection, room, or floor plan is missing, contact your TexasRenters administrator.',
    );
  const handleAbout = () =>
    Alert.alert(
      `About ${appName}`,
      `Version ${appVersion}\n\nSecure property evidence capture for authorized TexasRenters technicians.\n\n© ${new Date().getFullYear()} TexasRenters.`,
    );

  const toggleShift = async (next: boolean) => {
    if (shiftBusy) return;
    setShiftBusy(true);
    try {
      if (!next) {
        await stopShiftTracking();
        setOnShift(false);
        return;
      }
      const result = await startShiftTracking();
      setOnShift(result.started);
      if (result.started) return;
      // Named, not generic. "Location unavailable" sends somebody to the wrong
      // settings screen; each of these is fixed in a different place.
      Alert.alert(
        'Could not start your shift',
        result.reason === 'UNSUPPORTED'
          ? 'This build of the app cannot record location. Ask the office for the current build, then try again.'
          : result.reason === 'UNAVAILABLE'
            ? 'Location services are switched off for this device. Turn them on in the system settings and try again.'
            : result.reason === 'FOREGROUND_DENIED'
              ? 'TexasRenters Inspect needs location access to record your shift. Allow it in the app’s settings and try again.'
              : 'Your shift needs location access set to “Allow all the time”, so it keeps recording while the app is in the background. Change it in the app’s settings and try again.',
      );
    } finally {
      setShiftBusy(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: tabBarInset + 24 }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader title="Settings" subtitle="Configure your inspection workflow" />

        <View className="mx-5 mt-5 flex-row items-center gap-4 rounded-2xl bg-card p-5">
          <View className="h-14 w-14 items-center justify-center rounded-full bg-primary/10">
            <UserIcon size={24} className="text-primary" />
          </View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-base font-bold text-foreground">
              {user.data?.name ?? 'Inspection technician'}
            </Text>
            <Text numberOfLines={1} className="text-sm text-muted-foreground">
              {user.data?.roleLabel ?? 'Authorized technician'}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Secure mobile account</Text>
          </View>
        </View>

        <GroupLabel>Shift</GroupLabel>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          {/* Off by default and never started automatically. Location is
              recorded only while a technician says they are working, and the
              notification stays up the whole time so it is never running
              unnoticed. */}
          <SettingSwitchRow
            icon={MapPinIcon}
            iconClassName="text-chart-2"
            iconBackground="bg-chart-2/15"
            title="On shift"
            description="Records your location for dispatch while you are working"
            last
            value={onShift}
            onValueChange={(next) => void toggleShift(next)}
          />
        </View>

        <GroupLabel>Preferences</GroupLabel>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <SettingSwitchRow
            icon={BellIcon}
            iconClassName="text-chart-4"
            iconBackground="bg-chart-4/15"
            title="Notifications"
            description="Inspection reminders and new assignment alerts"
            value={notificationsEnabled}
            onValueChange={setNotificationsEnabled}
          />
          {/* Named "Automatic upload", not "Background upload": the queue runs
              only while the app is in the foreground. There is no background
              task, and promising one would cost a technician their evidence. */}
          <SettingSwitchRow
            icon={HardDriveIcon}
            iconClassName="text-chart-3"
            iconBackground="bg-chart-3/15"
            title="Automatic Upload"
            description={
              autoUpload
                ? 'Send queued evidence while the app is open'
                : pendingUploads > 0
                  ? `Off · ${pendingUploads} upload${pendingUploads === 1 ? '' : 's'} waiting on this device`
                  : 'Off · evidence stays on this device until you turn this on'
            }
            value={autoUpload}
            onValueChange={setAutoUpload}
          />
          <SettingSwitchRow
            icon={WifiIcon}
            iconClassName="text-chart-2"
            iconBackground="bg-chart-2/10"
            title="Wi-Fi Only Uploads"
            description={
              !wifiOnlyUploads
                ? 'Upload over Wi-Fi or mobile data'
                : isMetered
                  ? 'On · paused, this connection is metered'
                  : 'On · uploads wait for an unmetered connection'
            }
            value={wifiOnlyUploads}
            onValueChange={setWifiOnlyUploads}
          />
          <SettingSwitchRow
            icon={MoonIcon}
            iconClassName="text-primary"
            iconBackground="bg-primary/10"
            title="Dark Mode"
            description={
              themePreference === 'system'
                ? `Following system · currently ${colorScheme === 'dark' ? 'dark' : 'light'}`
                : darkModeEnabled
                  ? 'Dark mode on'
                  : 'Light mode on'
            }
            value={darkModeEnabled}
            onValueChange={handleDarkModeChange}
            last
          />
        </View>

        <GroupLabel>Data &amp; Storage</GroupLabel>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <SettingLinkRow
            icon={DatabaseIcon}
            iconClassName="text-chart-2"
            iconBackground="bg-chart-2/15"
            title="Diagnostics"
            // The tester guide tells technicians to send "Copy diagnostics"
            // from this screen, so the description points at where it lives.
            description="Upload status, connectivity, and Copy diagnostics"
            onPress={() => router.push('/diagnostics')}
          />
          <SettingLinkRow
            icon={Trash2Icon}
            iconClassName="text-destructive"
            iconBackground="bg-destructive/10"
            title="Clear Local Cache"
            description="Free up storage, keep pending uploads"
            onPress={handleClearCache}
          />
          <SettingLinkRow
            icon={WrenchIcon}
            iconClassName="text-muted-foreground"
            iconBackground="bg-muted"
            title="Storage Usage"
            description={`${localStorageMb.toFixed(1)} MB retained locally`}
            onPress={handleStorageUsage}
            last
          />
        </View>

        <GroupLabel>Support</GroupLabel>
        <View className="mx-5 overflow-hidden rounded-2xl bg-card">
          <SettingLinkRow
            icon={HelpCircleIcon}
            iconClassName="text-chart-4"
            iconBackground="bg-chart-4/15"
            title="Help & Documentation"
            description="Inspection guides and best practices"
            onPress={handleHelp}
          />
          <SettingLinkRow
            icon={InfoIcon}
            iconClassName="text-muted-foreground"
            iconBackground="bg-muted"
            title="About"
            description={`${appName} v${appVersion}`}
            onPress={handleAbout}
            last
          />
        </View>

        <Pressable
          className="mx-5 mt-8 flex-row items-center gap-3 rounded-2xl border border-destructive/20 bg-card p-4 active:scale-[0.98]"
          onPress={handleLogout}
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

type IconComponent = typeof BellIcon;

function SettingSwitchRow({
  icon: Icon,
  iconClassName,
  iconBackground,
  title,
  description,
  value,
  onValueChange,
  last = false,
}: {
  icon: IconComponent;
  iconClassName: string;
  iconBackground: string;
  title: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  last?: boolean;
}) {
  const theme = useThemeColors();
  return (
    <View
      className={`min-h-14 flex-row items-center gap-3 px-4 py-3.5 ${
        last ? '' : 'border-b border-border'
      }`}
    >
      <View className={`h-9 w-9 items-center justify-center rounded-lg ${iconBackground}`}>
        <Icon size={18} className={iconClassName} />
      </View>
      {/* The title and description are read by the Switch's own label below.
          Hiding them here stops VoiceOver stopping three times on one row. */}
      <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
      </View>
      <Switch
        // These descriptions are stateful ("On · paused, this connection is
        // metered"), so carrying them into the label is what makes the toggle
        // comprehensible without sight.
        accessibilityLabel={`${title}. ${description}`}
        accessibilityRole="switch"
        accessibilityState={{ checked: value }}
        value={value}
        onValueChange={onValueChange}
        // Was `#14967d` on, which is `--chart-2` — so the app's toggles were
        // the one control not using the brand colour, and they used the same
        // pair in both themes. The off track is `--input`, the token that
        // already carries the 3:1 a control boundary needs.
        trackColor={{ false: theme.input, true: theme.primary }}
        // Fixed `#fff` sat at 1.9:1 on dark mode's bright teal, so a switch that
        // was on looked like a switch with no thumb. `card` contrasts with the
        // track in both themes.
        thumbColor={theme.card}
      />
    </View>
  );
}

function SettingLinkRow({
  icon: Icon,
  iconClassName,
  iconBackground,
  title,
  description,
  onPress,
  last = false,
}: {
  icon: IconComponent;
  iconClassName: string;
  iconBackground: string;
  title: string;
  description: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      // One stop per row, reading title then description, instead of three.
      accessibilityLabel={`${title}. ${description}`}
      accessibilityRole="button"
      className={`min-h-14 flex-row items-center gap-3 px-4 py-3.5 active:opacity-60 ${
        last ? '' : 'border-b border-border'
      }`}
      onPress={onPress}
    >
      <View className={`h-9 w-9 items-center justify-center rounded-lg ${iconBackground}`}>
        <Icon size={18} className={iconClassName} />
      </View>
      <View importantForAccessibility="no-hide-descendants" className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">{title}</Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">{description}</Text>
      </View>
      <ChevronRightIcon size={16} className="text-muted-foreground" />
    </Pressable>
  );
}
