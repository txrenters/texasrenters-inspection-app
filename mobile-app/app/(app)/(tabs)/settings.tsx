import { useState } from 'react';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { AppScreen } from '../../../src/components/AppScreen';
import {
  AppButton,
  Card,
  ConfirmationModal,
  FilterChip,
  InitialsAvatar,
  SectionHeader,
  StatusBadge,
} from '../../../src/components/ui';
import { environment, isDemoMode } from '../../../src/config/environment';
import { useCurrentUser, useSignOut } from '../../../src/features/queries';
import { clearLocalRecordings } from '../../../src/media/local-recordings';
import { clearLocalSnapshots } from '../../../src/media/local-snapshots';
import { useDemoStore } from '../../../src/stores/demo.store';
import {
  type AppColors,
  spacing,
  typography,
  useAppTheme,
  useThemedStyles,
} from '../../../src/theme';

export default function SettingsScreen() {
  const theme = useAppTheme();
  const styles = useThemedStyles(createStyles);
  const user = useCurrentUser();
  const client = useQueryClient();
  const state = useDemoStore();
  const signOut = useSignOut();
  const [resetOpen, setResetOpen] = useState(false);
  const reset = () => {
    clearLocalRecordings();
    clearLocalSnapshots();
    state.resetDemoData();
    client.clear();
    setResetOpen(false);
    router.replace('/(auth)/welcome');
  };
  return (
    <AppScreen
      title="Settings"
      subtitle={
        isDemoMode ? 'Demo environment and field simulation controls' : 'Secure technician account'
      }
    >
      <Card>
        <View style={styles.profileRow}>
          {user.data ? <InitialsAvatar initials={user.data.initials} /> : null}
          <View style={styles.flex}>
            <Text style={styles.profileName}>{user.data?.name ?? 'Technician'}</Text>
            <Text style={styles.body}>{user.data?.roleLabel ?? 'Inspection technician'}</Text>
          </View>
          <StatusBadge
            label={isDemoMode ? 'DEMO' : 'SECURE'}
            tone={isDemoMode ? 'info' : 'success'}
          />
        </View>
        {isDemoMode ? (
          <AppButton
            label="Switch demo role"
            variant="outline"
            onPress={() => router.push('/(auth)/login')}
            compact
          />
        ) : null}
      </Card>
      <SectionHeader title="Environment" />
      <Card muted>
        <SettingRow
          label="Data source"
          value={isDemoMode ? 'Test fixtures' : 'TexasRenters REST API'}
        />
        <SettingRow
          label="Backend status"
          value={environment.apiBaseUrl ? 'Configured' : 'Not configured'}
        />
        <SettingRow label="App version" value={Constants.expoConfig?.version ?? '0.1.0'} />
        <SettingRow
          label="Theme"
          value={`${theme.preference.charAt(0).toUpperCase()}${theme.preference.slice(1)}`}
        />
      </Card>
      <SectionHeader title="Appearance" />
      <Card>
        <Text style={styles.settingLabel}>Color theme</Text>
        <View style={styles.chips}>
          {(['light', 'dark', 'system'] as const).map((preference) => (
            <FilterChip
              key={preference}
              label={`${preference.charAt(0).toUpperCase()}${preference.slice(1)}`}
              selected={theme.preference === preference}
              onPress={() => theme.setPreference(preference)}
            />
          ))}
        </View>
        <Text style={styles.description}>System follows your device appearance automatically.</Text>
      </Card>
      {isDemoMode ? <SectionHeader title="Simulation controls" /> : null}
      {isDemoMode ? (
        <Card>
          <ToggleRow
            label="Network online"
            description="Turn off to keep uploads pending while inspections remain available."
            value={state.isOnline}
            onValueChange={state.setOnline}
          />
          <ToggleRow
            label="Mock processing failure"
            description="Fails active AI processing so retry states can be demonstrated."
            value={state.processingFailureEnabled}
            onValueChange={state.setProcessingFailure}
          />
          <ToggleRow
            label="Mock repository error"
            description="Shows reusable loading error and retry states."
            value={state.mockErrorEnabled}
            onValueChange={state.setMockError}
          />
          <Text style={styles.settingLabel}>Upload simulation speed</Text>
          <View style={styles.chips}>
            {([1, 2, 3] as const).map((speed) => (
              <FilterChip
                key={speed}
                label={`${speed}×`}
                selected={state.uploadSpeed === speed}
                onPress={() => state.setUploadSpeed(speed)}
              />
            ))}
          </View>
        </Card>
      ) : null}
      {isDemoMode ? <SectionHeader title="Demo data" /> : null}
      {isDemoMode ? (
        <Card>
          <Text style={styles.body}>
            Reset the selected user, inspection progress, room notes, local media, upload queue,
            failures, and finding decisions.
          </Text>
          <AppButton label="Reset demo data" variant="danger" onPress={() => setResetOpen(true)} />
        </Card>
      ) : null}
      <AppButton
        label="Sign out"
        variant="ghost"
        onPress={() => {
          if (isDemoMode) {
            state.signOut();
            client.clear();
            router.replace('/(auth)/welcome');
          } else {
            signOut.mutate(undefined, {
              onSuccess: () => router.replace('/(auth)/welcome'),
            });
          }
        }}
      />
      {isDemoMode ? (
        <ConfirmationModal
          visible={resetOpen}
          title="Reset all demo data?"
          message="Every locally simulated change will return to the original management-demo state."
          confirmLabel="Reset demo"
          destructive
          onCancel={() => setResetOpen(false)}
          onConfirm={reset}
        />
      ) : null}
    </AppScreen>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.settingValue}>{value}</Text>
    </View>
  );
}
function ToggleRow({
  label,
  description,
  value,
  onValueChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.toggleRow}>
      <View style={styles.flex}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primarySoft }}
        thumbColor={value ? colors.primary : colors.textSecondary}
      />
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    profileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    flex: { flex: 1 },
    profileName: { ...typography.heading, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary },
    settingRow: {
      minHeight: 38,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.md,
    },
    settingLabel: { ...typography.label, color: colors.textPrimary },
    settingValue: { ...typography.body, color: colors.textSecondary, textAlign: 'right' },
    toggleRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    description: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
    chips: { flexDirection: 'row', gap: spacing.sm },
  });
