import { router } from 'expo-router';
import { useMemo } from 'react';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  HardDriveIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
} from 'lucide-react-native';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTabBarInset } from '@/src/lib/tab-bar-inset';
import type { UploadItem } from '@/src/domain/models';
import { useUploadActions, useUploads } from '@/src/features/queries';
import { useLiveUploadProgress } from '@/src/features/useLiveUploadProgress';
import { UploadListSkeleton } from '@/src/components/ui/Skeleton';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { useDemoStore } from '@/src/stores/demo.store';
import { evaluateUploadGate } from '@/src/lib/connectivity';
import { useNetworkStore } from '@/src/stores/network.store';
import { usePreferencesStore } from '@/src/stores/preferences.store';
import { progressBarWidth, progressPercent } from '@/src/utils/upload-progress';
import { describeUpload } from '@/src/utils/upload-status';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { ScreenHeader } from '@/src/components/ui';

registerIcons(
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  HardDriveIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  SettingsIcon,
  Trash2Icon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
);

const STATUS_CONFIG: Record<
  string,
  { label: string; bg: string; text: string; icon: typeof UploadCloudIcon }
> = {
  COMPLETED: {
    label: 'Uploaded',
    bg: 'bg-chart-3/15',
    text: 'text-chart-3',
    icon: CheckCircle2Icon,
  },
  PENDING: {
    label: 'Pending',
    bg: 'bg-chart-4/15',
    text: 'text-chart-4',
    icon: ClockIcon,
  },
  PAUSED: {
    label: 'Paused',
    bg: 'bg-muted',
    text: 'text-muted-foreground',
    icon: PauseIcon,
  },
  UPLOADING: {
    label: 'Uploading',
    bg: 'bg-chart-2/15',
    text: 'text-chart-2',
    icon: RefreshCwIcon,
  },
  FAILED: {
    label: 'Failed',
    bg: 'bg-destructive/15',
    text: 'text-destructive',
    icon: AlertTriangleIcon,
  },
};

