import { router } from 'expo-router';
import { InboxIcon } from 'lucide-react-native';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useOpenEvidenceRequests } from '@/src/features/queries';
import { usePullToRefresh } from '@/src/features/usePullToRefresh';
import { registerIcons } from '@/src/lib/icons';

registerIcons(InboxIcon);

/**
 * Everything the office is waiting on, across every assignment.
 *
 * Its own tab rather than a banner inside an inspection: a request exists
 * because someone needs the technician to go somewhere they were not otherwise
 * going, so it has to be visible without opening the inspection it belongs to.
 * Kept current by the realtime gateway, not by opening this screen.
 */
export default function RequestsScreen() {
  const requests = useOpenEvidenceRequests();
  const pull = usePullToRefresh([requests.refetch]);
  const items = requests.data ?? [];

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="px-5 pb-3 pt-2">
        <Text className="text-lg font-bold text-foreground">Requests</Text>
        <Text className="text-xs text-muted-foreground">
          {items.length
            ? `${items.length} area${items.length === 1 ? '' : 's'} the office is waiting on`
            : 'Nothing outstanding'}
        </Text>
      </View>

      {requests.isLoading && !requests.data ? (
        <DetailSkeleton sections={2} />
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl onRefresh={pull.onRefresh} refreshing={pull.refreshing} />
          }
          showsVerticalScrollIndicator={false}
        >
          {items.length ? (
            items.map((request) => (
              <Pressable
                accessibilityHint="Opens the area this request is about"
                accessibilityLabel={`${request.roomName} at ${request.propertyName}. ${request.note}`}
                accessibilityRole="button"
                className="mx-5 mb-2 gap-1 rounded-2xl bg-card p-4 active:opacity-70"
                key={request.id}
                onPress={() =>
                  router.push({
                    pathname: '/(app)/areas/[id]',
                    params: { id: request.roomId, inspectionId: request.inspectionId },
                  })
                }
              >
                <Text className="text-sm font-semibold text-foreground">{request.roomName}</Text>
                <Text className="text-xs text-muted-foreground">
                  {request.propertyName}
                  {request.unitName ? ` · ${request.unitName}` : ''}
                </Text>
                {/* The note is the whole point — it is what the office could not
                    see in the recording. Never truncated. */}
                <Text className="mt-1 text-sm leading-5 text-foreground">{request.note}</Text>
              </Pressable>
            ))
          ) : (
            <View className="mx-5 mt-6 items-center gap-2 rounded-2xl bg-card p-8">
              <InboxIcon size={26} className="text-muted-foreground" />
              <Text className="text-sm font-semibold text-foreground">Nothing outstanding</Text>
              <Text className="text-center text-xs leading-5 text-muted-foreground">
                When the office needs more evidence in an area, it appears here and on this tab.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
