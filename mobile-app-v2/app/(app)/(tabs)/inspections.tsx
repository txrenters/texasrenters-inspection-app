import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import { useColorScheme } from 'nativewind';
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  SearchIcon,
  Settings2Icon,
} from 'lucide-react-native';
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Inspection, InspectionStatus } from '@/src/domain/models';
import {
  InspectionUrgencyBadge,
  useInspectionUrgency,
} from '@/src/components/InspectionUrgencyBadge';
import { useInspections } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  CheckCircle2Icon,
  ChevronRightIcon,
  ClipboardListIcon,
  MapPinIcon,
  SearchIcon,
  Settings2Icon,
);

const FILTERS: { key: 'ALL' | InspectionStatus; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'SCHEDULED', label: 'Assigned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'COMPLETED', label: 'Completed' },
];

const STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; icon: typeof ClipboardListIcon }
> = {
  SCHEDULED: {
    label: 'Assigned',
    bg: 'bg-chart-4/15',
    text: 'text-chart-4',
    icon: ClipboardListIcon,
  },
  IN_PROGRESS: {
    label: 'In Progress',
    bg: 'bg-chart-2/15',
    text: 'text-chart-2',
    icon: Settings2Icon,
  },
  COMPLETED: {
    label: 'Completed',
    bg: 'bg-chart-3/15',
    text: 'text-chart-3',
    icon: CheckCircle2Icon,
  },
};

function InspectionRow({ item }: { item: Inspection }) {
  const urgency = useInspectionUrgency(item);
  const config = STATUS_CONFIG[item.status] ?? {
    label: item.status.replaceAll('_', ' '),
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    icon: ClipboardListIcon,
  };
  const StatusIcon = config.icon;
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
        config.label.toLowerCase(),
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
              <Text className={`text-xs font-semibold capitalize ${config.text}`}>
                {config.label.toLowerCase()}
              </Text>
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
  const inspections = useInspections();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [filter, setFilter] = useState<'ALL' | InspectionStatus>('ALL');
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (inspections.data ?? []).filter((item) => {
      if (filter !== 'ALL' && item.status !== filter) return false;
      if (!query) return true;
      return [
        item.property.address,
        item.property.cityStateZip,
        item.unitName ?? '',
        item.type,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [filter, inspections.data, search]);

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={inspections.isRefetching}
            onRefresh={() => void inspections.refetch()}
            tintColor={isDark ? '#2dd4bf' : '#145347'}
          />
        }
        ListHeaderComponent={
          <View>
            <View className="px-5 pb-2 pt-4">
              <Text className="text-2xl font-bold tracking-tight text-foreground">Inspections</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                {(inspections.data ?? []).length} total ·{' '}
                {(inspections.data ?? []).filter((item) => item.status === 'SCHEDULED').length}{' '}
                pending
              </Text>
            </View>
            <View className="mx-5 mt-3 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
              <SearchIcon size={18} className="text-muted-foreground" />
              <TextInput
                className="flex-1 text-base text-foreground"
                placeholder="Search address, city, or unit..."
                placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
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
                      className={`min-h-11 justify-center rounded-full px-4 py-2 active:scale-[0.97] ${
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
          <View className="items-center gap-3 py-16">
            <SearchIcon size={36} className="text-muted-foreground" />
            <View className="items-center gap-1">
              <Text className="text-base font-semibold text-foreground">No inspections found</Text>
              <Text className="px-8 text-center text-sm text-muted-foreground">
                {search ? 'Try a different search term.' : 'No inspections match this filter.'}
              </Text>
            </View>
          </View>
        }
      />
    </SafeAreaView>
  );
}
