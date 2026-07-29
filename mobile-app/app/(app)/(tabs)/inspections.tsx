import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppListScreen } from '../../../src/components/ScreenPrimitives';
import { ConnectedInspectionCard } from '../../../src/components/ConnectedInspectionCard';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import { FilterChip, SearchInput, SectionHeader } from '../../../src/components/ui';
import { CompletedInspectionRow } from '../../../src/components/CompletedInspectionRow';
import { useInspections } from '../../../src/features/queries';
import { spacing } from '../../../src/theme';

// Technicians open this tab to find work, so the default view is work. Finished
// inspections used to sit mixed into the same list under an 'ALL' default, which
// meant scrolling past history to reach today's jobs.
const SCOPES = ['ACTIVE', 'DONE'] as const;
type Scope = (typeof SCOPES)[number];

const SCOPE_LABEL: Record<Scope, string> = { ACTIVE: 'Active', DONE: 'Done' };

// Anything not yet finished is active work, including inspections waiting on
// processing or admin review — the technician still needs them visible.
const ACTIVE_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'PROCESSING', 'REVIEW_REQUIRED'];

function SearchableInspection({
  inspection,
}: {
  inspection: NonNullable<ReturnType<typeof useInspections>['data']>[number];
}) {
  return (
    <ConnectedInspectionCard
      inspection={inspection}
      onPress={() =>
        router.push({
          pathname: '/(app)/inspections/[inspectionId]',
          params: { inspectionId: inspection.id },
        })
      }
    />
  );
}

export default function InspectionsScreen() {
  const [scope, setScope] = useState<Scope>('ACTIVE');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  // The hook takes a single status but "active" spans four, so the split is done
  // here on one unfiltered fetch rather than four round trips.
  const query = useInspections({ search: debouncedSearch || undefined });
  const all = query.data ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  // Apply the search to the already-visible result immediately while the
  // debounced REST request refreshes the authoritative result in the
  // background. This keeps typing responsive without issuing a request for
  // every keystroke or flashing an empty loading screen.
  const visible = normalizedSearch
    ? all.filter((item) =>
        [
          item.property.address,
          item.property.cityStateZip,
          item.unitName,
          item.type.replaceAll('_', ' '),
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(normalizedSearch)),
      )
    : all;
  const active = visible.filter((item) => ACTIVE_STATUSES.includes(item.status));
  const done = visible.filter((item) => !ACTIVE_STATUSES.includes(item.status));
  const filtered = scope === 'ACTIVE' ? active : done;
  if (query.isLoading) return <LoadingState label="Loading assigned inspections…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  return (
    <AppListScreen
      title="Inspections"
      subtitle="Assigned, active, and recently completed work"
      eyebrow="MY WORK QUEUE"
      refresh={{ refreshing: query.isRefetching, onRefresh: () => query.refetch() }}
      data={filtered}
      keyExtractor={(inspection) => inspection.id}
      renderItem={({ item: inspection }) =>
        scope === 'DONE' ? (
          <CompletedInspectionRow
            inspection={inspection}
            onOpen={() =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]',
                params: { inspectionId: inspection.id },
              })
            }
            onViewSummary={() =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]/report',
                params: { inspectionId: inspection.id },
              })
            }
          />
        ) : (
          <SearchableInspection inspection={inspection} />
        )
      }
      header={
        <View style={styles.header}>
          <SearchInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by property address"
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filters}
          >
            {SCOPES.map((item) => (
              <FilterChip
                key={item}
                label={`${SCOPE_LABEL[item]} (${item === 'ACTIVE' ? active.length : done.length})`}
                selected={scope === item}
                onPress={() => setScope(item)}
              />
            ))}
          </ScrollView>
          <SectionHeader
            title={`${filtered.length} ${filtered.length === 1 ? 'inspection' : 'inspections'}`}
            icon={scope === 'ACTIVE' ? 'list-outline' : 'checkmark-done-outline'}
          />
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title={
            !visible.length
              ? normalizedSearch
                ? 'No matching inspections'
                : 'No inspections assigned'
              : scope === 'ACTIVE'
                ? 'No active inspections'
                : 'Nothing finished yet'
          }
          message={
            !visible.length
              ? normalizedSearch
                ? 'No assigned inspection matches that property, unit, or type.'
                : 'Only inspections assigned to your technician account will appear here.'
              : scope === 'ACTIVE'
                ? done.length
                  ? 'All caught up. Finished work is under Done.'
                  : 'Try a different property address.'
                : 'Completed inspections will appear here once you submit them.'
          }
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  filters: { gap: spacing.sm, paddingRight: spacing.md },
  header: { gap: spacing.md },
});
