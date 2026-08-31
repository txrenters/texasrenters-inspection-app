import { router } from 'expo-router';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  Settings2Icon,
} from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTabBarInset } from '@/src/lib/tab-bar-inset';
import type { Inspection } from '@/src/domain/models';
import {
  InspectionUrgencyBadge,
  useInspectionUrgency,
} from '@/src/components/InspectionUrgencyBadge';
import { useCurrentUser, useDashboard, useDayRoute } from '@/src/features/queries';
import { InspectionListSkeleton } from '@/src/components/ui/Skeleton';
import { HomeEmptyState } from '@/src/components/HomeEmptyState';
import { DayRouteSummary } from '@/src/components/DayRouteSummary';
import { hasNeverBeenAssigned } from '@/src/utils/home-state';
import { useLocalNow } from '@/src/features/useLocalNow';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { formatVisitDateAndWindow } from '@/src/utils/visit-window';
import { greetingFor } from '@/src/utils/greeting';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { PRESS_ROW, ScreenHeader, SectionHeader } from '@/src/components/ui';

registerIcons(CheckCircle2Icon, ChevronRightIcon, ClipboardListIcon, MapPinIcon, Settings2Icon);

/**
 * The day, and the visit window when the office booked one.
 *
 * The time no longer comes from `scheduledAt`. That column is a date, so
 * formatting an hour out of it rendered the midnight its storage implies —
 * every assignment read "12:00 AM", a time nobody scheduled. A real window is
 * shown when Jobber supplied one, and otherwise the row says only the day.
 */
function inspectionDate(inspection: Inspection, includeTime = false) {
  const date = new Date(inspection.scheduledAt).toLocaleDateString('en-US', {
    weekday: includeTime ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
  });
  return includeTime ? formatVisitDateAndWindow(inspection, date) : date;
}

/**
 * One upcoming assignment. Its own component so the urgency hook — which ticks
 * on the minute — re-renders just this row rather than the whole dashboard.
 */
