import { CheckIcon, CircleIcon, MicIcon } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';
import { checklistProgress, type ChecklistItem } from './area-checklist';

registerIcons(CheckIcon, CircleIcon, MicIcon);

/**
 * The area's coverage checklist, opened from the camera's guide control.
 *
 * Replaces a static "Room capture guide" alert that said the same three
 * sentences in every room. This is specific to the area being recorded, and
 * doubles as a record of what the technician actually covered.
 *
 * Ticking is manual here. Items are also ticked automatically when the
 * technician says them aloud — see `matchChecklistMentions` — but a mention is
 * only evidence that something was talked about, so the technician stays able
 * to correct it either way.
 */
export function AreaChecklistSheet({
  areaName,
  items,
  checkedIds,
  onToggle,
  visible,
  onClose,
  recording,
}: {
  areaName: string;
  items: ChecklistItem[];
  checkedIds: readonly string[];
  onToggle: (id: string) => void;
  visible: boolean;
  onClose: () => void;
  /** Drives the "listening" hint; the sheet itself never touches the microphone. */
  recording: boolean;
}) {
  const { covered, total } = checklistProgress(items, checkedIds);
  const checked = new Set(checkedIds);

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-black/60">
        <View
          accessibilityViewIsModal
          className="max-h-[82%] rounded-t-3xl bg-background px-5 pb-10 pt-6"
        >
          <View className="flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text className="text-xl font-bold text-foreground">{areaName} checklist</Text>
              <Text
                accessibilityLabel={`${covered} of ${total} items covered`}
                className="mt-1 text-sm text-muted-foreground"
              >
                {covered} of {total} covered
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Close checklist"
              accessibilityRole="button"
              className="min-h-11 justify-center px-2"
              onPress={onClose}
            >
              <Text className="font-semibold text-primary">Done</Text>
            </Pressable>
          </View>

          {recording ? (
            <View className="mt-4 flex-row items-center gap-2 rounded-xl bg-primary/10 px-3 py-2.5">
              <MicIcon size={15} className="text-primary" />
              <Text className="min-w-0 flex-1 text-xs leading-4 text-primary">
                Items tick themselves when you mention them out loud. Tap any item to set it
                yourself.
              </Text>
            </View>
          ) : null}

          <ScrollView className="mt-4" showsVerticalScrollIndicator={false}>
            {items.map((item) => {
              const isChecked = checked.has(item.id);
              return (
                <Pressable
                  accessibilityHint={isChecked ? 'Marks this as not covered' : 'Marks this covered'}
                  accessibilityLabel={item.label}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isChecked }}
                  className={`mb-2 min-h-14 flex-row items-center gap-3 rounded-xl border px-4 py-3 ${
                    isChecked ? 'border-chart-3/40 bg-chart-3/10' : 'border-border bg-card'
                  }`}
                  key={item.id}
                  onPress={() => onToggle(item.id)}
                >
                  {isChecked ? (
                    <CheckIcon size={18} className="text-chart-3" />
                  ) : (
                    <CircleIcon size={18} className="text-muted-foreground" />
                  )}
                  <Text
                    className={`min-w-0 flex-1 text-sm ${
                      isChecked ? 'font-semibold text-foreground' : 'text-foreground'
                    }`}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
            <Text className="mb-2 mt-1 px-1 text-xs leading-4 text-muted-foreground">
              The checklist guides coverage. It does not replace the walkthrough video, and an
              unticked item does not block completing the area.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
