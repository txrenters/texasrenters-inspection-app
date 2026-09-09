import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { AreaEnvironment } from '../domain/models';
import { useAddArea } from '../features/queries';
import { announce } from '../lib/announce';
import { BottomSheet } from './BottomSheet';
import { Loader } from './ui/Loader';
import type { AddAreaInput } from '../repositories/contracts';
import { useThemeColors } from '../lib/theme-colors';

const ENVIRONMENTS: { value: AreaEnvironment; label: string }[] = [
  { value: 'INDOOR', label: 'Indoor' },
  { value: 'OUTDOOR', label: 'Outdoor' },
  { value: 'SEMI_OUTDOOR', label: 'Semi-outdoor' },
];

/**
 * There is no grace period. Confirming writes the area.
 *
 * There used to be one: five seconds, then three, on the reasoning that an
 * added area is a draft an administrator has to review, so an accidental one
 * costs somebody else time. Both numbers were wrong, and the direction was too.
 *
 * The field answer, 2026-09-09: an occupied inspection is walked in about
 * fifteen minutes, and a technician adding several rooms in a row paid the
 * countdown every time. The safeguard also protected very little — the mistake
 * it catches is one the technician has already seen on screen and can fix by
 * asking an administrator to reject a draft, which is the same conversation
 * they would have had anyway. A delay every technician pays on every area, to
 * spare an occasional correction somebody else makes, is the wrong trade.
 */

/**
 * Lets a technician add an area the floor plan does not have.
 *
 * The backend already accepted these — it creates the area with
 * `source: TECHNICIAN` and `status: DRAFT` and writes a `TECHNICIAN_AREA_ADDED`
 * audit entry — but nothing in the app ever called it. A technician who found a
 * room, closet, or outbuilding that was not on the plan had to stop and ask an
 * administrator to add it before they could record anything.
 *
 * Added areas are drafts, not approved ones: an administrator still decides
 * whether the area belongs on the property. The copy says so, so nobody assumes
 * they have just edited the official plan.
 */
