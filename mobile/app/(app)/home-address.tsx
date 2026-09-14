import { useEffect, useState } from 'react';
import { CheckCircle2Icon, HomeIcon, MapPinIcon } from 'lucide-react-native';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui';
import { BackGlyph } from '@/src/components/ui/BackGlyph';
import {
  useClearTechnicianHome,
  useSetTechnicianHome,
  useTechnicianHome,
} from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { goBack } from '@/src/lib/navigation';
import { useThemeColors } from '@/src/lib/theme-colors';
import { ApiConnectionError } from '@/src/storage/offline-record-cache';

registerIcons(CheckCircle2Icon, HomeIcon, MapPinIcon);

/**
 * Where a technician's day starts.
 *
 * The office route map draws each day from here until the handset starts
 * reporting a live position. Entered by the technician rather than inferred —
 * working out somebody's home from where their phone spends the night is the
 * tracking this app refuses to do outside working hours.
 */

/**
 * What to tell somebody when saving did not work.
 *
 * A connection failure is **not** a problem with the address, and must never
 * read as one. Sign-in once blamed the password for every 502 and unreachable
 * host, because it showed one message for every kind of failure. A 400 from the
 * API carries the server's own reason ("could not be found precisely") and is
 * shown as written; anything that never reached the server says so instead.
 */
export function homeSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiConnectionError)
    return 'Could not reach the office right now. Your address was not changed — try again when you have signal.';
  if (error instanceof Error && error.message) return error.message;
  return 'Your address could not be saved.';
}

export default function HomeAddressScreen() {
  const theme = useThemeColors();
  const home = useTechnicianHome();
  const save = useSetTechnicianHome();
  const clear = useClearTechnicianHome();

  const [draft, setDraft] = useState('');

  // Seeded once from what is stored, so the field opens holding the current
  // address to edit rather than empty. Not re-seeded on every refetch, which
  // would overwrite whatever somebody was halfway through typing.
  const stored = home.data?.address ?? '';
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || home.isLoading) return;
    setDraft(stored);
    setSeeded(true);
  }, [home.isLoading, seeded, stored]);

  const trimmed = draft.trim();
  const unchanged = trimmed === stored.trim();
  const matched = save.data?.matchedAddress ?? null;

  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center gap-3 px-5 pb-3 pt-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to settings"
            className="h-9 w-9 items-center justify-center rounded-full bg-card active:scale-95"
            onPress={() => goBack()}
          >
            <BackGlyph size={18} className="text-foreground" />
          </Pressable>
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-bold text-foreground">Home address</Text>
            <Text className="text-xs text-muted-foreground">Where your route starts each day</Text>
          </View>
        </View>

        <View className="mx-5 mt-2 rounded-2xl bg-card p-4">
          <Text className="text-sm leading-5 text-muted-foreground">
            Before you start sharing your location, the office map draws your day&apos;s route from here.
            Once your location is live, the route follows you instead.
          </Text>

          <Text className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Address
          </Text>
          <TextInput
            accessibilityLabel="Home address"
            autoCapitalize="words"
            autoComplete="street-address"
            autoCorrect={false}
            className="mt-1.5 rounded-xl bg-background px-3.5 py-3 text-base text-foreground"
            editable={!save.isPending}
            onChangeText={(next) => {
              setDraft(next);
              // A stale error beside a new address reads as though the new one
              // had also been refused.
              if (save.isError) save.reset();
            }}
            placeholder="12111 Westwold Dr, Tomball, TX 77377"
            placeholderTextColor={theme.mutedForeground}
            returnKeyType="done"
            textContentType="fullStreetAddress"
            value={draft}
          />

          {save.isError ? (
            <Text accessibilityLiveRegion="polite" className="mt-2 text-sm text-destructive">
              {homeSaveErrorMessage(save.error)}
            </Text>
          ) : null}

          {/* Read back what the address resolved to. A wrong suburb or a
              mistyped number is obvious here and invisible on a map the
              technician never sees. */}
          {save.isSuccess && matched ? (
            <View className="mt-3 flex-row items-start gap-2">
              <CheckCircle2Icon size={16} className="mt-0.5 text-chart-2" />
              <Text className="min-w-0 flex-1 text-sm text-foreground">
                Saved. Found as <Text className="font-semibold">{matched}</Text>
              </Text>
            </View>
          ) : null}

          <Button
            busy={save.isPending}
            busyLabel="Checking address…"
            className="mt-4"
            disabled={!trimmed || unchanged}
            icon={<MapPinIcon size={16} className="text-primary-foreground" />}
            label="Save address"
            onPress={() => save.mutate(trimmed)}
          />
        </View>

        {stored ? (
          <View className="mx-5 mt-3">
            <Button
              busy={clear.isPending}
              busyLabel="Removing…"
              label="Remove my address"
              onPress={() =>
                clear.mutate(undefined, {
                  onSuccess: () => {
                    setDraft('');
                    save.reset();
                  },
                })
              }
              variant="ghost"
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
