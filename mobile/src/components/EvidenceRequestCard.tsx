import { CheckIcon, InboxIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { EvidenceRequest } from '../domain/models';
import { registerIcons } from '../lib/icons';

registerIcons(CheckIcon, InboxIcon);

/**
 * What the office has asked for in this area.
 *
 * Before this, a reviewer could send an inspection back but not say why: the
 * technician saw a finished job reappear in their queue and had to phone
 * someone to find out what was missing. The request is shown at the top of the
 * area, because it is the reason they are standing there again.
 *
 * Marking it done is the technician's own call rather than something inferred
 * from a new upload arriving — only they know whether what they just captured
 * is what was actually asked for.
 */
export function EvidenceRequestCard({
  requests,
  resolving = false,
  onResolve,
}: {
  requests: readonly EvidenceRequest[];
  resolving?: boolean;
  onResolve: (requestId: string) => void;
}) {
  if (!requests.length) return null;
  return (
    <View className="mx-5 mt-4 rounded-2xl border border-chart-4/30 bg-chart-4/10 p-5">
      <View className="flex-row items-center gap-2">
        <InboxIcon size={17} className="text-chart-4" />
        <Text className="text-base font-semibold text-chart-4">
          The office asked for more evidence
        </Text>
      </View>

      {requests.map((request) => (
        <View className="mt-3 rounded-xl bg-card p-4" key={request.id}>
          {/* An empty item list means the whole area. Saying which, in words,
              stops a technician re-walking a room when one detail was wanted —
              or photographing one wall when a re-walk was. */}
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {request.items.length ? request.items.join(' · ') : 'Whole area'}
          </Text>
          <Text className="mt-1.5 text-sm leading-6 text-foreground">{request.note}</Text>
          <Pressable
            accessibilityLabel="Mark this request done"
            accessibilityRole="button"
            accessibilityState={{ busy: resolving, disabled: resolving }}
            className="mt-3 min-h-12 flex-row items-center justify-center gap-2 rounded-xl bg-muted py-3 active:opacity-70"
            disabled={resolving}
            onPress={() => onResolve(request.id)}
          >
            <CheckIcon size={16} className="text-primary" />
            <Text className="font-semibold text-primary">
              {resolving ? 'Saving…' : "I've captured this"}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
