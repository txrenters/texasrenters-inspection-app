import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { normalizeStockCode, type PhoneCatalogItem } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { ItemScanner } from '@/src/components/ItemScanner';
import { Badge, Button, Card } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useMyTrucks, useTruckAskActions } from '@/src/features/queries';
import { BelowHeader } from '@/src/lib/native-header';
import { QueuedOfflineError } from '@/src/repositories/api/offline-writes';
import { askDraft, askLines, findOnTruck, newAskKey, readAskQuantity, withAdded, type AskDraftLine, type PendingAsk } from '@/src/utils/truck-stock';

/**
 * Ask the office for more (the office, 2026-11-24, approved on the Inventory
 * Screens canvas). What has run low is ticked with what brings it back up to
 * what the office keeps on the truck; anything else on the truck, or any item
 * in use found by a scan or a search, can be ticked too. A note says when it
 * can be picked up.
 *
 * Nothing moves until the office fills it: they post a move from the
 * Storeroom, and the ask shows Filled on My truck. Sent with no signal, it is
 * kept on the phone and goes later; refused then, My truck says why.
 */

const header = <Stack.Screen options={{ title: 'Ask for more', headerRight: () => <HomeButton /> }} />;

export default function TruckAskScreen() {
  const { placeId = '' } = useLocalSearchParams<{ placeId: string }>();
  const trucks = useMyTrucks();
  const actions = useTruckAskActions();
  const truck = trucks.data?.trucks.find((one) => one.id === placeId);
  const [draft, setDraft] = useState<AskDraftLine[] | null>(null);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [scanning, setScanning] = useState(false);
  const [said, setSaid] = useState<{ words: string; bad: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!trucks.data)
    return (
      <BelowHeader className="bg-background">
        {header}
        <DetailSkeleton sections={2} />
      </BelowHeader>
    );
  if (!truck)
    return (
      <BelowHeader className="bg-background">
        {header}
        <Card className="mx-5 mt-4 gap-2">
          <Text className="text-base font-semibold text-foreground">Not one of your trucks</Text>
          <Text className="text-sm leading-relaxed text-muted-foreground">Ask the office to put you on a truck first.</Text>
        </Card>
      </BelowHeader>
    );

  const lines = draft ?? askDraft(truck);
  const { lines: sent, named, problem } = askLines(lines);
  const catalog = trucks.data.catalog;
  const found = adding ? findOnTruck(catalog, search).filter((item) => !lines.some((line) => line.item.itemId === item.itemId && line.ticked)).slice(0, 8) : [];

  const set = (itemId: string, change: Partial<AskDraftLine>) => setDraft(lines.map((line) => (line.item.itemId === itemId ? { ...line, ...change } : line)));
  const add = (item: PhoneCatalogItem) => {
    setDraft(withAdded(lines, item));
    setSearch('');
    setAdding(false);
  };
  const scanned = (code: string) => {
    const item = catalog.find((one) => one.code === normalizeStockCode(code));
    if (!item) return setSaid({ words: `${normalizeStockCode(code).slice(0, 24)} is not an item code. Check the label, or type it.`, bad: true });
    setDraft(withAdded(lines, item));
    setSaid({ words: `${item.code} · ${item.name} is on the ask.`, bad: false });
  };

  const send = () => {
    if (problem) return;
    const ask: PendingAsk = { placeId: truck.id, placeName: truck.name, lines: sent, note: note.trim() || null, clientRequestId: newAskKey(), named, queuedAt: new Date().toISOString() };
    setError(null);
    actions.ask.mutate(ask, {
      onSuccess: () => router.back(),
      onError: (caught) => {
        // Kept on the phone is not a failure: My truck lists it as waiting, and it goes when the signal is back.
        if (caught instanceof QueuedOfflineError) return router.back();
        setError(caught instanceof Error && caught.message ? caught.message : 'That could not be asked.');
      },
    });
  };
  const ticked = sent.length;

  return (
    <BelowHeader className="bg-background">
      {header}
      <ScrollView contentContainerClassName="gap-4 pb-6 pt-2" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        <View className="mx-5 gap-1">
          <Text className="text-2xl font-bold text-foreground">Ask for more</Text>
          <Text className="text-sm leading-relaxed text-muted-foreground">The office fills {truck.name} from the Storeroom. Nothing moves until they do.</Text>
        </View>

        <Card className="mx-5 gap-1">
          <View className="flex-row items-center pb-1">
            <Text className="flex-1 text-base font-semibold text-foreground">What to ask for</Text>
            <Text className="text-sm text-muted-foreground">How many</Text>
          </View>
          {lines.map((line) => (
            <View className="min-h-12 flex-row items-center gap-3 border-t border-border py-2" key={line.item.itemId}>
              <Pressable
                accessibilityLabel={`Ask for ${line.item.name}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: line.ticked }}
                className={`h-7 w-7 items-center justify-center rounded-md border-2 ${line.ticked ? 'border-primary bg-primary' : 'border-input bg-card'}`}
                onPress={() => set(line.item.itemId, { ticked: !line.ticked, quantity: !line.ticked && !line.quantity ? '1' : line.quantity })}
              >
                {line.ticked ? <Text className="text-sm font-bold text-primary-foreground">✓</Text> : null}
              </Pressable>
              <View className="flex-1 gap-0.5">
                <Text className="text-sm text-foreground">{line.item.name}</Text>
                <Text className="text-xs text-muted-foreground">
                  {line.onHand} on the truck · {line.keepAtLeast ? `keep ${line.keepAtLeast}` : 'not kept on it'}
                </Text>
              </View>
              <TextInput
                accessibilityLabel={`How many ${line.item.name} to ask for`}
                className={`h-11 w-16 rounded-xl border bg-card text-center text-base font-bold text-foreground ${line.ticked && readAskQuantity(line.quantity) === null ? 'border-destructive' : 'border-input'}`}
                keyboardType="number-pad"
                maxLength={6}
                onChangeText={(text) => set(line.item.itemId, { quantity: text, ticked: text.trim() !== '' || line.ticked })}
                value={line.quantity}
              />
            </View>
          ))}
          {adding ? (
            <View className="gap-2 border-t border-border pt-3">
              <TextInput
                accessibilityLabel="Find an item to add"
                autoCorrect={false}
                autoFocus
                className="min-h-12 rounded-xl border border-input bg-card px-4 text-base text-foreground"
                onChangeText={setSearch}
                placeholder="Item code or name"
                value={search}
              />
              {found.map((item) => (
                <Pressable accessibilityRole="button" className="min-h-11 justify-center rounded-xl px-2 active:opacity-60" key={item.itemId} onPress={() => add(item)}>
                  <Text className="text-sm text-foreground">
                    {item.code} · {item.name}
                  </Text>
                </Pressable>
              ))}
              <Button label="Scan a label" onPress={() => setScanning(true)} variant="secondary" />
            </View>
          ) : (
            <Button className="mt-2" label="Add another item · scan or find" onPress={() => setAdding(true)} variant="secondary" />
          )}
        </Card>

        <View className="mx-5 gap-1.5">
          <Text className="text-xs font-semibold text-muted-foreground">Note for the office (optional)</Text>
          <TextInput
            accessibilityLabel="Note for the office"
            className="min-h-12 rounded-xl border border-input bg-card px-4 text-base text-foreground"
            maxLength={500}
            onChangeText={setNote}
            placeholder="I can pick up Wednesday morning"
            value={note}
          />
        </View>

        {truck.asks.length ? (
          <Card className="mx-5 gap-1">
            <Text className="pb-1 text-base font-semibold text-foreground">My asks</Text>
            {truck.asks.slice(0, 4).map((one) => (
              <View className="flex-row items-center gap-2 border-t border-border py-2" key={one.id}>
                <Text className="flex-1 text-sm text-foreground">
                  {one.lines.length} {one.lines.length === 1 ? 'item' : 'items'} · {one.filled ? `Filled: ${one.filled.slipNumber}` : 'Waiting for the office'}
                </Text>
                <Badge label={one.status === 'FILLED' ? 'Filled' : 'Asked'} tone={one.status === 'FILLED' ? 'done' : 'attention'} />
              </View>
            ))}
          </Card>
        ) : null}
      </ScrollView>

      <View className="gap-2 border-t border-border bg-background px-5 pb-6 pt-3">
        {problem && ticked ? (
          <Text accessibilityRole="alert" className="text-xs text-destructive">
            {problem}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-xs text-destructive">
            {error}
          </Text>
        ) : null}
        <Button busy={actions.ask.isPending} disabled={Boolean(problem)} label={`Send the ask${ticked ? ` · ${ticked} ${ticked === 1 ? 'item' : 'items'}` : ''}`} onPress={send} />
      </View>

      {scanning ? (
        <ItemScanner hint="Scan a label to put the item on the ask." onClose={() => setScanning(false)} onCode={scanned} said={said} title={`Ask for more · ${truck.name}`} />
      ) : null}
    </BelowHeader>
  );
}
