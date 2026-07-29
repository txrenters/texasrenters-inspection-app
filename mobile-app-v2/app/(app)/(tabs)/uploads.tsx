import { cssInterop, useColorScheme } from 'nativewind';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  HardDriveIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
} from 'lucide-react-native';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { UploadItem } from '@/src/domain/models';
import { useUploadActions, useUploads } from '@/src/features/queries';
import { useNetworkStore } from '@/src/stores/network.store';

for (const icon of [
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  HardDriveIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
]) {
  cssInterop(icon, { className: { target: 'style', nativeStyleToProp: { color: true } } });
}

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
}: {
  item: UploadItem;
  actions: ReturnType<typeof useUploadActions>;
}) {
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
              <Text className={`text-xs font-semibold ${config.text}`}>{config.label}</Text>
            </View>
          </View>

          {!complete ? (
            <View className="mt-2">
              <View className="h-1.5 overflow-hidden rounded-full bg-muted">
                <View
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${item.progress}%` }}
                />
              </View>
              <Text className="mt-1 text-xs text-muted-foreground">
                {item.progress}% · {item.processingStatus.replaceAll('_', ' ').toLowerCase()}
              </Text>
            </View>
          ) : (
            <Text className="mt-1.5 text-xs text-muted-foreground">
              {item.processingStatus.replaceAll('_', ' ').toLowerCase()}
            </Text>
          )}
          {item.lastError ? (
            <View className="mt-2 rounded-lg bg-destructive/10 px-3 py-1.5">
              <Text className="text-xs text-destructive">{item.lastError}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {!complete ? (
        <View className="mt-3 flex-row justify-end gap-2">
          {item.status === 'FAILED' ? (
            <Pressable
              className="flex-row items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.retry.mutate(item.id)}
            >
              <RefreshCwIcon size={14} className="text-primary" />
              <Text className="text-xs font-semibold text-primary">Retry Upload</Text>
            </Pressable>
          ) : item.status === 'PAUSED' ? (
            <Pressable
              className="flex-row items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.resume.mutate(item.id)}
            >
              <PlayIcon size={14} className="text-primary" />
              <Text className="text-xs font-semibold text-primary">Resume</Text>
            </Pressable>
          ) : (
            <Pressable
              className="flex-row items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 active:scale-[0.98]"
              onPress={() => actions.pause.mutate(item.id)}
            >
              <PauseIcon size={14} className="text-muted-foreground" />
              <Text className="text-xs font-semibold text-muted-foreground">Pause</Text>
            </Pressable>
          )}
          <Pressable
            className="rounded-lg bg-destructive/10 p-2 active:scale-[0.98]"
            onPress={() => actions.remove.mutate(item.id)}
          >
            <Trash2Icon size={14} className="text-destructive" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function UploadsScreen() {
  const uploads = useUploads();
  const actions = useUploadActions();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const isOnline = useNetworkStore((state) => state.isOnline);
  const sorted = [...(uploads.data ?? [])].sort((left, right) => {
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
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={uploads.isRefetching}
            onRefresh={() => void uploads.refetch()}
            tintColor={isDark ? '#2dd4bf' : '#145347'}
          />
        }
        ListHeaderComponent={
          <View>
            <View className="px-5 pb-2 pt-4">
              <Text className="text-2xl font-bold tracking-tight text-foreground">
                Upload Center
              </Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                Manage and monitor all evidence uploads
              </Text>
            </View>

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

            <View className="mx-5 mt-4 flex-row items-center gap-3 rounded-2xl bg-card p-4">
              <View
                className={`h-10 w-10 items-center justify-center rounded-full ${
                  isOnline ? 'bg-chart-3/15' : 'bg-chart-4/15'
                }`}
              >
                {isOnline ? (
                  <WifiIcon size={18} className="text-chart-3" />
                ) : (
                  <WifiOffIcon size={18} className="text-chart-4" />
                )}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-sm font-semibold text-foreground">
                  {isOnline ? 'Connected' : 'Offline — evidence is safe'}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">
                  {isOnline
                    ? 'Background uploads are active. Evidence syncs automatically.'
                    : 'Queued evidence resumes automatically when connectivity returns.'}
                </Text>
              </View>
            </View>

            <View className="mb-3 mt-5 flex-row items-center justify-between px-5">
              <Text className="text-lg font-semibold text-foreground">Upload Queue</Text>
              {sorted.some((item) => item.status === 'FAILED') ? (
                <Pressable
                  className="flex-row items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 active:scale-[0.97]"
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
        renderItem={({ item }) => <UploadRow item={item} actions={actions} />}
        ListEmptyComponent={
          <View className="items-center gap-3 py-16">
            <CheckCircle2Icon size={36} className="text-muted-foreground" />
            <View className="items-center gap-1">
              <Text className="text-base font-semibold text-foreground">All Clear</Text>
              <Text className="px-8 text-center text-sm text-muted-foreground">
                No pending uploads. New room recordings appear here when they are saved.
              </Text>
            </View>
          </View>
        }
      />
    </SafeAreaView>
  );
}