function AssignedInspectionRow({ inspection }: { inspection: Inspection }) {
  const urgency = useInspectionUrgency(inspection);
  return (
    <Pressable
      accessibilityLabel={[
        inspection.property.address,
        inspection.unitName ?? 'Entire property',
        inspectionDate(inspection, true),
        // The badge sits in a hidden subtree, so the row's label is the only
        // route to a screen reader.
        urgency?.spoken ?? '',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      accessibilityHint="Opens this inspection"
      className="mx-5 min-h-14 flex-row items-center gap-3 border-b border-border py-3.5 active:opacity-60"
      onPress={() => router.push(`/inspections/${inspection.id}`)}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        className="flex-1 flex-row items-center gap-3"
      >
        <View
          className={`h-2 w-2 rounded-full ${urgency?.overdue ? 'bg-destructive' : 'bg-chart-4'}`}
        />
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-medium text-foreground">
            {inspection.property.address}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-xs text-muted-foreground">
            {inspection.unitName ?? 'Entire property'} · {inspectionDate(inspection, true)}
          </Text>
          {urgency ? (
            <View className="mt-1 flex-row">
              <InspectionUrgencyBadge inspection={inspection} />
            </View>
          ) : null}
        </View>
        <ChevronRightIcon size={16} className="text-muted-foreground" />
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const tabBarInset = useTabBarInset();
  const dashboard = useDashboard();
  const dayRoute = useDayRoute();
  // Bound to a user-initiated pull only. Wiring this to `isRefetching` made the
  // spinner appear on its own every 60s, when the assignment poll ran.
  const pull = usePullToRefresh([dashboard.refetch, dayRoute.refetch]);
  const user = useCurrentUser();
  const theme = useThemeColors();
  const firstName = user.data?.name.split(/\s+/)[0] || 'Technician';
  // Both of these read the device's own clock and time zone, so they are
  // already right whether the technician is in Texas or Manila. Ticking rather
  // than computed once at render: this screen stays open, and it used to keep
  // saying "Good morning" into the evening and show yesterday's date after
  // midnight.
  const now = useLocalNow();
  const greeting = greetingFor(now);
  const today = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const assignments = dashboard.data?.assignments ?? [];
  const assigned = assignments.filter((item) => item.status === 'SCHEDULED');
  const inProgress = assignments.filter((item) => item.status === 'IN_PROGRESS');
  const completed = dashboard.data?.recent ?? [];
  // Only meaningful once the dashboard has answered: mid-load every count is
  // zero, which would flash the welcome screen at an established technician on
  // every cold start.
  const neverAssigned =
    !dashboard.isLoading &&
    hasNeverBeenAssigned({
      assignedCount: assigned.length,
      inProgressCount: inProgress.length,
      inProgressTotal: dashboard.data?.inProgress ?? 0,
      completedTotal: dashboard.data?.completed ?? 0,
      recentCount: completed.length,
    });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: tabBarInset + 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.primary}
          />
        }
      >
        {/* "Ready for your inspections today" is a strange thing to read on a
            screen with no inspections on it — and the first thing a new
            technician sees. It only claims that when there is something to
            be ready for. */}
        <ScreenHeader
          eyebrow={today}
          subtitle={
            neverAssigned
              ? 'Nothing assigned to you yet'
              : assigned.length + inProgress.length > 0
                ? 'Ready for your inspections today'
                : 'No inspections pending right now'
          }
          title={`${greeting}, ${firstName}`}
        />

        {dashboard.isError ? (
          <View className="mx-5 mt-5 rounded-2xl border border-destructive/20 bg-destructive/10 p-4">
            <Text className="font-semibold text-destructive">Dashboard unavailable</Text>
            <Text className="mt-1 text-sm text-destructive">
              {dashboard.error instanceof Error
                ? dashboard.error.message
                : 'Check the API connection and retry.'}
            </Text>
          </View>
        ) : null}

        <View className="mt-5 flex-row gap-3 px-5">
          <View className="flex-1 rounded-2xl bg-card p-4">
            <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-chart-4/15">
              <ClipboardListIcon size={18} className="text-chart-4" />
            </View>
            <Text className="text-3xl font-bold text-foreground">{assigned.length}</Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Assigned</Text>
          </View>
          <View className="flex-1 rounded-2xl bg-card p-4">
            <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-chart-2/15">
              <Settings2Icon size={18} className="text-chart-2" />
            </View>
            <Text className="text-3xl font-bold text-foreground">
              {dashboard.data?.inProgress ?? inProgress.length}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">In Progress</Text>
          </View>
          <View className="flex-1 rounded-2xl bg-card p-4">
            <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-chart-3/15">
              <CheckCircle2Icon size={18} className="text-chart-3" />
            </View>
            <Text className="text-3xl font-bold text-foreground">
              {dashboard.data?.completed ?? completed.length}
            </Text>
            <Text className="mt-0.5 text-xs text-muted-foreground">Completed</Text>
          </View>
        </View>

        {inProgress.length > 0 ? (
          <View className="mt-6">
            <SectionHeader title="Continue Inspection" />
            {inProgress.map((inspection) => (
              <Pressable
                key={inspection.id}
                // Grouped: otherwise VoiceOver stops on address, unit, city,
                // "In Progress" and date as five separate items per card.
                accessibilityLabel={[
                  inspection.property.address,
                  inspection.unitName ?? 'Entire property',
                  inspection.property.cityStateZip,
                  'In progress',
                  inspectionDate(inspection),
                ].join(', ')}
                accessibilityRole="button"
                accessibilityHint="Opens this inspection"
                className="mx-5 mb-3 rounded-2xl bg-card p-4 active:scale-[0.98]"
                onPress={() => router.push(`/inspections/${inspection.id}`)}
              >
                <View
                  importantForAccessibility="no-hide-descendants"
                  className="flex-row items-start gap-3"
                >
                  <View className="mt-0.5 h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                    <MapPinIcon size={18} className="text-primary" />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-base font-semibold text-foreground">
                      {inspection.property.address}
                    </Text>
                    <Text numberOfLines={1} className="mt-0.5 text-sm text-muted-foreground">
                      {inspection.unitName ?? 'Entire property'} ·{' '}
                      {inspection.property.cityStateZip}
                    </Text>
                    <View className="mt-2 flex-row items-center gap-2">
                      <View className="rounded-full bg-chart-2/20 px-2.5 py-0.5">
                        <Text className="text-xs font-semibold text-chart-2">In Progress</Text>
                      </View>
                      <Text className="text-xs text-muted-foreground">
                        {inspectionDate(inspection)}
                      </Text>
                    </View>
                  </View>
                  <ChevronRightIcon size={18} className="mt-3 text-muted-foreground" />
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}

        <DayRouteSummary route={dayRoute.data} />

        <View className="mt-6">
          <SectionHeader
            action={
              <Pressable
                accessibilityLabel="See all inspections"
                accessibilityRole="button"
                className={`min-h-11 justify-center px-1 ${PRESS_ROW}`}
                onPress={() => router.push('/inspections')}
              >
                <Text className="text-sm font-semibold text-primary">See all</Text>
              </Pressable>
            }
            title="Upcoming"
          />
          {assigned.map((inspection) => (
            <AssignedInspectionRow inspection={inspection} key={inspection.id} />
          ))}
          {dashboard.isLoading && assigned.length === 0 ? (
            <InspectionListSkeleton rows={3} />
          ) : null}
          {!dashboard.isLoading && assigned.length === 0 ? (
            <HomeEmptyState neverAssigned={neverAssigned} />
          ) : null}
        </View>

        {completed.length > 0 ? (
          <View className="mb-2 mt-6">
            <SectionHeader title="Recently Completed" />
            {completed.slice(0, 2).map((inspection) => (
              <Pressable
                key={inspection.id}
                accessibilityLabel={`${inspection.property.address}, completed, ${inspection.progress.completed} of ${inspection.progress.total} rooms`}
                accessibilityRole="button"
                accessibilityHint="Opens this inspection"
                className="mx-5 min-h-14 flex-row items-center gap-3 py-3 active:opacity-60"
                onPress={() => router.push(`/inspections/${inspection.id}`)}
              >
                <View className="h-9 w-9 items-center justify-center rounded-full bg-chart-3/15">
                  <CheckCircle2Icon size={16} className="text-chart-3" />
                </View>
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="text-sm font-medium text-foreground">
                    {inspection.property.address}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {inspection.progress.completed} of {inspection.progress.total} rooms completed
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
