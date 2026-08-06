import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ArrowLeftIcon, RotateCwIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { environment } from '@/src/config/environment';
import { registerIcons } from '@/src/lib/icons';
import { resolveMobilePlayback } from '@/src/media/playback-source';
import { repositories } from '@/src/repositories';

registerIcons(ArrowLeftIcon, RotateCwIcon);

/**
 * Plays one uploaded recording.
 *
 * Distinct from `recording-review`, which plays the local draft straight off
 * disk before it is uploaded. This one plays what the server holds, which is
 * the only copy once the local file has been cleaned up — a technician
 * revisiting an area yesterday has nothing on the device to show.
 *
 * The signed URL is fetched here rather than with the area's media list: a
 * token is minted per request and lives about two hours, so requesting one for
 * every recording on an area screen would mint several nobody opens.
 */
export default function PlaybackScreen() {
  const { mediaId = '', title } = useLocalSearchParams<{ mediaId: string; title?: string }>();

  const playback = useQuery({
    queryKey: ['media-playback', mediaId],
    queryFn: () => repositories.media.playback(mediaId),
    enabled: Boolean(mediaId),
    // Under the token's own lifetime, so it is re-requested before it lapses
    // rather than handing the player a dead URL part-way through.
    staleTime: 60 * 60_000,
    gcTime: 0,
    retry: 1,
  });

  const state = resolveMobilePlayback(playback.data, {
    apiBaseUrl: environment.apiBaseUrls[0] ?? environment.apiBaseUrl,
  });

  // Created unconditionally because hooks cannot be called behind a branch. A
  // null source is a valid idle player, so nothing loads until there is a URL.
  const player = useVideoPlayer(state.kind === 'play' ? state.source : null, (instance) => {
    instance.loop = false;
  });

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-[0.95]"
          hitSlop={8}
          onPress={() => router.back()}
        >
          <ArrowLeftIcon size={18} className="text-foreground" />
        </Pressable>
        <Text className="min-w-0 flex-1 text-lg font-bold text-foreground" numberOfLines={1}>
          {title || 'Recording'}
        </Text>
      </View>

      {playback.isLoading ? (
        <Centred>
          <ActivityIndicator />
          <Text className="mt-3 text-sm text-muted-foreground">Loading recording…</Text>
        </Centred>
      ) : state.kind === 'processing' ? (
        <Centred>
          <ActivityIndicator />
          {/* Not a failure: the recording arrived safely and is simply not
              encoded yet, which is the common case right after a walkthrough. */}
          <Text className="mt-3 text-center text-sm text-muted-foreground">{state.message}</Text>
          <Retry label="Check again" onPress={() => void playback.refetch()} />
        </Centred>
      ) : state.kind === 'failed' ? (
        <Centred>
          <Text className="text-center text-sm text-foreground">{state.message}</Text>
          {/* No retry for a settled encoding failure — pressing it again would
              only produce the same answer. */}
          {state.retryable ? <Retry label="Try again" onPress={() => void playback.refetch()} /> : null}
        </Centred>
      ) : (
        <View className="flex-1 px-5">
          <VideoView
            allowsFullscreen
            contentFit="contain"
            nativeControls
            player={player}
            style={{ flex: 1, borderRadius: 18, backgroundColor: '#000' }}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

function Centred({ children }: { children: React.ReactNode }) {
  return <View className="flex-1 items-center justify-center px-8">{children}</View>;
}

function Retry({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className="mt-4 flex-row items-center gap-2 rounded-xl bg-card px-4 py-2.5 active:scale-[0.98]"
      onPress={onPress}
    >
      <RotateCwIcon size={16} className="text-foreground" />
      <Text className="text-sm font-semibold text-foreground">{label}</Text>
    </Pressable>
  );
}
