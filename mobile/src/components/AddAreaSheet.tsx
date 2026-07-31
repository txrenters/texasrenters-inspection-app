import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useColorScheme } from 'nativewind';

import type { AreaEnvironment } from '../domain/models';
import { useAddArea } from '../features/queries';
import { announce } from '../lib/announce';

const ENVIRONMENTS: { value: AreaEnvironment; label: string }[] = [
  { value: 'INDOOR', label: 'Indoor' },
  { value: 'OUTDOOR', label: 'Outdoor' },
  { value: 'SEMI_OUTDOOR', label: 'Semi-outdoor' },
];

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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const addArea = useAddArea(inspectionId);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<AreaEnvironment>('INDOOR');
  const [floorName, setFloorName] = useState('');
  const [notes, setNotes] = useState('');

  const trimmedName = name.trim();
  const canSubmit = Boolean(trimmedName) && !addArea.isPending;

  const reset = () => {
    setName('');
    setEnvironment('INDOOR');
    setFloorName('');
    setNotes('');
    addArea.reset();
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = () => {
    if (!canSubmit) return;
    addArea.mutate(
      {
        name: trimmedName,
        environment,
        floorName: floorName.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (room) => {
          announce(`${trimmedName} added. Awaiting administrator approval.`);
          const id = room.id;
          reset();
          onClose();
          onAdded?.(id);
        },
        // Deliberately no onError: the message is rendered inline below, where
        // it stays on screen next to the field the technician has to change.
        // A duplicate name is the common case and needs a visible correction,
        // not a toast that disappears.
      },
    );
  };

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={close}>
      <View className="flex-1 justify-end bg-black/55">
        <View
          accessibilityRole="alert"
          accessibilityViewIsModal
          className="max-h-[88%] rounded-t-3xl bg-background px-5 pb-10 pt-6"
        >
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text className="text-xl font-bold text-foreground">Add an area</Text>
            <Text className="mt-2 text-sm leading-5 text-muted-foreground">
              For a space that is not on the property’s floor plan. It is added as a draft for an
              administrator to approve, and you can start recording it right away.
            </Text>

            <Text nativeID="add-area-name-label" className="mt-5 text-sm font-semibold text-foreground">
              Area name
            </Text>
            <TextInput
              accessibilityLabel="Area name"
              accessibilityLabelledBy="add-area-name-label"
              autoFocus
              className="mt-2 min-h-12 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              placeholder="Storage shed, hall closet…"
              placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
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

            <Text nativeID="add-area-floor-label" className="mt-4 text-sm font-semibold text-foreground">
              Floor <Text className="font-normal text-muted-foreground">(optional)</Text>
            </Text>
            <TextInput
              accessibilityLabel="Floor, optional"
              accessibilityLabelledBy="add-area-floor-label"
              className="mt-2 min-h-12 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              placeholder="Ground floor, Basement…"
              placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
              value={floorName}
              onChangeText={setFloorName}
            />
            <Text className="mt-1 text-xs text-muted-foreground">
              Left blank, it is filed under “Added areas”.
            </Text>

            <Text nativeID="add-area-notes-label" className="mt-4 text-sm font-semibold text-foreground">
              Notes <Text className="font-normal text-muted-foreground">(optional)</Text>
            </Text>
            <TextInput
              accessibilityLabel="Notes, optional"
              accessibilityLabelledBy="add-area-notes-label"
              className="mt-2 min-h-20 rounded-xl border border-border bg-card px-4 py-3 text-foreground"
              multiline
              textAlignVertical="top"
              placeholder="Why this area needs inspecting"
              placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
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
        </View>
      </View>
    </Modal>
  );
}
