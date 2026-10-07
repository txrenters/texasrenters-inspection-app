import { useEffect, useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { SearchIcon } from 'lucide-react-native';
import { ActivityIndicator, Platform, SectionList, Text, TextInput, View } from 'react-native';

import { JobRow } from '@/src/components/JobRow';
import { InspectionListSkeleton } from '@/src/components/ui/Skeleton';
import { useInspectionPages } from '@/src/features/queries';
import { useLocalNow } from '@/src/features/useLocalNow';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { texasToday } from '@/src/utils/job-day';
import { searchSections } from '@/src/utils/job-sections';

registerIcons(SearchIcon);

/**
 * One search over every job the technician was ever assigned -- any day, any
 * state (the office, 2026-10-07: a search bar that is "universal").
 *
 * Its own tab, where iOS puts search: the system's search tab, and in iOS 26
 * a button of its own beside the bar. The field is the navigation bar's own
 * (`headerSearchBarOptions`), not one drawn in the page. The server matches
 * every word somewhere -- street, building, unit, city, ZIP, Jobber title -- or
 * as a kind of job ("move out", "hvac") or where it stands ("assigned").
 */

/** Typing pause before the search reaches the server. */
const SEARCH_DEBOUNCE_MS = 300;
/** A search is short and wanted whole. */
const RESULTS_PAGE = 50;

function useDebounced<T>(value: T, delayMs: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export default function SearchScreen() {
  const theme = useThemeColors();
  const today = texasToday(useLocalNow());
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  // A settling search is still the previous answer; "nothing found" mid-keystroke
  // would be the wrong answer.
  const pending = search.trim() !== query;

  // Kept while typing, so results do not blank between keys.
  const results = useInspectionPages(
    { search: query, order: 'recent', pageSize: RESULTS_PAGE },
    { keepPrevious: true, enabled: query.length > 0 },
  );
  const sections = useMemo(
    () =>
      query ? searchSections(results.data?.pages.flatMap((page) => page.items) ?? [], today) : [],
    [query, results.data, today],
  );
  const total = results.data?.pages[0]?.total ?? 0;

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: 'Address, city, ZIP, type or status',
            autoCapitalize: 'none',
            autoFocus: true,
            hideWhenScrolling: false,
            onChangeText: (event) => setSearch(event.nativeEvent.text),
            onCancelButtonPress: () => setSearch(''),
          },
        }}
      />
      <SectionList
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        sections={sections}
        keyExtractor={(item, index) => `${item.id}:${index}`}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
        }}
        ListHeaderComponent={
          <View>
            {/* The web build has no native bar to hold the field. */}
            {Platform.OS === 'web' ? (
              <View className="mx-5 mt-3 flex-row items-center gap-3 rounded-xl bg-card px-4 py-2.5">
                <SearchIcon size={18} className="text-muted-foreground" />
                <TextInput
                  accessibilityLabel="Search every job"
                  className="flex-1 text-base text-foreground"
                  placeholder="Address, city, ZIP, type or status"
                  placeholderTextColor={theme.mutedForeground}
                  value={search}
                  onChangeText={setSearch}
                />
              </View>
            ) : null}
            {query && results.data ? (
              <Text accessibilityRole="header" className="mt-3 px-5 text-lg font-semibold text-foreground">
                {total} found
              </Text>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text accessibilityRole="header" className="mb-2 mt-3 px-5 text-sm font-semibold text-muted-foreground">
            {section.title} · {section.data.length}
          </Text>
        )}
        renderItem={({ item, section }) => <JobRow item={item} showDay={section.showDay} />}
        ListFooterComponent={
          results.isFetchingNextPage ? (
            <View className="py-6">
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !query && !pending ? (
            <View className="items-center gap-1 px-8 py-16">
              <Text className="text-center text-base font-semibold text-foreground">
                Search every job you were ever assigned
              </Text>
              <Text className="text-center text-sm text-muted-foreground">
                By street, unit, city or ZIP, by kind (move out, HVAC), or by where it stands
                (assigned, submitted).
              </Text>
            </View>
          ) : results.isLoading || pending ? (
            <InspectionListSkeleton rows={3} />
          ) : (
            <View className="items-center gap-1 px-8 py-16">
              <Text className="text-center text-base font-semibold text-foreground">
                No jobs match “{query}”
              </Text>
              <Text className="text-center text-sm text-muted-foreground">
                Check the spelling, or try fewer words.
              </Text>
            </View>
          )
        }
      />
    </>
  );
}
