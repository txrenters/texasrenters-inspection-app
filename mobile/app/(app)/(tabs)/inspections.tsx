import { useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarDaysIcon, SearchIcon, XIcon } from 'lucide-react-native';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DayStrip } from '@/src/components/DayStrip';
import { JobRow } from '@/src/components/JobRow';
import { MonthCalendarSheet } from '@/src/components/MonthCalendarSheet';
import { ScreenHeader, SegmentedControl } from '@/src/components/ui';
import { InspectionListSkeleton } from '@/src/components/ui/Skeleton';
import type { Inspection } from '@/src/domain/models';
import {
  useInspectionPages,
  useJobDays,
  usePrefetchInspectionPages,
} from '@/src/features/queries';
import { useLocalNow } from '@/src/features/useLocalNow';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { registerIcons } from '@/src/lib/icons';
import { useTabBarInset } from '@/src/lib/tab-bar-inset';
import { useThemeColors } from '@/src/lib/theme-colors';
import type { InspectionListFilters, InspectionPage } from '@/src/repositories/contracts';
import { FIELD_ACTIVE_STATUSES, SUBMITTED_STATUSES } from '@/src/utils/inspection-status';
import { addDays, dayHeading, dayRange, texasToday, type JobDay } from '@/src/utils/job-day';
import {
  historySections,
  scheduleSections,
  searchSections,
  type JobSection,
} from '@/src/utils/job-sections';

registerIcons(CalendarDaysIcon, SearchIcon, XIcon);

/**
 * The Jobs tab: a day at a time, a History of finished work, and one search.
 *
 * It was a list of every job ever assigned behind six status chips, opening on
 * "All" with the oldest first -- so a job left open weeks ago sat above this
 * morning's round. The office asked for a calendar (2026-10-07): the schedule
 * shows one day, today unless another is picked, with anything still open from
 * earlier days at the top of today; History shows submitted and completed work,
 * newest first, on the same calendar; and the search covers every job,
 * whatever the day or the view.
 */

type JobsView = 'schedule' | 'history';

const VIEWS = [
  { value: 'schedule', label: 'Schedule' },
  { value: 'history', label: 'History' },
] as const;

/** How far the schedule's strip reaches either side of where it is anchored. */
const SCHEDULE_DAYS_BEFORE = 14;
const SCHEDULE_DAYS_AFTER = 30;
/** History's strip: the last six-odd weeks, ending today. */
const HISTORY_STRIP_DAYS = 45;

/** Typing pause before the search reaches the server. */
const SEARCH_DEBOUNCE_MS = 300;

/** A search and the still-open list ask for more per page: both are short and wanted whole. */
const LONG_PAGE = 50;

function useDebounced<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

const rowsOf = (data: { pages: InspectionPage[] } | undefined): Inspection[] =>
  data?.pages.flatMap((page) => page.items) ?? [];

