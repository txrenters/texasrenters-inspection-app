import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { UploadProgressCard } from '../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import { Card, ConfirmationModal, SectionHeader, StatusBadge } from '../../../src/components/ui';
import { useUploadActions, useUploads } from '../../../src/features/queries';
import { useDemoStore } from '../../../src/stores/demo.store';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../src/theme';

export default function UploadQueueScreen() {
  const styles = useThemedStyles(createStyles);
  const uploads = useUploads();
  const actions = useUploadActions();
  const isOnline = useDemoStore((state) => state.isOnline);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refetchUploads = uploads.refetch;

  const refreshUploads = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refetchUploads();
    } finally {
      setIsRefreshing(false);
    }
  }, [refetchUploads]);

  if (uploads.isLoading) return <LoadingState label="Opening local upload queue…" />;
  if (uploads.isError)
    return <ErrorState message={uploads.error.message} onRetry={() => void uploads.refetch()} />;
  const active = uploads.data?.filter((item) => item.status !== 'COMPLETED') ?? [];
  const processing = uploads.data?.filter((item) => item.status === 'COMPLETED') ?? [];
  const openRoom = (inspectionId: string, areaId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId },
    });
  return (
    <AppScreen
      title="Upload center"
      subtitle="Saved videos upload automatically while you keep inspecting"
      eyebrow="MEDIA PIPELINE"
      refresh={{ refreshing: isRefreshing, onRefresh: () => void refreshUploads() }}
    >
      <Card muted>
        <Text style={styles.body}>
          Room videos you save are queued here and upload on their own — you can keep inspecting.
          After upload, each video is transcribed and analyzed by AI, and the results go to the
          TexasRenters team for review.
        </Text>
      </Card>
      {!isOnline ? (
        <Card muted>
          <View style={styles.row}>
            <StatusBadge label="PAUSED" />
            <View style={styles.flex}>
              <Text style={styles.cardTitle}>Uploads are waiting</Text>
              <Text style={styles.body}>
                This device is offline. Videos remain safely queued and resume when the connection
                returns.
              </Text>
            </View>
          </View>
        </Card>
      ) : null}
      <SectionHeader title={`Active uploads (${active.length})`} icon="arrow-up-circle-outline" />
      {active.length ? (
        <View style={styles.list}>
          {active.map((item) => (
            <UploadProgressCard
              key={item.id}
              item={item}
              onRetry={() => actions.retry.mutate(item.id)}
              onPause={() => actions.pause.mutate(item.id)}
              onResume={() => actions.resume.mutate(item.id)}
              onRemove={() => setRemoveId(item.id)}
              onViewRoom={() => openRoom(item.inspectionId, item.roomId)}
            />
          ))}
        </View>
      ) : (
        <EmptyState
          title="No pending uploads"
          message="New room recordings will appear here after they are saved."
        />
      )}
      <SectionHeader
        title={`Processing and completed (${processing.length})`}
        icon="checkmark-done-outline"
      />
      <View style={styles.list}>
        {processing.map((item) => (
          <UploadProgressCard
            key={item.id}
            item={item}
            onRetry={() => actions.retry.mutate(item.id)}
            onPause={() => actions.pause.mutate(item.id)}
            onResume={() => actions.resume.mutate(item.id)}
            onRemove={() => setRemoveId(item.id)}
            onViewRoom={() =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/processing',
                params: { inspectionId: item.inspectionId, areaId: item.roomId },
              })
            }
          />
        ))}
      </View>
      <ConfirmationModal
        visible={Boolean(removeId)}
        title="Remove this queue item?"
        message="The queue entry is removed, but the recorded video stays on this device until you re-save it."
        confirmLabel="Remove"
        destructive
        onCancel={() => setRemoveId(null)}
        onConfirm={() => {
          if (removeId) actions.remove.mutate(removeId);
          setRemoveId(null);
        }}
      />
    </AppScreen>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    list: { gap: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    flex: { flex: 1 },
    cardTitle: { ...typography.heading, color: colors.textPrimary },
    body: { ...typography.caption, color: colors.textSecondary },
  });
