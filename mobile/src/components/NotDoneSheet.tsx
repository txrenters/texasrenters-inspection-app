import { CheckIcon, CircleIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ChoiceField } from '@/src/capture/ChecklistAnswerFields';
import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { notDoneReason, UNTICKED_REASON } from '@/src/utils/job-tasks';

registerIcons(CheckIcon, CircleIcon);

/** The reasons a technician most often gives, so one tap answers most of them. */
export const NOT_DONE_REASONS = ['Tenant refused', 'No access', 'Pets', 'No time'] as const;

/**
 * A service marked not done from its row, with a note for the office.
 *
 * The office, 2026-09-29: a technician who does the filter change and the
 * inspection but not the pest control needs to say so, and the office needs to
 * know it never happened and book it again. Nothing here is required -- the
 * reason is a shortcut, the note is optional, and a rebook is asked for unless
 * the technician says otherwise -- because End job no longer stops on a
 * service left unticked either.
 */
export function NotDoneSheet({
  title,
  visible,
  initial,
  onClose,
  onSave,
}: {
  /** The service: "Pest control". */
  title: string;
  visible: boolean;
  /** The answer already given, when the technician is changing it. */
  initial?: { reason: string | null; reschedule: boolean };
  onClose: () => void;
  onSave: (answer: { reason: string; reschedule: boolean }) => void;
}) {
  const theme = useThemeColors();
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [reschedule, setReschedule] = useState(true);

  // A fresh question each time the sheet opens, starting from the answer already there.
  useEffect(() => {
    if (!visible) return;
    const reason = initial?.reason?.trim() ?? '';
    const picked = NOT_DONE_REASONS.find((known) => reason === known || reason.startsWith(`${known} — `)) ?? null;
    setChoice(picked);
    setNote(
      reason === UNTICKED_REASON ? '' : picked ? reason.slice(picked.length).replace(/^ — /, '') : reason,
    );
    setReschedule(initial?.reschedule ?? true);
  }, [visible, title, initial?.reason, initial?.reschedule]);

  return (
    <BottomSheet accessibilityRole="alert" className="max-h-[88%]" onClose={onClose} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">{title} not done</Text>
          <Text className="text-sm text-muted-foreground">
            The office sees this, and knows it did not happen on this job.
          </Text>
        </View>

        <ChoiceField
          item={{ id: 'reason', label: `Why ${title} was not done`, choices: [...NOT_DONE_REASONS], keywords: [] }}
          onChange={setChoice}
          value={choice}
        />

        <TextInput
          accessibilityLabel={`A note about ${title}`}
          className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
          // Inside the server's MAX_SERVICE_REASON, with room for the reason picked.
          maxLength={400}
          multiline
          onChangeText={setNote}
          placeholder="Add a note (optional)"
          placeholderTextColor={theme.mutedForeground}
          value={note}
        />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: reschedule }}
          className="min-h-11 flex-row items-center gap-3"
          onPress={() => setReschedule((current) => !current)}
        >
          {reschedule ? (
            <CheckIcon size={18} className="text-primary" />
          ) : (
            <CircleIcon size={18} className="text-muted-foreground" />
          )}
          <Text className="text-sm text-foreground">Ask the office to book it again</Text>
        </Pressable>

        <View className="flex-row gap-3">
          <Button className="flex-1" label="Cancel" onPress={onClose} variant="secondary" />
          <Button
            className="flex-1"
            label="Save"
            onPress={() => onSave({ reason: notDoneReason(choice, note), reschedule })}
          />
        </View>
      </View>
    </BottomSheet>
  );
}
