import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../src/components/AppScreen';
import { UploadProgressCard } from '../../../src/components/FeatureCards';
import { EmptyState, ErrorState, LoadingState } from '../../../src/components/ScreenStates';
import {
  Card,
  ConfirmationModal,
  SectionHeader,
  StatCard,
  StatusBadge,
} from '../../../src/components/ui';
import { useUploadActions, useUploads } from '../../../src/features/queries';
import { repositories } from '../../../src/repositories';
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

  useEffect(() => {
    let stopped = false;
    let tickInProgress = false;

    const updateQueue = async () => {
      if (tickInProgress) return;
      tickInProgress = true;
      try {
        await repositories.uploads.tick();
        if (!stopped) await refetchUploads();
      } finally {
        tickInProgress = false;
      }
    };

    const timer = setInterval(() => {
      void updateQueue();
    }, 850);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [refetchUploads]);
  if (uploads.isLoading) return <LoadingState label="Opening local upload queue…" />;
  if (uploads.isError)
    return <ErrorState message={uploads.error.message} onRetry={() => void uploads.refetch()} />;
  const active = uploads.data?.filter((item) => item.status !== 'COMPLETED') ?? [];
  const processing = uploads.data?.filter((item) => item.status === 'COMPLETED') ?? [];
  const failed = active.filter((item) => item.status === 'FAILED').length;
  const openRoom = (inspectionId: string, areaId: string) =>
    router.push({
      pathname: '/(app)/inspections/[inspectionId]/area/[areaId]',
      params: { inspectionId, areaId },
    });
  return (
    <AppScreen
      title="Upload center"
      subtitle="Local media, transfer progress, and AI processing"
      eyebrow="MEDIA PIPELINE"
      refresh={{ refreshing: isRefreshing, onRefresh: () => void refreshUploads() }}
    >
      <View style={styles.stats}>
        <StatCard
          value={active.length}
          label="In queue"
          tone="warning"
          icon="cloud-upload-outline"
        />
        <StatCard
          value={processing.length}
          label="Processing"
          tone="info"
          icon="sparkles-outline"
        />
        <StatCard
          value={failed}
          label="Needs attention"
          tone={failed ? 'warning' : 'success'}
          icon={failed ? 'alert-circle-outline' : 'shield-checkmark-outline'}
        />
      </View>
      {!isOnline ? (
        <Card muted>
          <View style={styles.row}>
            <StatusBadge label="PAUSED" />
            <View style={styles.flex}>
              <Text style={styles.cardTitle}>Uploads are waiting</Text>
              <Text style={styles.body}>
                Offline simulation is active. Videos remain safely queued on this device.
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
        message="The demo queue record will be removed. Local source media is retained for recovery."
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
    stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    list: { gap: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    flex: { flex: 1 },
    cardTitle: { ...typography.heading, color: colors.textPrimary },
    body: { ...typography.caption, color: colors.textSecondary },
  });
