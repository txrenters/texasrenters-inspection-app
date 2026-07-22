import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { ConnectedInspectionCard } from '../../../src/components/ConnectedInspectionCard';
import { MotionPressable } from '../../../src/components/motion';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  InitialsAvatar,
  SectionHeader,
  StatCard,
} from '../../../src/components/ui';
import { useCurrentUser, useDashboard } from '../../../src/features/queries';
import { type AppColors, radius, spacing, typography, useThemedStyles } from '../../../src/theme';

export default function DashboardScreen() {
  const styles = useThemedStyles(createStyles);
  const user = useCurrentUser();
  const dashboard = useDashboard();
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
          <MotionPressable
            accessibilityRole="button"
            onPress={() => router.push('/(app)/(tabs)/inspections')}
            style={styles.linkButton}
            scaleTo={0.96}
          >
            <Text style={styles.link}>View all</Text>
            <Ionicons name="arrow-forward" size={15} style={styles.linkIcon} />
          </MotionPressable>
        }
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
            title="No inspections assigned"
            message="Your workspace starts empty. An administrator must assign an inspection before it appears here."
          />
        )}
      </View>
      <SectionHeader title="Quick actions" icon="flash-outline" />
      <View style={styles.quickActions}>
        <Card muted>
          <View style={styles.quickHeader}>
            <View style={styles.quickIcon}>
              <Ionicons name="clipboard-outline" size={20} style={styles.quickIconGlyph} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.quickTitle}>Inspection queue</Text>
              <Text style={styles.quickBody}>
                Search all assigned and recently completed inspections.
              </Text>
            </View>
          </View>
          <AppButton
            label="View inspections"
            variant="outline"
            onPress={() => router.push('/(app)/(tabs)/inspections')}
            compact
            icon="arrow-forward"
          />
        </Card>
        <Card muted>
          <View style={styles.quickHeader}>
            <View style={styles.quickIcon}>
              <Ionicons name="cloud-upload-outline" size={20} style={styles.quickIconGlyph} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.quickTitle}>Upload center</Text>
              <Text style={styles.quickBody}>Monitor local videos, retries, and AI processing.</Text>
            </View>
          </View>
          <AppButton
            label="Open uploads"
            variant="outline"
            onPress={() => router.push('/(app)/(tabs)/uploads')}
            compact
            icon="arrow-forward"
          />
        </Card>
      </View>
    </AppScreen>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    list: { gap: spacing.md },
    flex: { flex: 1, minWidth: 0 },
    linkButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: radius.round,
      backgroundColor: colors.primarySoft,
    },
    link: { ...typography.label, color: colors.primary },
    linkIcon: { color: colors.primary },
    quickActions: { gap: spacing.md },
    quickHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    quickIcon: {
      width: 42,
      height: 42,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    quickIconGlyph: { color: colors.primary },
    quickTitle: { ...typography.heading, color: colors.textPrimary },
    quickBody: { ...typography.body, color: colors.textSecondary },
  });
