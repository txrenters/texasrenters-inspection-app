import type { ComponentProps } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { ConnectedInspectionCard } from '../../../src/components/ConnectedInspectionCard';
import { InspectionAlertBanner } from '../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import {
  InitialsAvatar,
  SectionHeader,
  StatCard,
} from '../../../src/components/ui';
import { useCurrentUser, useDashboard } from '../../../src/features/queries';
import { useInspectionAlerts } from '../../../src/features/useInspectionAlerts';
import { type AppColors, radius, spacing, typography, useThemedStyles } from '../../../src/theme';

export default function DashboardScreen() {
  const styles = useThemedStyles(createStyles);
  const user = useCurrentUser();
  const dashboard = useDashboard();
  const alerts = useInspectionAlerts();
  if (user.isLoading || dashboard.isLoading)
    return <LoadingState label="Building today’s route…" />;
  if (dashboard.isError)
    return (
      <ErrorState message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />
    );
  const firstName = user.data?.name.split(' ')[0] ?? 'Technician';
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  return (
    <AppScreen
      title={`Good morning, ${firstName}`}
      subtitle={date}
      eyebrow="TODAY’S FIELD PLAN"
      action={user.data ? <InitialsAvatar initials={user.data.initials} /> : null}
      refresh={{ onRefresh: () => dashboard.refetch() }}
    >
      <View style={styles.stats}>
        <StatCard
          value={dashboard.data?.today ?? 0}
          label="Today’s inspections"
          icon="calendar-outline"
        />
        <StatCard
          value={dashboard.data?.inProgress ?? 0}
          label="In progress"
          tone="info"
          icon="time-outline"
        />
        <StatCard
          value={dashboard.data?.completed ?? 0}
          label="Completed"
          tone="success"
          icon="checkmark-circle-outline"
        />
        <StatCard
          value={dashboard.data?.pendingUploads ?? 0}
          label="Pending uploads"
          tone="warning"
          icon="cloud-upload-outline"
        />
      </View>
      <SectionHeader
        title="Today’s assignments"
        icon="navigate-outline"
        action={
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/(app)/(tabs)/inspections')}
          >
            <Text style={styles.link}>View all</Text>
          </Pressable>
        }
      />
      <InspectionAlertBanner
        overdueCount={alerts.overdueCount}
        dueSoonCount={alerts.dueSoonCount}
        onPress={() => router.push('/(app)/(tabs)/inspections')}
      />
      <View style={styles.list}>
        {dashboard.data?.assignments.length ? (
          dashboard.data.assignments.map((inspection) => (
            <ConnectedInspectionCard
              key={inspection.id}
              inspection={inspection}
              onPress={() =>
                router.push({
                  pathname: '/(app)/inspections/[inspectionId]',
                  params: { inspectionId: inspection.id },
                })
              }
            />
          ))
        ) : (
          <EmptyState
            compact
            title="No inspections assigned"
            message="Your workspace starts empty. An administrator must assign an inspection before it appears here."
          />
        )}
      </View>
      <SectionHeader title="Quick actions" icon="flash-outline" />
      <View style={styles.actionList}>
        <QuickActionRow
          icon="clipboard-outline"
          title="Inspection queue"
          description="Search assigned and recently completed inspections."
          onPress={() => router.push('/(app)/(tabs)/inspections')}
        />
        <QuickActionRow
          icon="cloud-upload-outline"
          title="Upload center"
          description="Monitor local videos, retries, and AI processing."
          onPress={() => router.push('/(app)/(tabs)/uploads')}
        />
      </View>
    </AppScreen>
  );
}

function QuickActionRow({
  icon,
  title,
  description,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  description: string;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.pressedRow]}
    >
      <Ionicons name={icon} size={22} style={styles.actionIcon} />
      <View style={styles.actionCopy}>
        <Text style={styles.quickTitle}>{title}</Text>
        <Text style={styles.quickBody}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={19} style={styles.chevron} />
    </Pressable>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    stats: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      overflow: 'hidden',
      borderRadius: radius.lg,
      backgroundColor: colors.surface,
      padding: spacing.xs,
    },
    list: { gap: spacing.md },
    link: { ...typography.label, color: colors.primary },
    actionList: {
      gap: spacing.sm,
    },
    actionRow: {
      minHeight: 68,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    pressedRow: { opacity: 0.65 },
    actionIcon: { color: colors.primary },
    actionCopy: { flex: 1, minWidth: 0 },
    chevron: { color: colors.textSecondary },
    quickTitle: { ...typography.heading, color: colors.textPrimary },
    quickBody: { ...typography.body, color: colors.textSecondary },
  });
