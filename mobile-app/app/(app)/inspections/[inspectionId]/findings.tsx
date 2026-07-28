import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { FindingSummaryCard } from '../../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { FilterChip, SectionHeader } from '../../../../src/components/ui';
import type { FindingStatus } from '../../../../src/domain/models';
import { matchesFindingFilter, useFindings, useRooms } from '../../../../src/features/queries';
import { spacing } from '../../../../src/theme';

const filters: Array<{ label: string; value: FindingStatus | 'ALL' }> = [
  { label: 'Pending review', value: 'PENDING_REVIEW' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'Reinspection', value: 'REINSPECTION_REQUESTED' },
  { label: 'All', value: 'ALL' },
];

export default function FindingsScreen() {
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const [filter, setFilter] = useState<FindingStatus | 'ALL'>('PENDING_REVIEW');
  const rooms = useRooms(inspectionId);
  const processing = Boolean(
    rooms.data?.some(
      (room) =>
        room.processingStatus !== 'NOT_STARTED' &&
        room.processingStatus !== 'READY_FOR_REVIEW' &&
        room.processingStatus !== 'FAILED',
    ),
  );
  const query = useFindings(inspectionId, processing);
  const grouped = useMemo(() => {
    const visible =
      query.data?.filter((finding) => matchesFindingFilter(finding.reviewStatus, filter)) ?? [];
    return visible.reduce<Record<string, typeof visible>>((groups, finding) => {
      groups[finding.roomName] = [...(groups[finding.roomName] ?? []), finding];
      return groups;
    }, {});
  }, [filter, query.data]);
  if (query.isLoading) return <LoadingState label="Loading AI-assisted findings…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const entries = Object.entries(grouped);
  return (
    <AppScreen
      title="Findings review"
      subtitle="AI observations are suggestions until an authorized human decides"
      refresh={{ onRefresh: () => query.refetch() }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {filters.map((item) => (
          <FilterChip
            key={item.value}
            label={item.label}
            selected={filter === item.value}
            onPress={() => setFilter(item.value)}
          />
        ))}
      </ScrollView>
      {entries.length ? (
        entries.map(([roomName, findings]) => (
          <View key={roomName} style={styles.group}>
            <SectionHeader title={roomName} />
            {findings.map((finding) => (
              <FindingSummaryCard
                key={finding.id}
                finding={finding}
                onPress={() =>
                  router.push({
                    pathname: '/(app)/inspections/[inspectionId]/finding/[findingId]',
                    params: { inspectionId, findingId: finding.id },
                  })
                }
              />
            ))}
          </View>
        ))
      ) : (
        <EmptyState
          title={processing ? 'AI summary is processing' : 'No findings in this view'}
          message={
            processing
              ? 'The room video is safely uploaded. Its transcript and condition summary will appear here automatically.'
              : 'Choose another filter or record and upload a room video first.'
          }
        />
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  filters: { gap: spacing.sm, paddingRight: spacing.md },
  group: { gap: spacing.md },
});