function UploadRow({
  item,
  actions,
  removable,
}: {
  item: UploadItem;
  actions: ReturnType<typeof useUploadActions>;
  /**
   * Whether this row is still a file on the phone.
   *
   * Only those can be removed: a server-backed upload has already been
   * delivered and is a media row the office owns, so "remove from the device"
   * has nothing to act on. The repository refuses it — offering the control
   * anyway meant a bin icon that always threw.
   */
  removable: boolean;
}) {
  // Wording comes from `describeUpload`, which is the only place that knows a
  // finished transfer is not the same as a playable video. The badge colours
  // and icons stay exactly as they were.
  const online = useNetworkStore((state) => state.isOnline);
  const descriptor = describeUpload(item, { online });
  const config = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.PENDING!;
  const StatusIcon = config.icon;
  const complete = item.status === 'COMPLETED';
  return (
    <View className="mx-5 mb-2 rounded-2xl bg-card p-4">
      <View className="flex-row items-start gap-3">
        <View className="h-14 w-14 items-center justify-center rounded-xl bg-muted">
          <UploadCloudIcon size={20} className="text-muted-foreground" />
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-start justify-between">
            <View className="mr-2 min-w-0 flex-1">
              <Text numberOfLines={1} className="text-sm font-semibold text-foreground">
                {item.roomName}
              </Text>
              <Text numberOfLines={1} className="mt-0.5 text-xs text-muted-foreground">
                {item.propertyAddress}
              </Text>
            </View>
            <View className={`flex-row items-center gap-1 rounded-full px-2.5 py-0.5 ${config.bg}`}>
              <StatusIcon size={11} className={config.text} />
              <Text className={`text-xs font-semibold ${config.text}`}>{descriptor.label}</Text>
            </View>
          </View>

          {!complete ? (
            <View className="mt-2">
              {/* `progress` is a 0–1 fraction. Rendering it directly as a
                  percentage drew every bar at under 1% wide, which is
                  indistinguishable from an upload that never started. */}
              <View
                accessibilityLabel={`${progressPercent(item.progress)} percent uploaded`}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: progressPercent(item.progress) }}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <View
                  className="h-full rounded-full bg-primary"
                  style={{ width: progressBarWidth(item.progress) }}
                />
              </View>
              {/* Bytes rather than only a percentage: on a large walkthrough
                  "11.4 MB of 48.0 MB" tells a technician whether it is worth
                  waiting where a stalled 24% does not. */}
              <Text className="mt-1 text-xs text-muted-foreground">
                {descriptor.detail ?? `${progressPercent(item.progress)}%`}
              </Text>
            </View>
          ) : (
            <Text className="mt-1.5 text-xs text-muted-foreground">
              {descriptor.detail ?? descriptor.label}
            </Text>
          )}
          {/* The failure reason already sits in `descriptor.detail`, so it is
              only repeated here when there is a raw error worth showing. */}
          {item.lastError && item.status !== 'FAILED' ? (
            <View className="mt-2 rounded-lg bg-destructive/10 px-3 py-1.5">
              <Text className="text-xs text-destructive">{item.lastError}</Text>
            </View>
          ) : null}
          {/* Reassurance that matters most exactly when something has gone
              wrong: the recording has not been lost with the upload. */}
          {descriptor.localFileRetained && item.status !== 'PENDING' ? (
            <Text className="mt-1.5 text-[11px] text-muted-foreground">
              Saved on this device until the upload finishes.
            </Text>
          ) : null}
        </View>
      </View>

      {!complete ? (
        <View className="mt-3 flex-row justify-end gap-2">
          {/* Every label names the room. With several uploads queued, "Retry
              Upload" alone does not say which one is about to be acted on. */}
          {item.status === 'FAILED' ? (
            <Pressable
              accessibilityLabel={`Retry upload for ${item.roomName}`}
              accessibilityRole="button"
              className="min-h-11 flex-row items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.retry.mutate(item.id)}
            >
              <RefreshCwIcon size={14} className="text-primary" />
              <Text className="text-xs font-semibold text-primary">Retry Upload</Text>
            </Pressable>
          ) : item.status === 'PAUSED' ? (
            <Pressable
              accessibilityLabel={`Resume upload for ${item.roomName}`}
              accessibilityRole="button"
              className="min-h-11 flex-row items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.resume.mutate(item.id)}
            >
              <PlayIcon size={14} className="text-primary" />
              <Text className="text-xs font-semibold text-primary">Resume</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={`Pause upload for ${item.roomName}`}
              accessibilityRole="button"
              className="min-h-11 flex-row items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.pause.mutate(item.id)}
            >
              <PauseIcon size={14} className="text-muted-foreground" />
              <Text className="text-xs font-semibold text-muted-foreground">Pause</Text>
            </Pressable>
          )}
          {removable ? (
            <Pressable
              // Destructive and icon-only: the hint spells out the consequence,
              // because "Remove" next to a trash can is ambiguous about whether
              // the recording itself is being discarded.
              accessibilityHint="Removes this item from the upload queue"
              accessibilityLabel={`Remove ${item.roomName} from the upload queue`}
              accessibilityRole="button"
              className="min-h-11 min-w-11 items-center justify-center rounded-lg bg-destructive/10 p-2 active:scale-[0.98]"
              onPress={() => actions.remove.mutate(item.id)}
            >
              <Trash2Icon size={14} className="text-destructive" />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export default function UploadsScreen() {
  const tabBarInset = useTabBarInset();
  const uploads = useUploads();
  const pull = usePullToRefresh([uploads.refetch]);
  const actions = useUploadActions();
  /**
   * The ids still held on this device, read from the same store the repository
   * checks. Membership here is the only honest test of whether "remove" can do
   * anything — a server-backed row shares the shape but not the file.
   */
  const localUploadIds = useDemoStore(
    (state) => state.uploads,
  );
  const removableIds = useMemo(
    () => new Set((localUploadIds ?? []).map((upload) => upload.id)),
    [localUploadIds],
  );
  const theme = useThemeColors();
  const isOnline = useNetworkStore((state) => state.isOnline);
  const isMetered = useNetworkStore((state) => state.isMetered);
  const autoUpload = usePreferencesStore((state) => state.autoUpload);
  const wifiOnlyUploads = usePreferencesStore((state) => state.wifiOnlyUploads);
  const gate = evaluateUploadGate({
    autoUpload,
    wifiOnlyUploads,
    connectivity: { isOnline, isMetered, type: '' },
  });
  // Live transfer progress, overlaid on the cached list: without this the bar
  // never moves during an upload. See useLiveUploadProgress.
  const items = useLiveUploadProgress(uploads.data);
  const sorted = [...items].sort((left, right) => {
    if (left.status === 'COMPLETED' && right.status !== 'COMPLETED') return 1;
    if (right.status === 'COMPLETED' && left.status !== 'COMPLETED') return -1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const pendingCount = sorted.filter((item) => item.status !== 'COMPLETED').length;
  const uploadedCount = sorted.filter((item) => item.status === 'COMPLETED').length;
  const localSize = sorted
    .filter((item) => item.status !== 'COMPLETED')
    .reduce((total, item) => total + item.estimatedSizeMb, 0);

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: tabBarInset + 24 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={theme.primary}
          />
        }
        ListHeaderComponent={
          <View>
            <ScreenHeader
              subtitle="Manage and monitor all evidence uploads"
              title="Upload Center"
            />

            {uploads.isError ? (
              <View className="mx-5 mt-4 rounded-xl border border-destructive/20 bg-destructive/10 p-3">
                <Text className="text-sm text-destructive">
                  {uploads.error instanceof Error
                    ? uploads.error.message
                    : 'Could not load uploads.'}
                </Text>
              </View>
            ) : null}

            <View className="mt-4 flex-row gap-3 px-5">
              <View className="flex-1 rounded-2xl bg-card p-4">
                <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-chart-3/15">
                  <CheckCircle2Icon size={18} className="text-chart-3" />
                </View>
                <Text className="text-3xl font-bold text-foreground">{uploadedCount}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">Uploaded</Text>
              </View>
              <View className="flex-1 rounded-2xl bg-card p-4">
                <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-chart-4/15">
                  <ClockIcon size={18} className="text-chart-4" />
                </View>
                <Text className="text-3xl font-bold text-foreground">{pendingCount}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">Pending</Text>
              </View>
              <View className="flex-1 rounded-2xl bg-card p-4">
                <View className="mb-2 h-9 w-9 items-center justify-center rounded-xl bg-primary/15">
                  <HardDriveIcon size={18} className="text-primary" />
                </View>
                <Text className="text-lg font-bold text-foreground">{localSize.toFixed(1)}</Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">MB local</Text>
              </View>
            </View>

            {/* Reports the same gate the queue runner obeys. A stalled queue
                must never look identical to a working one — technicians are
                told to confirm "pending: 0" before they leave a property. */}
            <View
              accessibilityRole={gate.allowed ? undefined : 'alert'}
              className={`mx-5 mt-4 flex-row items-center gap-3 rounded-2xl p-4 ${
                gate.allowed ? 'bg-card' : 'border border-chart-4/25 bg-chart-4/10'
              }`}
            >
              <View
                className={`h-10 w-10 items-center justify-center rounded-full ${
                  gate.allowed ? 'bg-chart-3/15' : 'bg-chart-4/15'
                }`}
              >
                {gate.allowed ? (
                  <WifiIcon size={18} className="text-chart-3" />
                ) : (
                  <WifiOffIcon size={18} className="text-chart-4" />
                )}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  {gate.allowed
                    ? isMetered
                      ? 'Connected · mobile data'
                      : 'Connected'
                    : pendingCount > 0
                      ? `${pendingCount} upload${pendingCount === 1 ? '' : 's'} paused`
                      : 'Uploads paused'}
                </Text>
                <Text className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {gate.allowed
                    ? 'Evidence uploads automatically while the app is open.'
                    : gate.reason}
                </Text>
              </View>
              {gate.allowed ? null : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open upload settings"
                  className="h-9 w-9 items-center justify-center rounded-full bg-chart-4/15 active:scale-95"
                  onPress={() => router.push('/(app)/(tabs)/settings')}
                >
                  <SettingsIcon size={16} className="text-chart-4" />
                </Pressable>
              )}
            </View>

            <View className="mb-3 mt-5 flex-row items-center justify-between px-5">
              <Text className="text-lg font-semibold text-foreground">Upload Queue</Text>
              {sorted.some((item) => item.status === 'FAILED') ? (
                <Pressable
                  accessibilityLabel="Retry all failed uploads"
                  accessibilityRole="button"
                  className="min-h-11 flex-row items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 active:scale-[0.98]"
                  onPress={() =>
                    sorted
                      .filter((item) => item.status === 'FAILED')
                      .forEach((item) => actions.retry.mutate(item.id))
                  }
                >
                  <RefreshCwIcon size={14} className="text-primary" />
                  <Text className="text-xs font-semibold text-primary">Retry All</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <UploadRow actions={actions} item={item} removable={removableIds.has(item.id)} />
        )}
        ListEmptyComponent={
          uploads.isLoading ? (
            <UploadListSkeleton rows={3} />
          ) : (
          <View className="items-center gap-3 py-16">
            <CheckCircle2Icon size={36} className="text-muted-foreground" />
            <View className="items-center gap-1">
              <Text className="text-base font-semibold text-foreground">All Clear</Text>
              <Text className="px-8 text-center text-sm text-muted-foreground">
                No pending uploads. New room recordings appear here when they are saved.
              </Text>
            </View>
          </View>
          )
        }
      />
    </SafeAreaView>
  );
}
