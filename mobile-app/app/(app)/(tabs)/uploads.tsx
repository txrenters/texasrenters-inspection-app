import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppListScreen } from '../../../src/components/ScreenPrimitives';
import { UploadProgressCard } from '../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import { ConfirmationModal, SectionHeader } from '../../../src/components/ui';
import {
  CompletedUploadsSection,
  OfflineNotice,
} from '../../../src/components/CompletedUploadsSection';
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
  const uploadPriority = { FAILED: 0, UPLOADING: 1, PENDING: 2, PAUSED: 3 } as const;
  const active =
    uploads.data
      ?.filter((item) => item.status !== 'COMPLETED')
      .sort(
        (left, right) =>
          (uploadPriority[left.status as keyof typeof uploadPriority] ?? 9) -
          (uploadPriority[right.status as keyof typeof uploadPriority] ?? 9),
      ) ?? [];
  const processing = uploads.data?.filter((item) => item.status === 'COMPLETED') ?? [];
  const openRoom = (inspectionId: string, areaId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId },
    });
  return (
    <>
      <AppListScreen
        title="Upload center"
        subtitle="Background uploads, retries, and AI processing"
        eyebrow="MEDIA PIPELINE"
        refresh={{ refreshing: isRefreshing, onRefresh: () => void refreshUploads() }}
        data={active}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <UploadProgressCard
            item={item}
            onRetry={() => actions.retry.mutate(item.id)}
            onPause={() => actions.pause.mutate(item.id)}
            onResume={() => actions.resume.mutate(item.id)}
            onRemove={() => setRemoveId(item.id)}
            onViewRoom={() => openRoom(item.inspectionId, item.roomId)}
          />
        )}
        header={
          <View style={styles.header}>
            <Text style={styles.body}>
              Saved evidence resumes automatically when connectivity returns.
            </Text>
            {!isOnline ? <OfflineNotice /> : null}
            <SectionHeader title={`Active uploads (${active.length})`} icon="arrow-up-circle-outline" />
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            compact
            title="Nothing uploading"
            message="New room recordings appear here as soon as they are saved."
          />
        }
        ListFooterComponent={
          <CompletedUploadsSection
            items={processing}
            onViewRoom={(item) =>
              router.push({
                pathname: '/(app)/inspections/[inspectionId]/area/[areaId]/processing',
                params: { inspectionId: item.inspectionId, areaId: item.roomId },
              })
            }
          />
        }
      />
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
    </>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    header: { gap: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    flex: { flex: 1 },
    cardTitle: { ...typography.heading, color: colors.textPrimary },
    body: { ...typography.caption, color: colors.textSecondary },
  });
