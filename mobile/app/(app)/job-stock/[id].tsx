import { Stack, router, useLocalSearchParams } from 'expo-router';
import { MinusIcon, PlusIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { jobStockProblem, type JobStockItem, type PhoneSlipKind } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { ItemScanner } from '@/src/components/ItemScanner';
import { Badge, Button, Card, SegmentedControl } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useJobStock, useJobStockActions, useJobStockLocal } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { BelowHeader } from '@/src/lib/native-header';
import { QueuedOfflineError } from '@/src/repositories/api/offline-writes';
import { scanOntoSlip } from '@/src/utils/item-scan';
import { newSlipKey, slipLines, slipSummary, stepped, takenForJob, truckStock, type PendingSlip } from '@/src/utils/job-stock';
import { findOnTruck } from '@/src/utils/truck-stock';

registerIcons(MinusIcon, PlusIcon);

/**
 * A job's materials (2026-11-19, phase 7; redrawn 2026-11-24 on the Inventory
 * Screens canvas): what this technician took from the truck for the job, and
 * what they are putting back. Scan each label, or find the item by name and
 * tap + or type how many.
 *
 * The button answers on the tap. The slip is kept on the phone before it is
 * sent, comes off what the truck shows at once, and is listed as sending; with
 * no signal it waits and goes later. If the office's numbers then refuse it,
 * the list says it was not recorded and why -- it is never dropped quietly.
 *
 * The phone only ever takes from a truck and puts back what was taken for this
 * job. An item the office's stock shows none of in the truck cannot be taken
 * here: the technician tells the office from My truck. Moving stock into the
 * truck, and undoing a slip, are the office's.
 */

const header = <Stack.Screen options={{ title: 'Materials', headerRight: () => <HomeButton /> }} />;
const MODES: readonly { value: PhoneSlipKind; label: string }[] = [
  { value: 'WITHDRAWAL', label: 'I took' },
  { value: 'RETURN', label: 'Putting back' },
];
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** A typed number of units as a whole number, or null. */
const readTyped = (typed: string) => (/^\d{1,6}$/.test(typed.trim()) ? Number(typed.trim()) : null);
/** The numbers being typed, less one: it shows what the steppers hold again. */
const without = (all: Readonly<Record<string, string>>, itemId: string) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== itemId));

