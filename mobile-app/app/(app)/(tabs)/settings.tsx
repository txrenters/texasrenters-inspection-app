import { useState, type ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
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
      eyebrow="ACCOUNT & PREFERENCES"
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
            icon="people-outline"
          />
        ) : null}
      </Card>
      <SectionHeader title="Environment" icon="server-outline" />
      <Card muted>
        <SettingRow
          icon="git-network-outline"
          label="Data source"
          value={isDemoMode ? 'Test fixtures' : 'TexasRenters REST API'}
        />
        <SettingRow
          icon="pulse-outline"
          label="Backend status"
          value={environment.apiBaseUrl ? 'Configured' : 'Not configured'}
        />
        <SettingRow
          icon="phone-portrait-outline"
          label="App version"
          value={Constants.expoConfig?.version ?? '0.1.0'}
        />
        <SettingRow
          icon="color-palette-outline"
          label="Theme"
          value={`${theme.preference.charAt(0).toUpperCase()}${theme.preference.slice(1)}`}
        />
      </Card>
      <SectionHeader title="Appearance" icon="color-palette-outline" />
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
      {isDemoMode ? <SectionHeader title="Simulation controls" icon="flask-outline" /> : null}
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
      {isDemoMode ? <SectionHeader title="Demo data" icon="archive-outline" /> : null}
      {isDemoMode ? (
        <Card>
          <Text style={styles.body}>
            Reset the selected user, inspection progress, room notes, local media, upload queue,
            failures, and finding decisions.
          </Text>
          <AppButton
            label="Reset demo data"
            variant="danger"
            onPress={() => setResetOpen(true)}
            icon="trash-outline"
          />
        </Card>
      ) : null}
      <AppButton
        label="Sign out"
        variant="ghost"
        icon="log-out-outline"
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

function SettingRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: ComponentProps<typeof Ionicons>['name'];
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingIdentity}>
        <View style={styles.settingIcon}>
          <Ionicons name={icon} size={16} style={styles.settingIconGlyph} />
        </View>
        <Text style={styles.settingLabel}>{label}</Text>
      </View>
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
      minHeight: 48,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: spacing.md,
    },
    settingIdentity: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
    settingIcon: {
      width: 30,
      height: 30,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    settingIconGlyph: { color: colors.primary },
    settingLabel: { ...typography.label, color: colors.textPrimary },
    settingValue: { ...typography.body, color: colors.textSecondary, textAlign: 'right' },
    toggleRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    description: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
    chips: { flexDirection: 'row', gap: spacing.sm },
  });
