import { CameraIcon, CheckIcon, CircleIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ChoiceField } from '@/src/capture/ChecklistAnswerFields';
import { BottomSheet } from '@/src/components/BottomSheet';
import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';

registerIcons(CameraIcon, CheckIcon, CircleIcon);

const DONE = 'Done';
const NOT_DONE = 'Not done';

/**
 * One service of the job, answered where the technician is standing.
 *
 * Pest control and flea treatment are each a single answer: done, or not done
 * with the reason and whether the office should book it again. A photograph is
 * optional (the office, 2026-09-18): offered once the service is marked done,
 * never required.
 *
 * The reason is required when it was not done, because that sentence is what a
 * coordinator reads in Jobber before rebooking. The submit button on the job
 * refuses the same thing, so nothing here can be skipped by leaving the sheet.
 */
export function ServiceAnswerSheet({
  title,
  visible,
  answer,
  hasPhoto = false,
  onClose,
  onAnswer,
  onAddPhoto,
}: {
  title: string;
  visible: boolean;
  /** What was answered before, when the technician is correcting it. */
  answer?: { done: boolean; reason: string | null; reschedule: boolean };
  /** A photograph was already taken for this service. */
  hasPhoto?: boolean;
  onClose: () => void;
  onAnswer: (next: { done: boolean; reason: string | null; reschedule: boolean }) => void;
  /** Saves the answer as done, then opens the camera for the optional photograph. */
  onAddPhoto?: (next: { done: boolean; reason: string | null; reschedule: boolean }) => void;
}) {
  const theme = useThemeColors();
  const [done, setDone] = useState<boolean | null>(answer?.done ?? null);
  const [reason, setReason] = useState(answer?.reason ?? '');
  const [reschedule, setReschedule] = useState(answer?.reschedule ?? true);

  // Reopened for a different service, or to correct an answer: the sheet has to
  // show what is there rather than whatever was last typed into it.
  useEffect(() => {
    if (!visible) return;
    setDone(answer?.done ?? null);
    setReason(answer?.reason ?? '');
    setReschedule(answer?.reschedule ?? true);
  }, [visible, answer?.done, answer?.reason, answer?.reschedule]);

  const ready = done === true || (done === false && reason.trim().length > 0);

  return (
    <BottomSheet accessibilityRole="alert" className="max-h-[88%]" onClose={onClose} visible={visible}>
      <View className="gap-4">
        <View className="gap-1">
          <Text className="text-lg font-bold text-foreground">{title}</Text>
          <Text className="text-sm text-muted-foreground">
            Mark it done, or say why it was not.
          </Text>
        </View>

        <ChoiceField
          item={{ id: 'service', label: title, choices: [DONE, NOT_DONE], keywords: [] }}
          onChange={(next) => setDone(next === null ? null : next === DONE)}
          value={done === null ? null : done ? DONE : NOT_DONE}
        />

        {done === false ? (
          <View className="gap-3">
            <TextInput
              accessibilityLabel={`Why ${title} was not done`}
              className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
              multiline
              onChangeText={setReason}
              placeholder="Why it was not done"
              placeholderTextColor={theme.mutedForeground}
              value={reason}
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
          </View>
        ) : null}

        {/* Only for a service that happened: a photograph of a treatment
            nobody gave would evidence the wrong thing. */}
        {done === true && onAddPhoto ? (
          <Button
            icon={<CameraIcon size={18} className="text-foreground" />}
            label={hasPhoto ? 'Save and retake the photo' : 'Save and add a photo (optional)'}
            onPress={() => onAddPhoto({ done: true, reason: null, reschedule: false })}
            variant="secondary"
          />
        ) : null}

        <View className="flex-row gap-3">
          <Button className="flex-1" label="Cancel" onPress={onClose} variant="secondary" />
          <Button
            className="flex-1"
            disabled={!ready}
            label="Save"
            onPress={() =>
              onAnswer({
                done: done === true,
                reason: done === true ? null : reason.trim(),
                reschedule: done === false && reschedule,
              })
            }
          />
        </View>
      </View>
    </BottomSheet>
  );
}
