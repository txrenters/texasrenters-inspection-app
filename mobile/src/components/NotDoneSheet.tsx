import { CheckIcon, CircleIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ChoiceField } from '@/src/capture/ChecklistAnswerFields';
import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';

registerIcons(CheckIcon, CircleIcon);

/** The reasons a technician most often gives, so one tap answers most of them. */
export const NOT_DONE_REASONS = ['Tenant refused', 'No access', 'Pets', 'Other'] as const;
const OTHER = 'Other';

/**
 * Why a service left unticked was not done, asked at End job.
 *
 * Pest control is a checkbox now (the office, 2026-09-18), and a box left
 * unticked is a service that did not happen. The office's rule still wants the
 * reason -- it is the line a coordinator reads before booking it again -- so
 * End job asks, and then carries on submitting (the owner's choice: "Ask why,
 * then submit").
 */
export function NotDoneSheet({
  title,
  visible,
  onClose,
  onSave,
}: {
  /** The service: "Pest control". */
  title: string;
  visible: boolean;
  onClose: () => void;
  onSave: (answer: { reason: string; reschedule: boolean }) => void;
}) {
  const theme = useThemeColors();
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [reschedule, setReschedule] = useState(true);

  // A fresh question for each service asked about.
  useEffect(() => {
    if (!visible) return;
    setChoice(null);
    setOther('');
    setReschedule(true);
  }, [visible, title]);

  const reason = choice === OTHER ? other.trim() : (choice ?? '');
  const ready = reason.length > 0;

  return (
    <BottomSheet accessibilityRole="alert" className="max-h-[88%]" onClose={onClose} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">{title} isn’t ticked</Text>
          <Text className="text-sm text-muted-foreground">Why wasn’t it done? The office sees your answer.</Text>
        </View>

        <ChoiceField
          item={{ id: 'reason', label: `Why ${title} was not done`, choices: [...NOT_DONE_REASONS], keywords: [] }}
          onChange={setChoice}
          value={choice}
        />

        {choice === OTHER ? (
          <TextInput
            accessibilityLabel={`Why ${title} was not done`}
            autoFocus
            className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
            multiline
            onChangeText={setOther}
            placeholder="What happened"
            placeholderTextColor={theme.mutedForeground}
            value={other}
          />
        ) : null}

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
          <Button className="flex-1" disabled={!ready} label="Save" onPress={() => onSave({ reason, reschedule })} />
        </View>
      </View>
    </BottomSheet>
  );
}