export default function JobsScreen() {
  const tabBarInset = useTabBarInset();
  const theme = useThemeColors();
  const now = useLocalNow();
  const today = useMemo(() => texasToday(now), [now]);
  const params = useLocalSearchParams<{ day?: string }>();

  const [view, setView] = useState<JobsView>('schedule');
  const [day, setDay] = useState<JobDay>(today);
  const [scheduleAnchor, setScheduleAnchor] = useState<JobDay>(today);
  /** History's chosen day; null is every date. */
  const [historyDay, setHistoryDay] = useState<JobDay | null>(null);
  const [historyEnd, setHistoryEnd] = useState<JobDay>(today);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const searching = query.length > 0;
  // A settling search is still the previous answer; saying "nothing found"
  // mid-keystroke would be the wrong answer.
  const searchPending = search.trim() !== query;

  // Home's "See all" opens today's schedule, wherever the list was left.
  useEffect(() => {
    if (params.day !== 'today') return;
    setView('schedule');
    setDay(today);
    setScheduleAnchor(today);
    setSearch('');
    router.setParams({ day: undefined });
  }, [params.day, today]);

  // Midnight while the app is open: a list that was on today follows today.
  const lastToday = useRef(today);
  useEffect(() => {
    const previous = lastToday.current;
    if (previous === today) return;
    lastToday.current = today;
    setDay((current) => (current === previous ? today : current));
    setScheduleAnchor((current) => (current === previous ? today : current));
    setHistoryEnd((current) => (current === previous ? today : current));
  }, [today]);

  const stripDays = useMemo(
    () =>
      view === 'schedule'
        ? dayRange(
            addDays(scheduleAnchor, -SCHEDULE_DAYS_BEFORE),
            addDays(scheduleAnchor, SCHEDULE_DAYS_AFTER),
          )
        : dayRange(addDays(historyEnd, -(HISTORY_STRIP_DAYS - 1)), historyEnd),
    [view, scheduleAnchor, historyEnd],
  );
  const stripStatuses = view === 'history' ? SUBMITTED_STATUSES : undefined;
  const dayCounts = useJobDays({
    from: stripDays[0]!,
    to: stripDays[stripDays.length - 1]!,
    statuses: stripStatuses,
  });
  const counts = useMemo(
    () => new Map((dayCounts.data ?? []).map((count) => [count.day, count])),
    [dayCounts.data],
  );

  const historyAll: InspectionListFilters = { statuses: SUBMITTED_STATUSES, order: 'recent' };
  const mainFilters: InspectionListFilters = searching
    ? { search: query, order: 'recent', pageSize: LONG_PAGE }
    : view === 'schedule'
      ? { scheduledOn: day }
      : historyDay
        ? { ...historyAll, scheduledOn: historyDay }
        : historyAll;
  // Kept while a search is typed, so results do not blank between keys; never
  // across days, where yesterday's jobs under today's heading would be wrong.
  // The neighbouring days are prefetched instead, so a day still opens at once.
  const main = useInspectionPages(mainFilters, { keepPrevious: searching });
  const stillOpenWanted = !searching && view === 'schedule' && day === today;
  const stillOpen = useInspectionPages(
    { statuses: FIELD_ACTIVE_STATUSES, scheduledBefore: today, pageSize: LONG_PAGE },
    { enabled: stillOpenWanted },
  );

  const prefetch = usePrefetchInspectionPages();
  useEffect(() => {
    if (searching || view !== 'schedule') return;
    void prefetch({ scheduledOn: addDays(day, 1) });
    void prefetch({ scheduledOn: addDays(day, -1) });
  }, [day, view, searching, prefetch]);
  useEffect(() => {
    // History's first page, before anyone switches to it.
    void prefetch({ statuses: SUBMITTED_STATUSES, order: 'recent' });
  }, [prefetch]);

  const pull = usePullToRefresh([
    main.refetch,
    dayCounts.refetch,
    async () => {
      if (stillOpenWanted) await stillOpen.refetch();
    },
  ]);

  const rows = useMemo(() => rowsOf(main.data), [main.data]);
  const stillOpenRows = useMemo(
    () => (stillOpenWanted ? rowsOf(stillOpen.data) : []),
    [stillOpenWanted, stillOpen.data],
  );
  const sections: JobSection[] = useMemo(() => {
    if (searching) return searchSections(rows, today);
    if (view === 'history') return historySections(rows, today);
    return scheduleSections({ day, today, rows, stillOpen: stillOpenRows });
  }, [searching, view, rows, today, day, stillOpenRows]);
  // A single day's list needs no heading of its own: the row of controls above
  // it already names the day.
  const showSectionHeaders = searching || view === 'history' || sections.length > 1;

  const total = main.data?.pages[0]?.total ?? 0;
  const loading = main.isLoading || searchPending;

  const chosenDay = view === 'schedule' ? day : historyDay;
  const pickDay = (picked: JobDay) => {
    setCalendarOpen(false);
    if (view === 'schedule') {
      setDay(picked);
      // A day off the strip moves the strip to it; one on it leaves it be.
      if (!stripDays.includes(picked)) setScheduleAnchor(picked);
      return;
    }
    setHistoryDay(picked);
    if (!stripDays.includes(picked)) setHistoryEnd(addDays(picked, 7) > today ? today : addDays(picked, 7));
  };
  const goToday = () => {
    setDay(today);
    setScheduleAnchor(today);
  };

  const heading = searching
    ? `${total} found`
    : view === 'schedule'
      ? `${dayHeading(day, today)}${main.data ? ` · ${total} job${total === 1 ? '' : 's'}` : ''}`
      : `${historyDay ? dayHeading(historyDay, today) : 'All dates'}${
          main.data ? ` · ${total} finished` : ''
        }`;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <SectionList
        sections={sections}
        keyExtractor={(item, index) => `${item.id}:${index}`}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: tabBarInset + 24 }}
        showsVerticalScrollIndicator={false}
        // Half a screen of runway, so the next page is usually in hand before
        // the technician reaches the bottom.
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          // Guarded: this fires repeatedly near the end, and an unguarded call
          // would queue duplicate requests for the same page.
          if (main.hasNextPage && !main.isFetchingNextPage) void main.fetchNextPage();
        }}
        ListFooterComponent={
          main.isFetchingNextPage ? (
            <View className="py-6">
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={theme.primary} />
        }
        ListHeaderComponent={
          <View>
            <ScreenHeader title="Jobs" />
            <View className="mx-5 mt-1 flex-row items-center gap-3 rounded-xl bg-card px-4 py-2.5">
              <SearchIcon size={18} className="text-muted-foreground" />
              <TextInput
                accessibilityLabel="Search every job"
                autoCorrect={false}
                className="flex-1 text-base text-foreground"
                placeholder="Search every job: address, city, type…"
                placeholderTextColor={theme.mutedForeground}
                returnKeyType="search"
                value={search}
                onChangeText={setSearch}
              />
              {search ? (
                <Pressable
                  accessibilityLabel="Clear search"
                  accessibilityRole="button"
                  className="-mr-1 h-8 w-8 items-center justify-center rounded-full active:opacity-60"
                  hitSlop={8}
                  onPress={() => setSearch('')}
                >
                  <XIcon size={16} className="text-muted-foreground" />
                </Pressable>
              ) : null}
            </View>

            {searching ? null : (
              <>
                <View className="mt-4">
                  <SegmentedControl
                    accessibilityLabel="Which jobs to show"
                    options={VIEWS}
                    value={view}
                    onChange={setView}
                  />
                </View>
                <View className="mt-4">
                  <DayStrip
                    // Remounted per view and anchor, so it opens on the chosen
                    // day rather than wherever the last strip was scrolled.
                    key={`${view}:${view === 'schedule' ? scheduleAnchor : historyEnd}`}
                    counts={counts}
                    days={stripDays}
                    selected={chosenDay}
                    today={today}
                    onSelect={(picked) =>
                      view === 'schedule'
                        ? setDay(picked)
                        : // Tapping the chosen day again goes back to every date.
                          setHistoryDay((current) => (current === picked ? null : picked))
                    }
                  />
                </View>
              </>
            )}

            <View className="mt-4 flex-row items-center justify-between gap-2 px-5 pb-2">
              <Text
                accessibilityRole="header"
                className="min-w-0 flex-1 text-lg font-semibold text-foreground"
                numberOfLines={1}
              >
                {heading}
              </Text>
              {searching ? null : (
                <View className="flex-row items-center gap-1">
                  {view === 'schedule' && day !== today ? (
                    <Pressable
                      accessibilityLabel="Go to today"
                      accessibilityRole="button"
                      className="min-h-11 justify-center px-2 active:opacity-60"
                      onPress={goToday}
                    >
                      <Text className="text-sm font-semibold text-primary">Today</Text>
                    </Pressable>
                  ) : null}
                  {view === 'history' && historyDay ? (
                    <Pressable
                      accessibilityLabel="Show every date"
                      accessibilityRole="button"
                      className="min-h-11 justify-center px-2 active:opacity-60"
                      onPress={() => setHistoryDay(null)}
                    >
                      <Text className="text-sm font-semibold text-primary">All dates</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityLabel="Pick a day from the calendar"
                    accessibilityRole="button"
                    className="h-11 w-11 items-center justify-center rounded-xl active:opacity-60"
                    onPress={() => setCalendarOpen(true)}
                  >
                    <CalendarDaysIcon size={22} className="text-primary" />
                  </Pressable>
                </View>
              )}
            </View>

            {main.isError ? (
              <View className="mx-5 mb-3 rounded-xl border border-destructive/20 bg-destructive/10 p-3">
                <Text className="text-sm text-destructive">
                  {main.error instanceof Error ? main.error.message : 'Could not load jobs.'}
                </Text>
              </View>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) =>
          showSectionHeaders ? (
            <Text
              accessibilityRole="header"
              className={`mb-2 mt-3 px-5 text-sm font-semibold ${
                section.key === 'still-open' ? 'text-chart-4' : 'text-muted-foreground'
              }`}
            >
              {section.title} · {section.data.length}
            </Text>
          ) : null
        }
        renderItem={({ item, section }) => <JobRow item={item} showDay={section.showDay} />}
        ListEmptyComponent={
          loading ? (
            <InspectionListSkeleton rows={3} />
          ) : (
            <EmptyJobs
              searching={searching}
              query={query}
              view={view}
              heading={view === 'schedule' ? dayHeading(day, today) : historyDay ? dayHeading(historyDay, today) : null}
            />
          )
        }
      />
      <MonthCalendarSheet
        visible={calendarOpen}
        selected={chosenDay}
        today={today}
        statuses={stripStatuses}
        latest={view === 'history' ? today : undefined}
        onSelect={pickDay}
        onClose={() => setCalendarOpen(false)}
      />
    </SafeAreaView>
  );
}

function EmptyJobs({
  searching,
  query,
  view,
  heading,
}: {
  searching: boolean;
  query: string;
  view: JobsView;
  heading: string | null;
}) {
  const [title, detail] = searching
    ? [`No jobs match “${query}”`, 'The search looks at every job: street, unit, city, ZIP, job type and status.']
    : view === 'schedule'
      ? [
          heading === 'Today' ? 'Nothing scheduled today' : `No jobs ${heading === 'Tomorrow' || heading === 'Yesterday' ? heading.toLowerCase() : `on ${heading}`}`,
          'Pick another day above, or open the calendar.',
        ]
      : [
          heading ? `Nothing finished ${heading === 'Today' || heading === 'Yesterday' ? heading.toLowerCase() : `on ${heading}`}` : 'No finished jobs yet',
          heading ? 'Pick another day, or show every date.' : 'Jobs you submit appear here.',
        ];
  return (
    <View className="items-center gap-1 px-8 py-16">
      <Text className="text-center text-base font-semibold text-foreground">{title}</Text>
      <Text className="text-center text-sm text-muted-foreground">{detail}</Text>
    </View>
  );
}