export default function JobStockScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const stock = useJobStock(id);
  const local = useJobStockLocal(id);
  const actions = useJobStockActions(id);
  const [mode, setMode] = useState<PhoneSlipKind>('WITHDRAWAL');
  const [chosenPlace, setChosenPlace] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  /** A number being typed in place of + and −, by item, until it is left. */
  const [typing, setTyping] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  /** Recorded on this tap and not yet answered: shown at once, before the queue has been read again. */
  const [sending, setSending] = useState<PendingSlip[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The camera is open, looking for a label; and what the last label did. */
  const [scanning, setScanning] = useState(false);
  const [said, setSaid] = useState<{ words: string; bad: boolean } | null>(null);

  if (!stock.data) {
    return (
      <BelowHeader className="bg-background">
        {header}
        {stock.isError ? (
          <View className="gap-3 p-5">
            <Text accessibilityRole="alert" className="text-sm text-foreground">
              The truck&apos;s stock could not be loaded. It needs a signal the first time.
            </Text>
            <Button label="Try again" onPress={() => void stock.refetch()} variant="secondary" />
          </View>
        ) : (
          <DetailSkeleton sections={2} />
        )}
      </BelowHeader>
    );
  }

  const data = stock.data;
  const placeId = chosenPlace && data.places.some((place) => place.id === chosenPlace) ? chosenPlace : (data.places[0]?.id ?? null);
  const placeName = data.places.find((place) => place.id === placeId)?.name ?? 'the truck';
  const held = local.data?.pending ?? [];
  // What the phone is holding, and what this tap has just recorded: each once.
  const waiting = [...held, ...sending.filter((slip) => !held.some((kept) => kept.clientRequestId === slip.clientRequestId))];
  const refused = local.data?.refused ?? [];
  const offered: JobStockItem[] = mode === 'RETURN' ? takenForJob(data.taken, waiting) : placeId ? truckStock(data.stock, placeId, waiting) : [];
  const { lines, named } = slipLines(offered, quantities);
  const problem = lines.length ? jobStockProblem(mode, lines, new Map(offered.map((item) => [item.itemId, item.quantity])), (itemId) => offered.find((item) => item.itemId === itemId)?.name ?? 'that item') : null;
  const shown = findOnTruck(offered, search);
  // Found by name and none in the truck, by the office's stock: shown greyed, not offered (taking out, only).
  const noneHere = mode === 'WITHDRAWAL' && search.trim() ? findOnTruck(data.catalog, search).filter((item) => !offered.some((one) => one.itemId === item.itemId)).slice(0, 5) : [];
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);

  const change = (next: PhoneSlipKind) => {
    setMode(next);
    setQuantities({});
    setTyping({});
    setError(null);
    setSaid(null);
  };
  /** A scanned label is one more of that item, exactly as a tap on + is. */
  const scanned = (code: string) => {
    const next = scanOntoSlip(offered, quantities, code, mode, { catalog: data.catalog, placeName });
    setQuantities(next.quantities);
    setSaid(next.said);
  };
  /** A number typed: kept to what there is. */
  const typed = (item: JobStockItem, text: string) => {
    setTyping((all) => ({ ...all, [item.itemId]: text }));
    const value = readTyped(text);
    if (value !== null) setQuantities((all) => ({ ...all, [item.itemId]: Math.min(value, item.quantity) }));
  };

  const record = () => {
    if (!placeId || !lines.length || problem) return;
    const slip: PendingSlip = { inspectionId: id, kind: mode, placeId, lines, clientRequestId: newSlipKey(), named, queuedAt: new Date().toISOString() };
    // Answered on the tap: the steppers clear and the slip is listed before the server has said anything.
    setSending((all) => [...all, slip]);
    setQuantities({});
    setTyping({});
    setError(null);
    setSaid(null);
    setScanning(false);
    actions.record.mutate(slip, {
      // Kept on the phone is not a failure: it is listed as waiting and goes when the signal is back.
      onError: (caught) => {
        if (!(caught instanceof QueuedOfflineError)) setError(caught instanceof Error && caught.message ? caught.message : 'That could not be recorded.');
      },
      onSettled: () => setSending((all) => all.filter((one) => one.clientRequestId !== slip.clientRequestId)),
    });
  };
  const recordLabel = `${mode === 'RETURN' ? 'Record what is going back' : 'Record what I took'}${units ? ` · ${units} ${units === 1 ? 'item' : 'items'}` : ''}`;

  return (
    <BelowHeader className="bg-background">
      {header}
      <ScrollView contentContainerClassName="gap-5 pb-10 pt-2" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        {data.places.length ? (
          <>
            <SegmentedControl accessibilityLabel="What you are recording" onChange={change} options={MODES} value={mode} />

            {data.places.length > 1 ? (
              <View className="mx-5 gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{mode === 'RETURN' ? 'Into which truck' : 'From which truck'}</Text>
                <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
                  {data.places.map((place) => {
                    const selected = place.id === placeId;
                    return (
                      <Pressable
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        className={`min-h-11 justify-center rounded-xl border px-4 active:opacity-70 ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
                        key={place.id}
                        onPress={() => {
                          setChosenPlace(place.id);
                          setQuantities({});
                          setTyping({});
                          setSaid(null);
                        }}
                      >
                        <Text className={`text-sm font-semibold ${selected ? 'text-primary' : 'text-foreground'}`}>{place.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {offered.length ? <Button className="mx-5" label="Scan a label" onPress={() => setScanning(true)} /> : null}
            {offered.length ? (
              <View className="mx-5 gap-1.5">
                <Text className="text-xs font-semibold text-muted-foreground">{mode === 'RETURN' ? 'Or find what is going back' : `Or find it in ${placeName}`}</Text>
                <TextInput
                  accessibilityLabel={mode === 'RETURN' ? 'Find what is going back' : `Find it in ${placeName}`}
                  autoCorrect={false}
                  className="min-h-12 rounded-xl border border-input bg-card px-4 text-base text-foreground"
                  onChangeText={setSearch}
                  placeholder="Item code or name"
                  value={search}
                />
              </View>
            ) : null}

            <Card className="mx-5 gap-4">
              <View className="gap-1">
                <Text className="text-base font-semibold text-foreground">{mode === 'RETURN' ? 'What is going back' : `In ${placeName}`}</Text>
                <Text className="text-xs text-muted-foreground">
                  {mode === 'RETURN' ? 'Only what you took for this job can go back from here.' : 'Tap + for each one you used on this job, or tap the number to type it.'}
                </Text>
              </View>
              {offered.length ? (
                shown.map((item) => {
                  const count = quantities[item.itemId] ?? 0;
                  return (
                    <View className="flex-row items-center gap-3" key={item.itemId}>
                      <View className="flex-1 gap-0.5">
                        <Text className="text-sm font-semibold text-foreground">{item.name}</Text>
                        <Text className="text-xs text-muted-foreground">
                          {item.code} · {item.quantity} {mode === 'RETURN' ? 'taken' : 'in the truck'}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityLabel={`One fewer ${item.name}`}
                        accessibilityRole="button"
                        className="h-11 w-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
                        disabled={count <= 0}
                        onPress={() => {
                          setTyping((all) => without(all, item.itemId));
                          setQuantities((all) => stepped(all, item.itemId, -1, item.quantity));
                        }}
                      >
                        <MinusIcon className={count <= 0 ? 'text-muted-foreground' : 'text-foreground'} size={16} />
                      </Pressable>
                      <TextInput
                        accessibilityLabel={`How many ${item.name}`}
                        className="h-11 w-14 rounded-xl border border-input bg-card text-center text-base font-bold text-foreground"
                        keyboardType="number-pad"
                        maxLength={6}
                        onBlur={() => setTyping((all) => without(all, item.itemId))}
                        onChangeText={(text) => typed(item, text)}
                        selectTextOnFocus
                        value={typing[item.itemId] ?? String(count)}
                      />
                      <Pressable
                        accessibilityLabel={`One more ${item.name}`}
                        accessibilityRole="button"
                        className="h-11 w-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
                        disabled={count >= item.quantity}
                        onPress={() => {
                          setTyping((all) => without(all, item.itemId));
                          setQuantities((all) => stepped(all, item.itemId, 1, item.quantity));
                        }}
                      >
                        <PlusIcon className={count >= item.quantity ? 'text-muted-foreground' : 'text-foreground'} size={16} />
                      </Pressable>
                    </View>
                  );
                })
              ) : (
                <Text className="text-sm text-muted-foreground">
                  {mode === 'RETURN' ? 'Nothing has been taken for this job, so there is nothing to put back.' : 'This truck is empty. The office fills it from the storeroom.'}
                </Text>
              )}
              {offered.length && !shown.length && !noneHere.length ? <Text className="text-sm text-muted-foreground">Nothing in the list has those words.</Text> : null}
              {noneHere.map((item) => (
                <View className="gap-0.5" key={item.itemId}>
                  <Text className="text-sm font-semibold text-muted-foreground">{item.name}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {item.code} · none in {placeName} by the office&apos;s stock
                  </Text>
                  <Pressable accessibilityRole="link" className="min-h-9 justify-center active:opacity-60" onPress={() => router.push('/my-truck')}>
                    <Text className="text-xs font-semibold text-primary">Have one anyway? Tell the office on My truck.</Text>
                  </Pressable>
                </View>
              ))}
              {problem || error ? (
                <Text accessibilityRole="alert" className="text-xs text-destructive">
                  {problem ?? error}
                </Text>
              ) : null}
              <Button disabled={!lines.length || Boolean(problem)} label={recordLabel} onPress={record} />
            </Card>
          </>
        ) : (
          <Card className="mx-5 gap-2">
            <Text className="text-base font-semibold text-foreground">No truck yet</Text>
            <Text className="text-sm leading-relaxed text-muted-foreground">The office has not put you on a truck, so there is nothing to take from here. Ask them to add you to one.</Text>
          </Card>
        )}

        {refused.length || waiting.length || data.slips.length ? (
          <Card className="mx-5 gap-4">
            <Text className="text-base font-semibold text-foreground">Recorded for this job</Text>
            {refused.map((slip) => (
              <View className="gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3" key={slip.clientRequestId}>
                <Text accessibilityRole="alert" className="text-sm font-semibold text-destructive">
                  Not recorded: {slipSummary(slip.named)}
                </Text>
                <Text className="text-sm leading-relaxed text-foreground">{slip.reason}</Text>
                <Button label="OK, I have read this" onPress={() => actions.dismiss.mutate(slip.clientRequestId)} variant="secondary" />
              </View>
            ))}
            {waiting.map((slip) => (
              <View className="gap-1" key={slip.clientRequestId}>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className="text-sm font-semibold text-foreground">{slip.kind === 'RETURN' ? 'Put back' : 'Took'}</Text>
                  <Badge label={sending.some((one) => one.clientRequestId === slip.clientRequestId) ? 'Sending' : 'Waiting to send'} tone="pending" />
                </View>
                <Text className="text-sm text-muted-foreground">{slipSummary(slip.named)}</Text>
              </View>
            ))}
            {data.slips.map((slip) => (
              <View className="gap-1" key={slip.id}>
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text className={`text-sm font-semibold ${slip.reversed ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{slip.kind === 'RETURN' ? 'Put back' : 'Took'}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {slip.number} · {when(slip.at)} · {slip.place}
                  </Text>
                  {slip.reversed ? <Badge label="Removed by the office" /> : null}
                </View>
                <Text className="text-sm text-muted-foreground">{slipSummary(slip.lines)}</Text>
              </View>
            ))}
          </Card>
        ) : null}
      </ScrollView>

      {scanning ? (
        <ItemScanner
          hint="Point the camera at the label. Scan the same label again for one more."
          onClose={() => setScanning(false)}
          onCode={scanned}
          said={said}
          title={mode === 'RETURN' ? 'Scan what goes back' : `Scan to take · ${placeName}`}
          tray={
            lines.length ? (
              <View className="gap-2">
                <Text className="text-sm font-semibold text-foreground">
                  {mode === 'RETURN' ? 'Going back' : 'Taking for this job'} · {units} {units === 1 ? 'item' : 'items'}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {named.map((item) => (
                    <View className="rounded-full bg-card px-3 py-1.5" key={item.itemId}>
                      <Text className="text-sm text-foreground">
                        <Text className="font-bold">{item.quantity}</Text> {item.name}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null
          }
        />
      ) : null}
    </BelowHeader>
  );
}
