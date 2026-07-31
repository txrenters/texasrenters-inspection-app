import { useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  Clock3Icon,
  DatabaseIcon,
  HardDriveIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
} from 'lucide-react-native';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { environment } from '@/src/config/environment';
import { useUploads } from '@/src/features/queries';
import { evaluateUploadGate } from '@/src/lib/connectivity';
import { clearErrorLog, subscribeToErrorLog, type LoggedError } from '@/src/lib/error-log';
import { useNetworkStore } from '@/src/stores/network.store';
import { usePreferencesStore } from '@/src/stores/preferences.store';
import { MotionDiagnostics } from '@/src/capture/MotionDiagnostics';
import { registerIcons } from '@/src/lib/icons';

registerIcons(
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircle2Icon,
  ClipboardCopyIcon,
  Clock3Icon,
  DatabaseIcon,
  HardDriveIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  WifiIcon,
  WifiOffIcon,
);

type DiagnosticStatus = 'ok' | 'warning' | 'error';

function hostLabel() {
  if (!environment.apiBaseUrl) return 'Not configured';
  try {
    return new URL(environment.apiBaseUrl).host;
  } catch {
    return 'Invalid endpoint';
  }
}

function DiagnosticRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: DiagnosticStatus;
}) {
  const Icon =
    status === 'ok' ? CheckCircle2Icon : status === 'warning' ? Clock3Icon : AlertTriangleIcon;
  const iconClassName =
    status === 'ok' ? 'text-chart-3' : status === 'warning' ? 'text-chart-4' : 'text-destructive';

  return (
    <View className="flex-row items-center justify-between border-b border-border py-3 last:border-b-0">
      <View className="mr-3 min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <Text numberOfLines={2} className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {value}
        </Text>
      </View>
      <Icon size={17} className={iconClassName} />
    </View>
  );
}

