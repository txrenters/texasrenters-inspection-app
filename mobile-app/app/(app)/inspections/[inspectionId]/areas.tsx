import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { inspectionProgress } from '../../../../src/components/FeatureCards';
import { AreaCard } from '../../../../src/components/AreaCard';
import { AppListScreen } from '../../../../src/components/ScreenPrimitives';
import { EmptyState, ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { AppButton, Card, ProgressBar } from '../../../../src/components/ui';
import { useFindings, useRooms } from '../../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../../src/theme';
import { groupRoomsBySection } from '../../../../src/utils/area-taxonomy';
import { pickUpNextArea } from '../../../../src/utils/area-status';

export default function InspectionAreasScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const query = useRooms(inspectionId);
  // One request for the whole inspection, then grouped locally. Querying photos
  // or findings per area would be an N+1 across the list.
  const findings = useFindings(inspectionId);

  if (query.isLoading) return <LoadingState label="Loading inspection areas…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const rooms = query.data ?? [];
  const sections = groupRoomsBySection(rooms);
  const progress = inspectionProgress(rooms);
  // Derived, and deliberately the only place the up-next area is decided — so
  // the card ring, the badge and the sticky footer can never disagree.
  const nextRoom = pickUpNextArea(rooms);
  const sequence = new Map(rooms.map((room, index) => [room.id, index + 1]));
  const findingCounts = (findings.data ?? []).reduce<Record<string, number>>((totals, finding) => {
    totals[finding.roomId] = (totals[finding.roomId] ?? 0) + 1;
    return totals;
  }, {});
  const items = sections.flatMap((section) =>
    section.rooms.map((room, index) => ({
      id: room.id,
      room,
      section,
      startsSection: index === 0,
    })),
  );
  const openRoom = (areaId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId },
    });

  return (
    <AppListScreen
      title="Inspection areas"
      subtitle="Complete one area at a time. Uploads continue in the background."
      refresh={{ refreshing: query.isRefetching, onRefresh: () => query.refetch() }}
      data={items}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => (
        <View style={styles.listItem}>
          {item.startsSection ? (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{item.section.label}</Text>
                <Text style={styles.sectionCount}>
                  {item.section.rooms.length} area{item.section.rooms.length === 1 ? '' : 's'}
                </Text>
              </View>
              {item.section.key === 'MANUAL' ? (
                <Text style={styles.sectionNote}>
                  Added on site · awaiting administrator approval
                </Text>
              ) : null}
            </View>
          ) : null}
          <AreaCard
            room={item.room}
            sequence={sequence.get(item.room.id) ?? 0}
            findingCount={findingCounts[item.room.id] ?? 0}
            isUpNext={item.room.id === nextRoom?.id}
            onOpen={() => openRoom(item.room.id)}
            onAction={() => openRoom(item.room.id)}
          />
        </View>
      )}
      header={
        <View style={styles.header}>
          <Card muted>
            <Text style={styles.progressTitle}>
              {progress.completed} of {progress.total} required areas completed
            </Text>
            <ProgressBar value={progress.value} />
            <Text style={styles.progressHelp}>
              Record the area, save it to the upload queue, then continue without waiting.
            </Text>
          </Card>
          <AppButton
            label="Add missing area"
            icon="add"
            variant="outline"
            onPress={() =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]/areas/new',
                params: { inspectionId },
              })
            }
          />
        </View>
      }
      bottomAction={
        nextRoom ? (
          <AppButton label={`Continue with ${nextRoom.name}`} onPress={() => openRoom(nextRoom.id)} />
        ) : undefined
      }
      ListEmptyComponent={
        <EmptyState
          title="No inspection areas"
          message="An administrator must approve extracted areas, or you can add a missing area."
        />
      }
    />
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    header: { gap: spacing.md },
    listItem: { gap: spacing.sm },
    section: { gap: spacing.xs, marginTop: spacing.sm },
    sectionHeader: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    sectionTitle: { ...typography.heading, color: colors.textPrimary, flexShrink: 1 },
    sectionCount: { ...typography.caption, color: colors.textSecondary },
    sectionNote: { ...typography.caption, color: colors.warning, paddingHorizontal: spacing.xs },
    progressTitle: { ...typography.heading, color: colors.textPrimary },
    progressHelp: { ...typography.caption, color: colors.textSecondary },
  });