export function AddAreaSheet({
  inspectionId,
  visible,
  onClose,
  onAdded,
}: {
  inspectionId: string;
  visible: boolean;
  onClose: () => void;
  /** Called with the new area's id, so the caller can send the technician straight into it. */
  onAdded?: (roomId: string) => void;
}) {
  const theme = useThemeColors();
  const addArea = useAddArea(inspectionId);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<AreaEnvironment>('INDOOR');
  const [floorName, setFloorName] = useState('');
  const [notes, setNotes] = useState('');

  // Props are read through refs so `commit` does not depend on callback
  // identity: the parent passes inline arrows, and rebuilding the callback on
  // every render used to restart the grace-period timer that lived here.
  const callbacks = useRef({ onClose, onAdded });
  callbacks.current = { onClose, onAdded };

  const trimmedName = name.trim();
  const canSubmit = Boolean(trimmedName) && !addArea.isPending;

  const reset = useCallback(() => {
    setName('');
    setEnvironment('INDOOR');
    setFloorName('');
    setNotes('');
    addArea.reset();
  }, [addArea]);

  const close = () => {
    reset();
    onClose();
  };

  const commit = useCallback(
    (input: AddAreaInput) => {
      addArea.mutate(input, {
        onSuccess: (room) => {
          announce(`${input.name} added. Awaiting administrator approval.`);
          const id = room.id;
          reset();
          callbacks.current.onClose();
          callbacks.current.onAdded?.(id);
        },
        // Deliberately no onError: the message is rendered inline below, where
        // it stays on screen next to the field the technician has to change.
        // A duplicate name is the common case and needs a visible correction,
        // not a toast that disappears.
      });
    },
    [addArea, reset],
  );

  const submit = () => {
    if (!canSubmit) return;
    announce(`Adding ${trimmedName}.`);
    commit({
      name: trimmedName,
      environment,
      floorName: floorName.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <BottomSheet
      accessibilityRole="alert"
      animationType="fade"
      className="max-h-[88%]"
      onClose={close}
      visible={visible}
    >
      {addArea.isPending ? (
        <View className="items-center gap-4 py-4">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Loader size="lg" />
          </View>
          {/* No cancel. The request is already in flight, and offering one
              would imply a rollback that will not happen — which is what the
              button did for the last second of the old countdown anyway. */}
          <View
            accessibilityLiveRegion="polite"
            accessibilityRole="progressbar"
            className="items-center gap-1"
          >
            <Text className="text-lg font-bold text-foreground">Adding “{trimmedName}”</Text>
            <Text className="text-center text-sm text-muted-foreground">Saving…</Text>
          </View>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text className="text-xl font-bold text-foreground">Add an area</Text>
          <Text className="mt-2 text-sm leading-5 text-muted-foreground">
            For a space that is not on the property’s floor plan. It is added as a draft for an
            administrator to approve, and you can start recording it right away.
          </Text>

          <Text
            nativeID="add-area-name-label"
            className="mt-5 text-sm font-semibold text-foreground"
          >
            Area name
          </Text>
          <TextInput
            accessibilityLabel="Area name"
            accessibilityLabelledBy="add-area-name-label"
            autoFocus
            className="mt-2 min-h-12 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
            placeholder="Storage shed, hall closet…"
            placeholderTextColor={theme.mutedForeground}
            value={name}
            onChangeText={setName}
            returnKeyType="done"
            onSubmitEditing={submit}
          />

          <Text className="mt-4 text-sm font-semibold text-foreground">Environment</Text>
          <View className="mt-2 flex-row gap-2">
            {ENVIRONMENTS.map((option) => {
              const selected = environment === option.value;
              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className={`min-h-12 flex-1 items-center justify-center rounded-xl border px-2 py-3 ${
                    selected ? 'border-primary bg-primary/10' : 'border-border bg-card'
                  }`}
                  key={option.value}
                  onPress={() => setEnvironment(option.value)}
                >
                  <Text
                    className={`text-center text-xs font-semibold ${
                      selected ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text
            nativeID="add-area-floor-label"
            className="mt-4 text-sm font-semibold text-foreground"
          >
            Floor <Text className="font-normal text-muted-foreground">(optional)</Text>
          </Text>
          <TextInput
            accessibilityLabel="Floor, optional"
            accessibilityLabelledBy="add-area-floor-label"
            className="mt-2 min-h-12 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
            placeholder="Ground floor, Basement…"
            placeholderTextColor={theme.mutedForeground}
            value={floorName}
            onChangeText={setFloorName}
          />
          <Text className="mt-1 text-xs text-muted-foreground">
            Left blank, it is filed under “Added areas”.
          </Text>

          <Text
            nativeID="add-area-notes-label"
            className="mt-4 text-sm font-semibold text-foreground"
          >
            Notes <Text className="font-normal text-muted-foreground">(optional)</Text>
          </Text>
          <TextInput
            accessibilityLabel="Notes, optional"
            accessibilityLabelledBy="add-area-notes-label"
            className="mt-2 min-h-20 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
            multiline
            textAlignVertical="top"
            placeholder="Why this area needs inspecting"
            placeholderTextColor={theme.mutedForeground}
            value={notes}
            onChangeText={setNotes}
          />

          {addArea.isError ? (
            <View
              accessibilityLiveRegion="polite"
              className="mt-4 rounded-xl border border-destructive/20 bg-destructive/10 p-3"
            >
              <Text className="text-sm text-destructive">
                {addArea.error instanceof Error
                  ? addArea.error.message
                  : 'The area could not be added.'}
              </Text>
            </View>
          ) : null}

          <View className="mt-5 flex-row gap-3">
            <Pressable
              accessibilityLabel="Cancel"
              accessibilityRole="button"
              className="min-h-12 flex-1 items-center justify-center rounded-xl border border-border py-3"
              onPress={close}
            >
              <Text className="font-semibold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityHint={trimmedName ? undefined : 'Enter an area name first'}
              accessibilityLabel={addArea.isPending ? 'Adding' : 'Add area'}
              accessibilityRole="button"
              accessibilityState={{ busy: addArea.isPending, disabled: !canSubmit }}
              className={`min-h-12 flex-1 items-center justify-center rounded-xl py-3 ${
                canSubmit ? 'bg-primary' : 'bg-muted'
              }`}
              disabled={!canSubmit}
              onPress={submit}
            >
              <Text
                className={`font-bold ${
                  canSubmit ? 'text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {addArea.isPending ? 'Adding…' : 'Add area'}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </BottomSheet>
  );
}
