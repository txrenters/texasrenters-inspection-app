import { ChevronRightIcon, TruckIcon } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Badge, Card } from '@/src/components/ui';
import { useMyTrucks } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { truckCardLine } from '@/src/utils/truck-stock';

registerIcons(ChevronRightIcon, TruckIcon);

const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * My truck on the home screen (2026-11-24): the technician's own truck, how
 * much is on it and how much has run low, and their last slip. Shown only to
 * somebody the office has put on a truck: an office that does not keep stock
 * never sees it. One small read when home opens; nothing on a timer.
 */
export function MyTruckCard({ onOpen, className = '' }: { onOpen: () => void; className?: string }) {
  const trucks = useMyTrucks();
  const truck = trucks.data?.trucks[0];
  if (!truck) return null;
  const { held, low } = truckCardLine(truck);
  const last = trucks.data?.slips[0];

  return (
    <Card className={`p-0 ${className}`} density="row">
      <Pressable
        accessibilityHint="Opens what is on the truck"
        accessibilityLabel={`My truck, ${truck.name}, ${held}${low ? `, ${low} running low` : ''}`}
        accessibilityRole="button"
        className="gap-2 p-4 active:opacity-60"
        onPress={onOpen}
      >
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <TruckIcon className="text-primary" size={20} />
          </View>
          <View className="flex-1 gap-0.5">
            <Text className="text-base font-semibold text-foreground">My truck · {truck.name}</Text>
            <Text className="text-sm text-muted-foreground">{held}</Text>
          </View>
          {low ? <Badge label={`${low} running low`} tone="attention" /> : null}
          <ChevronRightIcon className="text-muted-foreground" size={20} />
        </View>
        {last ? (
          <Text className="border-t border-border pt-2 text-xs text-muted-foreground" numberOfLines={1}>
            Last: {last.number} · {last.lines.map((line) => `${line.quantity} × ${line.name}`).join(', ')}
            {last.job?.address ? ` · ${last.job.address}` : ''} · {when(last.at)}
          </Text>
        ) : null}
      </Pressable>
    </Card>
  );
}
