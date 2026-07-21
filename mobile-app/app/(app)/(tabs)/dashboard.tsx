import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { ConnectedInspectionCard } from '../../../src/components/ConnectedInspectionCard';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import {
  AppButton,
  Card,
  InitialsAvatar,
  SectionHeader,
  StatCard,
} from '../../../src/components/ui';
import { useCurrentUser, useDashboard } from '../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../src/theme';

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
      action={user.data ? <InitialsAvatar initials={user.data.initials} /> : null}
      refresh={{ refreshing: dashboard.isFetching, onRefresh: () => void dashboard.refetch() }}
    >
      <View style={styles.stats}>
        <StatCard value={dashboard.data?.today ?? 0} label="Today’s inspections" />
        <StatCard value={dashboard.data?.inProgress ?? 0} label="In progress" tone="info" />
        <StatCard value={dashboard.data?.completed ?? 0} label="Completed" tone="success" />
        <StatCard
          value={dashboard.data?.pendingUploads ?? 0}
          label="Pending uploads"
          tone="warning"
        />
      </View>
      <SectionHeader
        title="Today’s assignments"
        action={
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/(app)/(tabs)/inspections')}
          >
            <Text style={styles.link}>View all</Text>
          </Pressable>
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
      <SectionHeader title="Quick actions" />
      <View style={styles.quickActions}>
        <Card muted>
          <Text style={styles.quickTitle}>Inspection queue</Text>
          <Text style={styles.quickBody}>
            Search all assigned and recently completed inspections.
          </Text>
          <AppButton
            label="View inspections"
            variant="outline"
            onPress={() => router.push('/(app)/(tabs)/inspections')}
            compact
          />
        </Card>
        <Card muted>
          <Text style={styles.quickTitle}>Upload center</Text>
          <Text style={styles.quickBody}>Monitor local videos, retries, and AI processing.</Text>
          <AppButton
            label="Open uploads"
            variant="outline"
            onPress={() => router.push('/(app)/(tabs)/uploads')}
            compact
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
    link: { ...typography.label, color: colors.primary },
    quickActions: { gap: spacing.md },
    quickTitle: { ...typography.heading, color: colors.textPrimary },
    quickBody: { ...typography.body, color: colors.textSecondary },
  });