export default function DiagnosticsScreen() {
  const uploads = useUploads();
  const isOnline = useNetworkStore((state) => state.isOnline);
  const isMetered = useNetworkStore((state) => state.isMetered);
  const connectionType = useNetworkStore((state) => state.type);
  const autoUpload = usePreferencesStore((state) => state.autoUpload);
  const wifiOnlyUploads = usePreferencesStore((state) => state.wifiOnlyUploads);
  const uploadGate = evaluateUploadGate({
    autoUpload,
    wifiOnlyUploads,
    connectivity: { isOnline, isMetered, type: connectionType },
  });
  const [errors, setErrors] = useState<LoggedError[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => subscribeToErrorLog(setErrors), []);

  const items = uploads.data ?? [];
  const pending = items.filter((item) => ['PENDING', 'PAUSED'].includes(item.status)).length;
  const uploading = items.filter((item) => item.status === 'UPLOADING').length;
  const failed = items.filter((item) => item.status === 'FAILED').length;
  const completed = items.filter((item) => item.status === 'COMPLETED').length;
  const retainedMb = items
    .filter((item) => item.status !== 'COMPLETED')
    .reduce((total, item) => total + item.estimatedSizeMb, 0);
  const apiStatus: DiagnosticStatus = environment.remoteBetaApiUrlError
    ? 'error'
    : uploads.isError
      ? 'error'
      : uploads.isFetching
        ? 'warning'
        : 'ok';
  const queueStatus: DiagnosticStatus =
    failed > 0 ? 'error' : uploading > 0 || pending > 0 ? 'warning' : 'ok';

  /**
   * The report a tester pastes into a message. Deliberately plain text: it has
   * to survive being sent over SMS, email or a chat app. No identifiers beyond
   * the app build and the device's own queue state, and error text was already
   * redacted on the way into the log.
   */
  const handleCopy = async () => {
    const report = [
      `TexasRenters Inspect ${Constants.expoConfig?.version ?? '0.1.0'} (${environment.appEnv})`,
      `Captured: ${new Date().toISOString()}`,
      `Platform: ${Platform.OS} ${Platform.Version}`,
      `Network: ${isOnline ? 'online' : 'offline'} · ${connectionType}${isMetered ? ' · metered' : ''}`,
      `Upload queue: ${uploadGate.allowed ? 'running' : uploadGate.reason}`,
      `Queue counts: ${pending} pending, ${uploading} uploading, ${failed} failed, ${completed} completed`,
      `Retained locally: ${retainedMb.toFixed(1)} MB`,
      `API: ${environment.remoteBetaApiUrlError ?? hostLabel()}`,
      '',
      errors.length ? 'Recent problems:' : 'Recent problems: none recorded.',
      ...errors.slice(0, 5).map((entry) => `- ${entry.at} [${entry.source}] ${entry.message}`),
    ].join('\n');
    await Clipboard.setStringAsync(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to settings"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-95"
            onPress={() => router.back()}
          >
            <ArrowLeftIcon size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-foreground">Diagnostics</Text>
            <Text className="text-xs text-muted-foreground">Live device and upload health</Text>
          </View>
        </View>

        <View className="mx-5 mt-2 rounded-2xl bg-card p-5">
          <View className="mb-3 flex-row items-center gap-2">
            {isOnline ? (
              <WifiIcon size={18} className="text-chart-3" />
            ) : (
              <WifiOffIcon size={18} className="text-chart-4" />
            )}
            <Text className="text-base font-semibold text-foreground">System Status</Text>
          </View>
          <DiagnosticRow
            label="Network connectivity"
            value={
              isOnline
                ? `Connected · ${connectionType}${isMetered ? ' · metered' : ''}`
                : 'Offline · captured evidence remains on this device'
            }
            status={isOnline ? 'ok' : 'warning'}
          />
          {/* The single most useful line when a tester reports "nothing is
              uploading" — it distinguishes a network fault from a switched-off
              preference without a round trip. */}
          <DiagnosticRow
            label="Upload queue"
            value={uploadGate.allowed ? 'Running' : uploadGate.reason}
            status={uploadGate.allowed ? 'ok' : 'warning'}
          />
          <DiagnosticRow
            label="TexasRenters REST API"
            value={
              environment.remoteBetaApiUrlError ??
              `${hostLabel()}${uploads.isFetching ? ' · checking' : ''}`
            }
            status={apiStatus}
          />
          <DiagnosticRow
            label="Local-first evidence"
            value="Room videos and snapshots are retained until the server confirms them."
            status="ok"
          />
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="mb-4 flex-row items-center gap-2">
            <UploadCloudIcon size={18} className="text-primary" />
            <Text className="text-base font-semibold text-foreground">Upload Queue</Text>
          </View>
          <View className="mb-3 flex-row gap-3">
            {[
              ['Completed', completed],
              ['Pending', pending + uploading],
              ['Failed', failed],
            ].map(([label, value]) => (
              <View key={String(label)} className="flex-1 items-center rounded-xl bg-muted p-3">
                <Text
                  className={`text-2xl font-bold ${
                    label === 'Failed' && Number(value) > 0 ? 'text-destructive' : 'text-foreground'
                  }`}
                >
                  {value}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">{label}</Text>
              </View>
            ))}
          </View>
          <DiagnosticRow
            label="Background queue"
            value={
              uploading > 0
                ? `${uploading} upload${uploading === 1 ? '' : 's'} in progress`
                : pending > 0
                  ? `${pending} item${pending === 1 ? '' : 's'} safely queued`
                  : 'Idle'
            }
            status={queueStatus}
          />
          <DiagnosticRow
            label="Local evidence storage"
            value={`${retainedMb.toFixed(1)} MB retained for unfinished uploads`}
            status={retainedMb > 250 ? 'warning' : 'ok'}
          />
        </View>

        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="mb-3 flex-row items-center gap-2">
            <HardDriveIcon size={18} className="text-chart-2" />
            <Text className="text-base font-semibold text-foreground">Application</Text>
          </View>
          <DiagnosticRow
            label="App version"
            value={`${Constants.expoConfig?.name ?? 'TexasRenters Inspect'} ${
              Constants.expoConfig?.version ?? '0.1.0'
            }`}
            status="ok"
          />
          <DiagnosticRow
            label="Data boundary"
            value="Authenticated REST API · no direct database access"
            status="ok"
          />
          <DiagnosticRow
            label="Evidence safeguards"
            value="AI output remains pending review and cannot determine tenant responsibility."
            status="ok"
          />
        </View>

        <MotionDiagnostics />

        <View className="mx-5 mt-4 flex-row gap-3">
          <Pressable
            accessibilityLabel={uploads.isFetching ? 'Checking status' : 'Refresh status'}
            accessibilityRole="button"
            accessibilityState={{ busy: uploads.isFetching, disabled: uploads.isFetching }}
            className="flex-1 items-center gap-2 rounded-2xl bg-card p-4 active:scale-[0.98]"
            disabled={uploads.isFetching}
            onPress={() => void uploads.refetch()}
          >
            <RefreshCwIcon size={22} className="text-primary" />
            <Text className="text-xs font-semibold text-foreground">
              {uploads.isFetching ? 'Checking…' : 'Refresh'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Open the Upload Center"
            accessibilityRole="button"
            className="flex-1 items-center gap-2 rounded-2xl bg-card p-4 active:scale-[0.98]"
            onPress={() => router.push('/uploads')}
          >
            <DatabaseIcon size={22} className="text-chart-2" />
            <Text className="text-xs font-semibold text-foreground">Upload Center</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy diagnostics to the clipboard"
            className="flex-1 items-center gap-2 rounded-2xl bg-card p-4 active:scale-[0.98]"
            onPress={handleCopy}
          >
            <ClipboardCopyIcon size={22} className="text-chart-3" />
            <Text className="text-xs font-semibold text-foreground">
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Pressable>
        </View>

        {/* Recent errors, so a tester can report what actually happened rather
            than "it crashed". Credential-shaped text is redacted before it is
            ever written, because this content is meant to be pasted into a
            message. */}
        <View className="mx-5 mt-4 rounded-2xl bg-card p-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-base font-semibold text-foreground">Recent problems</Text>
            {errors.length ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear the problem log"
                className="rounded-full bg-muted px-3 py-1 active:opacity-70"
                onPress={() => void clearErrorLog()}
              >
                <Text className="text-xs font-semibold text-muted-foreground">Clear</Text>
              </Pressable>
            ) : null}
          </View>
          {errors.length ? (
            errors.slice(0, 5).map((entry) => (
              <View key={entry.id} className="mt-3 border-t border-border pt-3">
                <Text className="text-xs font-semibold text-muted-foreground">
                  {new Date(entry.at).toLocaleString()} · {entry.source}
                  {entry.fatal ? ' · crash' : ''}
                </Text>
                <Text className="mt-1 text-sm leading-6 text-foreground">{entry.message}</Text>
              </View>
            ))
          ) : (
            <Text className="mt-2 text-sm leading-6 text-muted-foreground">
              No problems recorded on this device.
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
