import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { phoneCountProblem, readPhoneCount, type PhoneCountLine } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { ItemScanner } from '@/src/components/ItemScanner';
import { Badge, Button, Card } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useTruckCountActions, useTruckCountLocal, useTruckCounts } from '@/src/features/queries';
import { BelowHeader } from '@/src/lib/native-header';
import { QueuedOfflineError } from '@/src/repositories/api/offline-writes';
import { countLines, countName, countProgress, countedLines, scannedCountLine, withCount } from '@/src/utils/truck-count';

/**
 * Counting a truck (2026-11-19): scan a label, type how many are there, and
 * hand the count in when every item has a number.
 *
 * It is blind. The office's own number for an item is never sent to the
 * phone, so there is nothing here to compare against: the technician counts
 * what is in the truck. A count far out comes back for a second count, and
 * the office, never the counter, approves it.
 *
 * Every number is kept on the phone before it is sent, so a count made in a
 * garage with no signal is not lost and goes when the signal is back.
 */

const header = <Stack.Screen options={{ title: 'Truck count', headerRight: () => <HomeButton /> }} />;

export default function TruckCountScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const counts = useTruckCounts();
  const local = useTruckCountLocal(id);
  const actions = useTruckCountActions();
  /** Numbers typed on this screen, shown at once: laid over what the server and the phone's own copy hold. */
  const [typedHere, setTypedHere] = useState<Record<string, number>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [scanning, setScanning] = useState(false);
  const [said, setSaid] = useState<{ words: string; bad: boolean } | null>(null);
  const [note, setNote] = useState<{ words: string; bad: boolean } | null>(null);
  /** Set once this screen has handed the count in, so it says so after the count has left the list. */
  const [done, setDone] = useState<string | null>(null);

  if (counts.isLoading && !counts.data)
    return (
      <BelowHeader className="bg-background">
        {header}
        <DetailSkeleton />
      </BelowHeader>
    );

  const count = counts.data?.counts.find((one) => one.id === id);
  const pending = local.data ?? null;
  if (!count)
    return (
      <BelowHeader className="bg-background">
        {header}
        <Card className="mx-5 mt-4 gap-2">
          <Text className="text-base font-semibold text-foreground">{done ? 'Handed in' : 'Nothing to count here'}</Text>
          <Text className="text-sm leading-relaxed text-muted-foreground">{done ?? 'This count has been handed in, or the office closed it. A new one shows on the home screen when the office starts it.'}</Text>
        </Card>
      </BelowHeader>
    );

  const key = (line: Pick<PhoneCountLine, 'lineId' | 'second'>) => `${line.lineId}|${line.second}`;
  const lines = countLines(count.lines, pending).map((line) => (typedHere[key(line)] === undefined ? line : { ...line, counted: typedHere[key(line)]! }));
  const current = lines.find((line) => line.lineId === currentId) ?? null;
  const handedIn = Boolean(pending?.handIn);
  const second = lines.some((line) => line.second);
  const problem = phoneCountProblem(lines);
  const reading = typed.trim() === '' ? null : readPhoneCount(typed);
  const title = countName(count);

  const choose = (line: PhoneCountLine) => {
    setCurrentId(line.lineId);
    setTyped(line.counted === null ? '' : String(line.counted));
    setNote(null);
  };

  const send = (next: PhoneCountLine[], handIn: boolean) => {
    setNote(null);
    actions.save.mutate(
      { countId: count.id, title, lines: countedLines(next), handIn, queuedAt: new Date().toISOString() },
      {
        onSuccess: (saved) => {
          setTypedHere({});
          if (saved.outcome === 'recount') {
            setNote({ words: saved.recounts === 1 ? '1 item is far from what the office has. Count it a second time.' : `${saved.recounts} items are far from what the office has. Count them a second time.`, bad: true });
            setCurrentId(null);
          } else if (handIn) setDone('The office reviews it now. Thank you.');
        },
        onError: (caught) => {
          // Kept on the phone is not a failure: it goes when the signal is back.
          if (caught instanceof QueuedOfflineError) {
            if (handIn) setNote({ words: 'Handed in. It will send when there is signal.', bad: false });
            return;
          }
          setNote({ words: caught instanceof Error && caught.message ? caught.message : 'That could not be saved.', bad: true });
        },
      },
    );
  };

  const saveCurrent = () => {
    if (!current || reading === null) return;
    const next = withCount(lines, current.lineId, reading);
    // Answered on the tap: the number shows before the server has said anything.
    setTypedHere((all) => ({ ...all, [key(current)]: reading }));
    setSaid({ words: `${current.name}: ${reading}`, bad: false });
    setCurrentId(null);
    setTyped('');
    send(next, false);
  };

  const scanned = (code: string) => {
    const found = scannedCountLine(lines, code);
    if ('said' in found) return setSaid({ words: found.said, bad: true });
    choose(found.line);
    setSaid({ words: `${found.line.name}. Type how many are there.`, bad: false });
  };

  const left = lines.filter((line) => line.counted === null);
  const counted = lines.filter((line) => line.counted !== null);

  return (
    <BelowHeader className="bg-background">
      {header}
      <ScrollView contentContainerClassName="gap-5 pb-10 pt-2" contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
        <View className="mx-5 gap-1">
          <Text className="text-lg font-semibold text-foreground">{count.place.name}</Text>
          <Text className="text-sm text-muted-foreground">
            {count.title} · {count.number} · {countProgress(lines)}
          </Text>
          {second ? <Text className="text-sm font-semibold text-foreground">These are counted a second time. Count them again carefully.</Text> : null}
        </View>

        {handedIn ? (
          <Card className="mx-5 gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              <Text className="text-base font-semibold text-foreground">Handed in</Text>
              <Badge label="Waiting to send" tone="pending" />
            </View>
            <Text className="text-sm leading-relaxed text-muted-foreground">Your count is kept on this phone and goes to the office when there is signal. There is nothing more to do here.</Text>
          </Card>
        ) : (
          <>
            {scanning ? (
              <ItemScanner onClose={() => setScanning(false)} onCode={scanned} said={said} />
            ) : (
              <Button className="mx-5" label="Scan a label" onPress={() => setScanning(true)} />
            )}

            {current ? (
              <Card className="mx-5 gap-3">
                <View className="gap-0.5">
                  <Text className="text-base font-semibold text-foreground">{current.name}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {current.code} · counted in {current.unit}
                  </Text>
                </View>
                <Text className="text-sm font-semibold text-foreground">How many are there?</Text>
                <TextInput
                  accessibilityLabel={`How many ${current.name} are there`}
                  autoFocus
                  className="min-h-12 rounded-xl border border-border bg-card px-4 text-center text-xl font-bold text-foreground"
                  inputMode="numeric"
                  keyboardType="number-pad"
                  maxLength={7}
                  onChangeText={setTyped}
                  onSubmitEditing={saveCurrent}
                  returnKeyType="done"
                  value={typed}
                />
                {typed.trim() !== '' && reading === null ? (
                  <Text accessibilityRole="alert" className="text-xs text-destructive">
                    A count is a whole number, 0 or more.
                  </Text>
                ) : null}
                <Button disabled={reading === null} label={scanning ? 'Save and scan the next' : 'Save'} onPress={saveCurrent} />
              </Card>
            ) : null}

            {note ? (
              <Text accessibilityRole={note.bad ? 'alert' : 'text'} className={`mx-5 text-sm ${note.bad ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                {note.words}
              </Text>
            ) : null}

            {left.length ? (
              <Card className="mx-5 gap-3">
                <Text className="text-base font-semibold text-foreground">Still to count</Text>
                {left.map((line) => (
                  <Pressable accessibilityHint="Opens this item to type its count" accessibilityRole="button" className="min-h-11 flex-row items-center gap-3 active:opacity-60" key={line.lineId} onPress={() => choose(line)}>
                    <View className="flex-1 gap-0.5">
                      <Text className="text-sm font-semibold text-foreground">{line.name}</Text>
                      <Text className="text-xs text-muted-foreground">{line.code}</Text>
                    </View>
                    <Text className="text-sm text-muted-foreground">Count</Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}

            {counted.length ? (
              <Card className="mx-5 gap-3">
                <Text className="text-base font-semibold text-foreground">Counted so far</Text>
                {counted.map((line) => (
                  <Pressable accessibilityHint="Opens this item to change its count" accessibilityRole="button" className="min-h-11 flex-row items-center gap-3 active:opacity-60" key={line.lineId} onPress={() => choose(line)}>
                    <View className="flex-1 gap-0.5">
                      <Text className="text-sm text-foreground">{line.name}</Text>
                      <Text className="text-xs text-muted-foreground">{line.code}</Text>
                    </View>
                    <Text className="text-base font-bold text-foreground">{line.counted}</Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}

            <View className="mx-5 gap-2">
              <Button busy={actions.save.isPending} disabled={Boolean(problem)} label="Hand in the count" onPress={() => send(lines, true)} />
              <Text className="text-xs leading-relaxed text-muted-foreground">
                {problem ?? 'Every item is counted. Once handed in it cannot be changed from the phone.'} What the office expects is never shown here, so the count is a real count.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </BelowHeader>
  );
}
