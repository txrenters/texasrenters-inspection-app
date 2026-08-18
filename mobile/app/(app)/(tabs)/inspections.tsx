import { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  SearchIcon,
  Settings2Icon,
  UploadCloudIcon,
  XCircleIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Inspection } from '@/src/domain/models';
import {
  InspectionUrgencyBadge,
  useInspectionUrgency,
} from '@/src/components/InspectionUrgencyBadge';
import { useInspectionPages } from '@/src/features/queries';
import {
  INSPECTION_STATUS_TONE_CLASS,
  inspectionStatusPresentation,
  statusesForFilter,
  type InspectionFilterKey,
  type InspectionStatusTone,
} from '@/src/utils/inspection-status';
import { InspectionListSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { ScreenHeader } from '@/src/components/ui';

registerIcons(
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  SearchIcon,
  Settings2Icon,
  UploadCloudIcon,
  XCircleIcon,
);

/**
 * "Submitted" covers every post-handover state the technician cannot act on,
 * so a walkthrough that has gone to the office is findable instead of only
 * appearing under All.
 *
 * Each chip resolves to a set of statuses the *server* filters on
 * (`statusesForFilter`). Filtering on-device instead meant every chip shared
 * one 25-record window: because that window is the oldest work and Submitted
 * covers seven statuses, a technician's history crowded out the Assigned and
 * In Progress chips they actually work from.
 */
const FILTERS: { key: InspectionFilterKey; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SCHEDULED', label: 'Assigned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'COMPLETED', label: 'Completed' },
];

/**
 * Typing pause before the search reaches the server.
 *
 * Search is server-side for the same reason the chips are: matching on-device
 * only ever searched the pages already loaded, so an address further down the
 * list looked like it did not exist.
 */
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

// Labels and colours come from src/utils/inspection-status; only the icon
// choice is local, because this is the one screen that shows one.
const TONE_ICON: Record<InspectionStatusTone, typeof ClipboardListIcon> = {
  assigned: ClipboardListIcon,
  active: Settings2Icon,
  submitted: UploadCloudIcon,
  review: ClipboardListIcon,
  attention: AlertTriangleIcon,
  done: CheckCircle2Icon,
  closed: XCircleIcon,
};

