import { ChevronRightIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import type { PhoneCount } from '@texasrenters/shared';

import { Button, Card } from '@/src/components/ui';
import { useTruckCountActions, useTruckCountLocal, useTruckCountRefusals, useTruckCounts } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { countCardLine } from '@/src/utils/truck-count';

registerIcons(ChevronRightIcon);

function CountRow({ count, onOpen }: { count: PhoneCount; onOpen: (countId: string) => void }) {
  const local = useTruckCountLocal(count.id);
  return (
    <Pressable accessibilityHint="Opens the count" accessibilityRole="button" className="flex-row items-center gap-3 p-4 active:opacity-60" onPress={() => onOpen(count.id)}>
      <View className="flex-1 gap-1">
        <Text className="text-base font-semibold text-foreground">Count {count.place.name}</Text>
        <Text className="text-sm text-muted-foreground">
          {count.title} · {count.number}
        </Text>
        <Text className="text-sm text-foreground">{countCardLine(count, local.data ?? null)}</Text>
      </View>
      <ChevronRightIcon className="text-muted-foreground" size={20} />
    </Pressable>
  );
}

/**
 * The truck counts waiting for this technician, on the home screen
 * (2026-11-19). Shown only when the office has opened one for a truck they
 * may count, or one they counted was refused: an office that does not use the
 * inventory never sees it. One small read when home opens; nothing on a timer.
 */
export function TruckCountCard({ onOpen, className = '' }: { onOpen: (countId: string) => void; className?: string }) {
  const counts = useTruckCounts();
  const refusals = useTruckCountRefusals();
  const actions = useTruckCountActions();
  const open = counts.data?.counts ?? [];
  const refused = refusals.data ?? [];
  if (!open.length && !refused.length) return null;

  return (
    <View className={`gap-3 ${className}`}>
      {refused.map((refusal) => (
        <View className="gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 p-4" key={refusal.countId}>
          <Text accessibilityRole="alert" className="text-sm font-semibold text-destructive">
            Your count was not taken: {refusal.title}
          </Text>
          <Text className="text-sm leading-relaxed text-foreground">{refusal.reason}</Text>
          <Button label="OK, I have read this" onPress={() => actions.dismiss.mutate(refusal.countId, { onSettled: () => void refusals.refetch() })} variant="secondary" />
        </View>
      ))}
      {open.map((count) => (
        <Card className="p-0" density="row" key={count.id}>
          <CountRow count={count} onOpen={onOpen} />
        </Card>
      ))}
    </View>
  );
}
