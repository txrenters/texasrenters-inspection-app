import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { inspectionProgress, RoomCard } from '../../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { AppButton, Card, ProgressBar } from '../../../../src/components/ui';
import { useRooms } from '../../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../../src/theme';

export default function InspectionAreasScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const query = useRooms(inspectionId);
  if (query.isLoading) return <LoadingState label="Loading approved rooms…" />;
  if (query.isError)
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const roomList = query.data ?? [];
  const progress = inspectionProgress(roomList);
  const nextRoom = roomList.find(
    (room) => room.isRequired && !['COMPLETED', 'SKIPPED'].includes(room.completionStatus),
  );
  const openRoom = (roomId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId: roomId },
    });
  return (
    <AppScreen
      title="Room checklist"
      subtitle="One approved room, one focused video"
      refresh={{ refreshing: query.isFetching, onRefresh: () => void query.refetch() }}
      bottomAction={
        nextRoom ? (
          <AppButton
            label={`Continue with ${nextRoom.name}`}
            onPress={() => openRoom(nextRoom.id)}
          />
        ) : undefined
      }
    >
      <Card muted>
        <Text style={styles.progressTitle}>
          {progress.completed} of {progress.total} required rooms completed
        </Text>
        <ProgressBar value={progress.value} />
        <Text style={styles.progressHelp}>
          Recordings stay linked to the selected room. Stop before moving to another area.
        </Text>
      </Card>
      {roomList.length ? (
        <View style={styles.list}>
          {roomList.map((room) => (
            <RoomCard key={room.id} room={room} onPress={() => openRoom(room.id)} />
          ))}
        </View>
      ) : (
        <EmptyState
          title="No approved rooms"
          message="An administrator must approve extracted room tags before field work begins."
        />
      )}
    </AppScreen>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    list: { gap: spacing.md },
    progressTitle: { ...typography.heading, color: colors.textPrimary },
    progressHelp: { ...typography.caption, color: colors.textSecondary },
  });
