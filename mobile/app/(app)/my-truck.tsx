import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { runningLow, type MyTruckItem } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { ItemScanner } from '@/src/components/ItemScanner';
import { KeyboardAwareScrollView } from '@/src/components/KeyboardAwareScrollView';
import { Badge, Button, Card } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useMyTruckLocal, useMyTrucks, useJobStockActions } from '@/src/features/queries';
import { BelowHeader } from '@/src/lib/native-header';
import { slipSummary } from '@/src/utils/job-stock';
import { findOnTruck, lowOn, scannedOnTruck } from '@/src/utils/truck-stock';

/**
 * My truck (the office, 2026-11-24, approved on the Inventory Screens canvas):
 * what is on the technician's truck now, what has run low against what the
 * office keeps on it, and their last slips across jobs. From here they ask
 * the office for more, and scan a label to find an item.
 *
 * It moves no stock: taking happens on a job's Materials, and the truck is
 * filled by the office from the Storeroom. One read, kept on the phone so the
 * truck shows with no signal once it has been read.
 */

const header = <Stack.Screen options={{ title: 'My truck', headerRight: () => <HomeButton /> }} />;
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function ItemRow({ item, found }: { item: MyTruckItem; found: boolean }) {
  return (
    <View className={`min-h-11 flex-row items-center gap-3 border-t border-border py-2 ${found ? 'rounded-xl bg-primary/10 px-2' : ''}`}>
      <View className="flex-1 gap-0.5">
        <Text className="text-sm text-foreground">{item.name}</Text>
        <Text className="text-xs text-muted-foreground">
          {item.code}
          {item.keepAtLeast ? ` · keep ${item.keepAtLeast}` : ''}
        </Text>
      </View>
      <Text className={`text-lg font-bold ${item.onHand <= 0 ? 'text-destructive' : 'text-foreground'}`}>{item.onHand}</Text>
    </View>
  );
}

