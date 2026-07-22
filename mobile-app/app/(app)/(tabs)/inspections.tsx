import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { ConnectedInspectionCard } from '../../../src/components/ConnectedInspectionCard';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import { Card, FilterChip, SearchInput, SectionHeader } from '../../../src/components/ui';
import { useInspections } from '../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../src/theme';

const filters = [
  'ALL',
  'SCHEDULED',
  'IN_PROGRESS',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'COMPLETED',
] as const;

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
  const styles = useThemedStyles(createStyles);
  const [filter, setFilter] = useState<(typeof filters)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const query = useInspections({
    status: filter === 'ALL' ? undefined : filter,
    search: debouncedSearch || undefined,
  });
  const filtered = query.data ?? [];
  if (query.isLoading) return <LoadingState label="Loading assigned inspections…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  return (
    <AppScreen
      title="Inspections"
      subtitle="Assigned, active, and recently completed work"
      eyebrow="MY WORK QUEUE"
      refresh={{ onRefresh: () => query.refetch() }}
    >
      <Card muted>
        <View style={styles.filterHeader}>
          <View style={styles.filterIcon}>
            <Ionicons name="options-outline" size={18} style={styles.filterIconGlyph} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.filterTitle}>Find an inspection</Text>
            <Text style={styles.filterHint}>Search or narrow your assigned work by status.</Text>
          </View>
        </View>
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
          {filters.map((item) => (
            <FilterChip
              key={item}
              label={item.replaceAll('_', ' ')}
              selected={filter === item}
              onPress={() => setFilter(item)}
            />
          ))}
        </ScrollView>
      </Card>
      <SectionHeader
        title={`${filtered.length} ${filtered.length === 1 ? 'inspection' : 'inspections'}`}
        icon="list-outline"
      />
      {filtered.length ? (
        <View style={styles.list}>
          {filtered.map((inspection) => (
            <SearchableInspection key={inspection.id} inspection={inspection} />
          ))}
        </View>
      ) : (
        <EmptyState
          title={query.data?.length ? 'No matching inspections' : 'No inspections assigned'}
          message={
            query.data?.length
              ? 'Try a different status filter or property address.'
              : 'Only inspections assigned to your technician account will appear here.'
          }
        />
      )}
    </AppScreen>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    filterHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    filterIcon: {
      width: 40,
      height: 40,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.primarySoft,
    },
    filterIconGlyph: { color: colors.primary },
    filterTitle: { ...typography.label, color: colors.textPrimary },
    filterHint: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
    filters: { gap: spacing.sm, paddingRight: spacing.md },
    list: { gap: spacing.md },
  });