function InspectionRow({ item }: { item: Inspection }) {
  const urgency = useInspectionUrgency(item);
  const presentation = inspectionStatusPresentation(item.status);
  const config = {
    ...INSPECTION_STATUS_TONE_CLASS[presentation.tone],
    label: presentation.label,
  };
  const StatusIcon = TONE_ICON[presentation.tone];
  return (
    <Pressable
      // Read as one item. Left ungrouped, VoiceOver stops six times per card —
      // address, unit, type, progress, status, date — and a technician swiping
      // through a day's assignments has to hold it all in their head.
      accessibilityLabel={[
        item.property.address,
        item.unitName ?? 'Entire property',
        item.property.cityStateZip,
        item.type.replaceAll('_', ' ').toLowerCase(),
        `${item.progress.completed} of ${item.progress.total} rooms complete`,
        config.label,
        // Carried in the row's own label: the badge below sits inside a hidden
        // subtree, so this is the only way it reaches a screen reader.
        urgency?.spoken ?? '',
        new Date(item.scheduledAt).toLocaleString(),
        item.progress.hasFailedUpload ? 'Has a failed upload' : '',
      ]
        .filter(Boolean)
        .join(', ')}
      accessibilityRole="button"
      accessibilityHint="Opens this inspection"
      className="mx-5 mb-3 rounded-2xl bg-card p-4 active:scale-[0.98]"
      onPress={() => router.push(`/inspections/${item.id}`)}
    >
      <View importantForAccessibility="no-hide-descendants" className="flex-row items-start gap-3">
        <View className="mt-0.5 h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <MapPinIcon size={18} className="text-primary" />
        </View>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-semibold text-foreground">
            {item.property.address}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-sm text-muted-foreground">
            {item.unitName ?? 'Entire property'} · {item.property.cityStateZip}
          </Text>
          <Text numberOfLines={2} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            {item.type.replaceAll('_', ' ').toLowerCase()} · {item.progress.completed} of{' '}
            {item.progress.total} rooms complete
          </Text>
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${config.bg}`}>
              <StatusIcon size={12} className={config.text} />
              {/* The label arrives cased. Lowercasing then `capitalize` used to
                  round-trip it through the stylesheet, which breaks on a
                  hyphen — "Follow-up Needed" came back "Follow-Up Needed", and
                  differently from the detail screen. */}
              <Text className={`text-xs font-semibold ${config.text}`}>{config.label}</Text>
            </View>
            <InspectionUrgencyBadge inspection={item} />
            <Text className="text-xs text-muted-foreground">
              {new Date(item.scheduledAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </Text>
          </View>
        </View>
        <ChevronRightIcon size={18} className="mt-3 text-muted-foreground" />
      </View>
    </Pressable>
  );
}

export default function InspectionsScreen() {
  const theme = useThemeColors();
  const [filter, setFilter] = useState<InspectionFilterKey>('ALL');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  const inspections = useInspectionPages({
    statuses: statusesForFilter(filter),
    search: debouncedSearch || undefined,
  });
  const pull = usePullToRefresh([inspections.refetch]);

  // Flattened for the list; `total` comes from the server, so it counts every
  // matching record rather than the ones currently held on the device.
  const rows = useMemo(
    () => inspections.data?.pages.flatMap((page) => page.items) ?? [],
    [inspections.data],
  );
  const total = inspections.data?.pages[0]?.total ?? 0;

  // A settling search is still the previous result set. Saying so beats
  // flashing "No inspections found" at someone mid-keystroke.
  const searchPending = search.trim() !== debouncedSearch;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        // Half a screen of runway, so the next page is usually in hand before
        // the technician reaches the bottom.
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          // Guarded: FlatList fires this repeatedly while near the end, and an
          // unguarded call would queue duplicate requests for the same page.
          if (inspections.hasNextPage && !inspections.isFetchingNextPage)
            void inspections.fetchNextPage();
        }}
        ListFooterComponent={
          inspections.isFetchingNextPage ? (
            <View className="py-6">
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.primary}
          />
        }
        ListHeaderComponent={
          <View>
            {/* The server's count for the active chip and search, so it is
                the real number. It reported the length of whatever page was
                in hand before, which saturated at 25 forever — a technician
                with three hundred inspections read "25 total".

                "loaded" only appears while there is more to come, because once
                every page is in, loaded and total are the same number and
                printing both invites the reader to look for a difference. */}
            <ScreenHeader
              subtitle={`${total} total${rows.length < total ? ` · ${rows.length} loaded` : ''}`}
              title="Inspections"
            />
            <View className="mx-5 mt-3 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
              <SearchIcon size={18} className="text-muted-foreground" />
              <TextInput
                className="flex-1 text-base text-foreground"
                placeholder="Search address, city, or unit..."
                placeholderTextColor={theme.mutedForeground}
                value={search}
                onChangeText={setSearch}
              />
            </View>
            <View className="mb-2 mt-4">
              <FlatList
                horizontal
                data={FILTERS}
                keyExtractor={(item) => item.key}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}
                renderItem={({ item }) => {
                  const active = filter === item.key;
                  return (
                    <Pressable
                      accessibilityLabel={`Filter: ${item.label}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: active }}
                      className={`min-h-11 justify-center rounded-full px-4 py-2 active:scale-[0.98] ${
                        active ? 'bg-primary' : 'border border-border bg-card'
                      }`}
                      onPress={() => setFilter(item.key)}
                    >
                      <Text
                        className={`text-sm font-semibold ${
                          active ? 'text-primary-foreground' : 'text-muted-foreground'
                        }`}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  );
                }}
              />
            </View>
            {inspections.isError ? (
              <View className="mx-5 mb-3 rounded-xl border border-destructive/20 bg-destructive/10 p-3">
                <Text className="text-sm text-destructive">
                  {inspections.error instanceof Error
                    ? inspections.error.message
                    : 'Could not load inspections.'}
                </Text>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <InspectionRow item={item} />}
        ListEmptyComponent={
          // A first load with nothing cached used to render "No inspections
          // found" for as long as the request took, telling the technician the
          // opposite of the truth before the list arrived. A search still
          // settling is the same situation, now that matching happens server-side.
          inspections.isLoading || searchPending ? (
            <InspectionListSkeleton rows={4} />
          ) : (
          <View className="items-center gap-3 py-16">
            <SearchIcon size={36} className="text-muted-foreground" />
            <View className="items-center gap-1">
              <Text className="text-base font-semibold text-foreground">No inspections found</Text>
              <Text className="px-8 text-center text-sm text-muted-foreground">
                {search ? 'Try a different search term.' : 'No inspections match this filter.'}
              </Text>
            </View>
          </View>
          )
        }
      />
    </SafeAreaView>
  );
}