export default function MyTruckScreen() {
  const trucks = useMyTrucks();
  const local = useMyTruckLocal();
  const slipActions = useJobStockActions('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  // The bar pinned at the foot clears the home indicator, measured (2026-11-24): BelowHeader pads only the top.
  const insets = useSafeAreaInsets();
  const [said, setSaid] = useState<{ words: string; bad: boolean } | null>(null);
  const [found, setFound] = useState<string | null>(null);

  if (!trucks.data)
    return (
      <BelowHeader className="bg-background">
        {header}
        {trucks.isError ? (
          <View className="gap-3 p-5">
            <Text accessibilityRole="alert" className="text-sm text-foreground">
              Your truck could not be loaded. It needs a signal the first time.
            </Text>
            <Button label="Try again" onPress={() => void trucks.refetch()} variant="secondary" />
          </View>
        ) : (
          <DetailSkeleton sections={3} />
        )}
      </BelowHeader>
    );

  const data = trucks.data;
  const truck = data.trucks.find((one) => one.id === chosen) ?? data.trucks[0];
  if (!truck)
    return (
      <BelowHeader className="bg-background">
        {header}
        <Card className="mx-5 mt-4 gap-2">
          <Text className="text-base font-semibold text-foreground">No truck yet</Text>
          <Text className="text-sm leading-relaxed text-muted-foreground">The office has not put you on a truck. Ask them to add you to one.</Text>
        </Card>
      </BelowHeader>
    );

  const low = lowOn(truck);
  const shown = findOnTruck(
    truck.items.filter((item) => !runningLow(item)),
    search,
  );
  const lowShown = findOnTruck(low, search);
  const refusedSlips = local.data?.refusedSlips ?? [];
  const refusedAsks = local.data?.refused ?? [];
  const pendingAsks = (local.data?.pending ?? []).filter((ask) => ask.placeId === truck.id);

  const scanned = (code: string) => {
    const hit = scannedOnTruck(truck, data.catalog, code);
    if ('said' in hit) {
      setFound(null);
      return setSaid({ words: hit.said, bad: true });
    }
    setFound(hit.item.itemId);
    setSaid({ words: `${hit.item.code} · ${hit.item.name}: ${hit.item.onHand} on ${truck.name}${hit.item.keepAtLeast ? `, keep ${hit.item.keepAtLeast}` : ''}.`, bad: false });
  };
  const ask = () => router.push({ pathname: '/truck-ask/[placeId]', params: { placeId: truck.id } });

  return (
    <BelowHeader className="bg-background">
      {header}
      <KeyboardAwareScrollView
        // A style, not classes: the list adds the keyboard's height to this padding on Android.
        contentContainerStyle={{ gap: 16, paddingBottom: 24, paddingTop: 8 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <View className="mx-5 gap-0.5">
          <Text className="text-2xl font-bold text-foreground">{truck.name}</Text>
          <Text className="text-sm text-muted-foreground">
            {truck.mine ? 'Yours' : 'Shared'}
            {truck.lastCountedOn ? ` · last counted ${day(truck.lastCountedOn)}` : ' · not counted yet'}
          </Text>
        </View>

        {data.trucks.length > 1 ? (
          <View accessibilityRole="radiogroup" className="mx-5 flex-row flex-wrap gap-2">
            {data.trucks.map((one) => {
              const selected = one.id === truck.id;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className={`min-h-11 justify-center rounded-xl border px-4 active:opacity-70 ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
                  key={one.id}
                  onPress={() => setChosen(one.id)}
                >
                  <Text className={`text-sm font-semibold ${selected ? 'text-primary' : 'text-foreground'}`}>{one.name}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View className="mx-5 gap-1.5">
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Find on the truck</Text>
          <TextInput
            accessibilityLabel="Find on the truck"
            autoCorrect={false}
            className="min-h-12 rounded-xl border border-input bg-card px-4 text-base text-foreground"
            onChangeText={setSearch}
            placeholder="Item code or name"
            value={search}
          />
        </View>

        {low.length ? (
          <Card className="mx-5 gap-1">
            <View className="flex-row items-center gap-2 pb-1">
              <Text className="flex-1 text-base font-semibold text-foreground">Running low</Text>
              <Badge label={String(low.length)} tone="attention" />
            </View>
            {lowShown.map((item) => (
              <ItemRow found={found === item.itemId} item={item} key={item.itemId} />
            ))}
            <Button className="mt-2" label="Ask the office for these" onPress={ask} />
          </Card>
        ) : null}

        <Card className="mx-5 gap-1">
          <View className="flex-row items-center pb-1">
            <Text className="flex-1 text-base font-semibold text-foreground">Everything on the truck</Text>
            <Text className="text-sm text-muted-foreground">{truck.items.filter((item) => item.onHand > 0).length} items</Text>
          </View>
          {shown.length ? (
            shown.map((item) => <ItemRow found={found === item.itemId} item={item} key={item.itemId} />)
          ) : (
            <Text className="text-sm text-muted-foreground">{search.trim() ? 'Nothing on the truck has those words.' : 'The truck is empty. The office fills it from the storeroom.'}</Text>
          )}
        </Card>

        {pendingAsks.length || truck.asks.length || refusedAsks.length ? (
          <Card className="mx-5 gap-2">
            <Text className="text-base font-semibold text-foreground">My asks</Text>
            {refusedAsks.map((refusal) => (
              <View className="gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3" key={refusal.clientRequestId}>
                <Text accessibilityRole="alert" className="text-sm font-semibold text-destructive">
                  Not sent: {refusal.named.map((line) => `${line.quantity} × ${line.name}`).join(', ')}
                </Text>
                <Text className="text-sm leading-relaxed text-foreground">{refusal.reason}</Text>
              </View>
            ))}
            {pendingAsks.map((pending) => (
              <View className="flex-row items-center gap-2 border-t border-border py-2" key={pending.clientRequestId}>
                <Text className="flex-1 text-sm text-foreground">{pending.named.length} items · no signal: kept on the phone</Text>
                <Badge label="Waiting to send" tone="pending" />
              </View>
            ))}
            {truck.asks.map((one) => (
              <View className="flex-row items-center gap-2 border-t border-border py-2" key={one.id}>
                <View className="flex-1 gap-0.5">
                  <Text className="text-sm text-foreground">
                    {one.lines.length} {one.lines.length === 1 ? 'item' : 'items'} · {when(one.at)}
                  </Text>
                  <Text className="text-xs text-muted-foreground">{one.filled ? `Filled: ${one.filled.slipNumber}, ${when(one.filled.at)}` : 'Waiting for the office'}</Text>
                </View>
                <Badge label={one.status === 'FILLED' ? 'Filled' : 'Asked'} tone={one.status === 'FILLED' ? 'done' : 'attention'} />
              </View>
            ))}
          </Card>
        ) : null}

        {data.slips.length || refusedSlips.length ? (
          <Card className="mx-5 gap-1">
            <Text className="pb-1 text-base font-semibold text-foreground">My last slips</Text>
            {refusedSlips.map((slip) => (
              <View className="gap-1 border-t border-border py-2" key={slip.clientRequestId}>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Badge label="Not recorded" tone="critical" />
                  <Text className="flex-1 text-sm text-foreground">{slipSummary(slip.named)}</Text>
                </View>
                <Text className="text-xs text-muted-foreground">{slip.reason}</Text>
                <Button label="OK, I have read this" onPress={() => slipActions.dismiss.mutate(slip.clientRequestId, { onSettled: () => void local.refetch() })} variant="secondary" />
              </View>
            ))}
            {data.slips.map((slip) => (
              <View className="gap-0.5 border-t border-border py-2" key={slip.id}>
                <Text className={`text-sm ${slip.reversed ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  {slip.number}
                  {slip.job?.address ? ` · ${slip.job.address}` : ''}
                </Text>
                <Text className="text-xs text-muted-foreground">
                  {when(slip.at)} · {slip.lines.map((line) => `${line.quantity} × ${line.name}`).join(', ')}
                  {slip.kind === 'RETURN' ? ' back' : ''}
                </Text>
              </View>
            ))}
          </Card>
        ) : null}
      </KeyboardAwareScrollView>

      <View className="flex-row gap-3 border-t border-border bg-background px-5 pt-3" style={{ paddingBottom: Math.max(insets.bottom, 24) }}>
        <Button className="flex-1" label="Scan to find" onPress={() => setScanning(true)} variant="secondary" />
        <Button className="flex-1" label="Ask for more" onPress={ask} />
      </View>

      {scanning ? (
        <ItemScanner
          hint="Scan a label to see how many are on the truck."
          onClose={() => setScanning(false)}
          onCode={scanned}
          said={said}
          title={`Scan to find · ${truck.name}`}
        />
      ) : null}
    </BelowHeader>
  );
}
