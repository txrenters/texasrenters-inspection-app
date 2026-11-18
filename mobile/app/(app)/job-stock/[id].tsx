import { Stack, useLocalSearchParams } from 'expo-router';
import { MinusIcon, PlusIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { jobStockProblem, type JobStockItem, type PhoneSlipKind } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { Badge, Button, Card, SegmentedControl } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useJobStock, useJobStockActions, useJobStockLocal } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { BelowHeader } from '@/src/lib/native-header';
import { QueuedOfflineError } from '@/src/repositories/api/offline-writes';
import { newSlipKey, slipLines, slipSummary, stepped, takenForJob, truckStock, type PendingSlip } from '@/src/utils/job-stock';

registerIcons(MinusIcon, PlusIcon);

/**
 * A job's materials (2026-11-19, phase 7): what this technician took from the
 * truck for the job, and what they are putting back.
 *
 * The button answers on the tap. The slip is kept on the phone before it is
 * sent, comes off what the truck shows at once, and is listed as sending; with
 * no signal it waits and goes later. If the office's numbers then refuse it,
 * the list says it was not recorded and why -- it is never dropped quietly.
 *
 * The phone only ever takes from a truck and puts back what was taken for this
 * job. Moving stock into the truck, and undoing a slip, are the office's.
 */

const header = <Stack.Screen options={{ title: 'Materials', headerRight: () => <HomeButton /> }} />;
const MODES: readonly { value: PhoneSlipKind; label: string }[] = [
  { value: 'WITHDRAWAL', label: 'I took' },
  { value: 'RETURN', label: 'Putting back' },
];
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export default function JobStockScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const stock = useJobStock(id);
  const local = useJobStockLocal(id);
  const actions = useJobStockActions(id);
  const [mode, setMode] = useState<PhoneSlipKind>('WITHDRAWAL');
  const [chosenPlace, setChosenPlace] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  /** Recorded on this tap and not yet answered: shown at once, before the queue has been read again. */
  const [sending, setSending] = useState<PendingSlip[]>([]);
  const [error, setError] = useState<string | null>(null);

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
  const held = local.data?.pending ?? [];
  // What the phone is holding, and what this tap has just recorded: each once.
  const waiting = [...held, ...sending.filter((slip) => !held.some((kept) => kept.clientRequestId === slip.clientRequestId))];
  const refused = local.data?.refused ?? [];
  const offered: JobStockItem[] = mode === 'RETURN' ? takenForJob(data.taken, waiting) : placeId ? truckStock(data.stock, placeId, waiting) : [];
  const { lines, named } = slipLines(offered, quantities);
  const problem = lines.length ? jobStockProblem(mode, lines, new Map(offered.map((item) => [item.itemId, item.quantity])), (itemId) => offered.find((item) => item.itemId === itemId)?.name ?? 'that item') : null;

  const change = (next: PhoneSlipKind) => {
    setMode(next);
    setQuantities({});
    setError(null);
  };

  const record = () => {
    if (!placeId || !lines.length || problem) return;
    const slip: PendingSlip = { inspectionId: id, kind: mode, placeId, lines, clientRequestId: newSlipKey(), named, queuedAt: new Date().toISOString() };
    // Answered on the tap: the steppers clear and the slip is listed before the server has said anything.
    setSending((all) => [...all, slip]);
    setQuantities({});
    setError(null);
    actions.record.mutate(slip, {
      // Kept on the phone is not a failure: it is listed as waiting and goes when the signal is back.
      onError: (caught) => {
        if (!(caught instanceof QueuedOfflineError)) setError(caught instanceof Error && caught.message ? caught.message : 'That could not be recorded.');
      },
      onSettled: () => setSending((all) => all.filter((one) => one.clientRequestId !== slip.clientRequestId)),
    });
  };

  return (
    <BelowHeader className="bg-background">
      {header}
      <ScrollView contentContainerClassName="gap-5 pb-10 pt-2" contentInsetAdjustmentBehavior="automatic">
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
                        }}
                      >
                        <Text className={`text-sm font-semibold ${selected ? 'text-primary' : 'text-foreground'}`}>{place.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            <Card className="mx-5 gap-4">
              <View className="gap-1">
                <Text className="text-base font-semibold text-foreground">{mode === 'RETURN' ? 'What is going back' : `In ${data.places.find((place) => place.id === placeId)?.name ?? 'the truck'}`}</Text>
                <Text className="text-xs text-muted-foreground">
                  {mode === 'RETURN' ? 'Only what you took for this job can go back from here.' : 'Tap + for each one you used on this job.'}
                </Text>
              </View>
              {offered.length ? (
                offered.map((item) => {
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
                        onPress={() => setQuantities((all) => stepped(all, item.itemId, -1, item.quantity))}
                      >
                        <MinusIcon className={count <= 0 ? 'text-muted-foreground' : 'text-foreground'} size={16} />
                      </Pressable>
                      <Text accessibilityLabel={`${count} ${item.name}`} className="w-7 text-center text-base font-bold text-foreground">
                        {count}
                      </Text>
                      <Pressable
                        accessibilityLabel={`One more ${item.name}`}
                        accessibilityRole="button"
                        className="h-11 w-11 items-center justify-center rounded-xl border border-border bg-card active:opacity-70"
                        disabled={count >= item.quantity}
                        onPress={() => setQuantities((all) => stepped(all, item.itemId, 1, item.quantity))}
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
              {problem || error ? (
                <Text accessibilityRole="alert" className="text-xs text-destructive">
                  {problem ?? error}
                </Text>
              ) : null}
              <Button disabled={!lines.length || Boolean(problem)} label={mode === 'RETURN' ? 'Record what is going back' : 'Record what I took'} onPress={record} />
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
    </BelowHeader>
  );
}
