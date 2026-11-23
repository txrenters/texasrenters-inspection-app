import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { phoneCountProblem, readPhoneCount, type PhoneCatalogItem, type PhoneCountLine, type PhoneFoundItem } from '@texasrenters/shared';

import { HomeButton } from '@/src/components/HomeButton';
import { ItemScanner } from '@/src/components/ItemScanner';
import { Badge, Button, Card } from '@/src/components/ui';
import { DetailSkeleton } from '@/src/components/ui/Skeleton';
import { useTruckCountActions, useTruckCountLocal, useTruckCounts } from '@/src/features/queries';
import { BelowHeader } from '@/src/lib/native-header';
import { QueuedOfflineError } from '@/src/repositories/api/offline-writes';
import { countLines, countName, countProgress, countedLines, scannedCountLine, withCount, withFound } from '@/src/utils/truck-count';
import { findOnTruck } from '@/src/utils/truck-stock';

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
 *
 * Redrawn 2026-11-24 (Inventory Screens canvas): the scanner fills the screen;
 * a code can be typed; and an item found on the truck that the count did not
 * list is added to it with how many were found, so the office sees it.
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
  /** Found on the truck and not on the list (2026-11-24): typed here, laid over what the phone holds. */
  const [foundHere, setFoundHere] = useState<PhoneFoundItem[]>([]);
  const [currentFound, setCurrentFound] = useState<PhoneCatalogItem | null>(null);
  const [looking, setLooking] = useState<'code' | 'found' | null>(null);
  const [lookFor, setLookFor] = useState('');

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
  const catalog = counts.data?.catalog ?? [];
  // What was found, less what the count now lists itself: once the office has it as a line it is counted there.
  const found = [...(pending?.found ?? []).filter((one) => !foundHere.some((here) => here.itemId === one.itemId)), ...foundHere].filter((one) => !lines.some((line) => line.itemId === one.itemId));
  const foundName = (itemId: string) => catalog.find((item) => item.itemId === itemId);
  const handedIn = Boolean(pending?.handIn);
  const second = lines.some((line) => line.second);
  const problem = phoneCountProblem(lines);
  const reading = typed.trim() === '' ? null : readPhoneCount(typed);
  const title = countName(count);

  const choose = (line: PhoneCountLine) => {
    setCurrentId(line.lineId);
    setCurrentFound(null);
    setTyped(line.counted === null ? '' : String(line.counted));
    setNote(null);
  };
  const chooseFound = (item: PhoneCatalogItem) => {
    setCurrentId(null);
    setCurrentFound(item);
    const before = found.find((one) => one.itemId === item.itemId);
    setTyped(before ? String(before.counted) : '');
    setLooking(null);
    setLookFor('');
    setNote(null);
  };

  const send = (next: PhoneCountLine[], handIn: boolean, nextFound: PhoneFoundItem[] = found) => {
    setNote(null);
    actions.save.mutate(
      { countId: count.id, title, lines: countedLines(next), handIn, ...(nextFound.length ? { found: nextFound } : {}), queuedAt: new Date().toISOString() },
      {
        onSuccess: (saved) => {
          setTypedHere({});
          setFoundHere([]);
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
    if (currentFound && reading !== null) {
      const nextFound = withFound(found, currentFound.itemId, reading);
      setFoundHere(withFound(foundHere, currentFound.itemId, reading));
      setSaid({ words: `${currentFound.name}: ${reading}, found`, bad: false });
      setCurrentFound(null);
      setTyped('');
      return send(lines, false, nextFound);
    }
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
    const hit = scannedCountLine(lines, code, catalog);
    if ('said' in hit) return setSaid({ words: hit.said, bad: true });
    if ('found' in hit) {
      chooseFound(hit.found);
      setScanning(false);
      return setSaid({ words: `${hit.found.code} · ${hit.found.name} is not on this count. Type how many you found.`, bad: false });
    }
    choose(hit.line);
    setScanning(false);
    setSaid({ words: `${hit.line.name}. Type how many are there.`, bad: false });
  };
  const lookUp = () => {
    if (looking === 'code') {
      scanned(lookFor);
      setLooking(null);
      setLookFor('');
    }
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
            <View className="mx-5 flex-row gap-3">
              <Button className="flex-1" label="Scan a label" onPress={() => setScanning(true)} />
              <Button className="flex-1" label="Type the code" onPress={() => setLooking(looking === 'code' ? null : 'code')} variant="secondary" />
            </View>

            {looking ? (
              <Card className="mx-5 gap-2">
                <Text className="text-sm font-semibold text-foreground">{looking === 'code' ? 'Item code' : 'Found something not on the list'}</Text>
                <TextInput
                  accessibilityLabel={looking === 'code' ? 'Item code' : 'Find the item you found'}
                  autoCapitalize={looking === 'code' ? 'characters' : 'none'}
                  autoCorrect={false}
                  autoFocus
                  className="min-h-12 rounded-xl border border-input bg-card px-4 text-base text-foreground"
                  onChangeText={setLookFor}
                  onSubmitEditing={lookUp}
                  placeholder={looking === 'code' ? 'FLT-16251' : 'Item code or name'}
                  returnKeyType="done"
                  value={lookFor}
                />
                {looking === 'code' ? (
                  <Button disabled={!lookFor.trim()} label="Find it" onPress={lookUp} />
                ) : (
                  findOnTruck(catalog, lookFor)
                    .filter((item) => !lines.some((line) => line.itemId === item.itemId))
                    .slice(0, 8)
                    .map((item) => (
                      <Pressable accessibilityRole="button" className="min-h-11 justify-center rounded-xl px-2 active:opacity-60" key={item.itemId} onPress={() => chooseFound(item)}>
                        <Text className="text-sm text-foreground">
                          {item.code} · {item.name}
                        </Text>
                      </Pressable>
                    ))
                )}
              </Card>
            ) : null}

            {said && !scanning ? (
              <Text accessibilityRole={said.bad ? 'alert' : 'text'} className={`mx-5 text-sm ${said.bad ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                {said.words}
              </Text>
            ) : null}

            {current || currentFound ? (
              <Card className="mx-5 gap-3">
                <View className="gap-0.5">
                  <Text className="text-base font-semibold text-foreground">{current?.name ?? currentFound?.name}</Text>
                  <Text className="text-xs text-muted-foreground">
                    {current ? `${current.code} · counted in ${current.unit}` : `${currentFound?.code} · found, not on the count`}
                  </Text>
                </View>
                <Text className="text-sm font-semibold text-foreground">How many are there?</Text>
                <TextInput
                  accessibilityLabel={`How many ${current?.name ?? currentFound?.name} are there`}
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
                <Button
                  disabled={reading === null}
                  label="Save and scan the next"
                  onPress={() => {
                    saveCurrent();
                    if (reading !== null) setScanning(true);
                  }}
                />
                <Button disabled={reading === null} label="Save" onPress={saveCurrent} variant="secondary" />
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

            {counted.length || found.length ? (
              <Card className="mx-5 gap-3">
                <Text className="text-base font-semibold text-foreground">Counted so far</Text>
                {found.map((one) => {
                  const item = foundName(one.itemId);
                  return item ? (
                    <Pressable accessibilityHint="Opens this item to change what was found" accessibilityRole="button" className="min-h-11 flex-row items-center gap-3 active:opacity-60" key={one.itemId} onPress={() => chooseFound(item)}>
                      <View className="flex-1 gap-0.5">
                        <Text className="text-sm text-foreground">{item.name}</Text>
                        <Text className="text-xs text-muted-foreground">{item.code} · found, not on the count</Text>
                      </View>
                      <Text className="text-base font-bold text-foreground">{one.counted}</Text>
                    </Pressable>
                  ) : null;
                })}
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

            <Button className="mx-5" label="Found something not on the list" onPress={() => setLooking(looking === 'found' ? null : 'found')} variant="secondary" />

            <View className="mx-5 gap-2">
              <Button busy={actions.save.isPending} disabled={Boolean(problem)} label="Hand in the count" onPress={() => send(lines, true)} />
              <Text className="text-xs leading-relaxed text-muted-foreground">
                {problem ?? 'Every item is counted. Once handed in, the office reviews it and tells you if any is to be counted again.'} What the office expects is never shown here, so the count is a real count.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
      {scanning && !handedIn ? (
        <ItemScanner
          hint="A scan finds the item and asks how many; it does not add one."
          onClose={() => setScanning(false)}
          onCode={scanned}
          said={said}
          title={`Count ${count.place.name}`}
        />
      ) : null}
    </BelowHeader>
  );
}
