import { CheckIcon, CircleIcon } from 'lucide-react-native';
import { Pressable, Text, TextInput, View } from 'react-native';

import { ChoiceField } from '@/src/capture/ChecklistAnswerFields';
import { Card } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import {
  UNANSWERED,
  type ServiceAnswer,
  type ServicesDraft,
  type ServicesToReport,
} from '@/src/utils/services-report';

registerIcons(CheckIcon, CircleIcon);

const DONE = 'Done';
const NOT_DONE = 'Not done';

/**
 * The services the Jobber visit booked, marked before the inspection is submitted.
 *
 * The office used to ask technicians to type "1, 2" into Jobber's notes after
 * the visit. Now each service is marked here: done, or not done with the reason
 * and whether it needs booking again. Submission waits until every one is
 * answered -- see `draftProblems` -- and the answers go to Jobber as a note.
 */
export function ServicesDoneCard({
  ask,
  draft,
  onChange,
  className = '',
}: {
  ask: ServicesToReport;
  draft: ServicesDraft;
  onChange: (next: ServicesDraft) => void;
  className?: string;
}) {
  const theme = useThemeColors();
  if (!ask.services.length) return null;

  const setAnswer = (key: keyof ServicesDraft['services'], next: ServiceAnswer) =>
    onChange({ ...draft, services: { ...draft.services, [key]: next } });
  const toggleSize = (size: string) =>
    onChange({
      ...draft,
      sizesNotInstalled: draft.sizesNotInstalled.includes(size)
        ? draft.sizesNotInstalled.filter((each) => each !== size)
        : [...draft.sizesNotInstalled, size],
    });

  return (
    <Card className={`gap-5 ${className}`}>
      <View className="gap-1">
        <Text className="text-base font-semibold text-foreground">Services</Text>
        <Text className="text-sm text-muted-foreground">
          Mark each service on this visit before you submit.
        </Text>
      </View>

      {ask.services.map(({ key, label }) => {
        const current = draft.services[key] ?? UNANSWERED;
        return (
          <View key={key} className="gap-1">
            <Text className="text-sm font-semibold text-foreground">{label}</Text>
            <ChoiceField
              item={{ id: key, label, choices: [DONE, NOT_DONE], keywords: [] }}
              value={current.done === null ? null : current.done ? DONE : NOT_DONE}
              onChange={(next) => setAnswer(key, { ...current, done: next === null ? null : next === DONE })}
            />
            {current.done === false ? (
              <View className="mt-2 gap-2">
                <TextInput
                  accessibilityLabel={`Why ${label} was not done`}
                  className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
                  multiline
                  onChangeText={(text) => setAnswer(key, { ...current, reason: text })}
                  placeholder="Why it was not done"
                  placeholderTextColor={theme.mutedForeground}
                  value={current.reason}
                />
                <CheckRow
                  checked={current.reschedule}
                  label="Reschedule this service"
                  onPress={() => setAnswer(key, { ...current, reschedule: !current.reschedule })}
                />
              </View>
            ) : null}
            {key === 'filterChange' && current.done === true ? (
              <View className="mt-2 gap-2">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Filters installed
                </Text>
                {ask.bookedSizes.map((size) => (
                  <CheckRow
                    key={size}
                    checked={!draft.sizesNotInstalled.includes(size)}
                    label={size}
                    onPress={() => toggleSize(size)}
                  />
                ))}
                <TextInput
                  accessibilityLabel="Other filter sizes installed"
                  autoCapitalize="none"
                  className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
                  onChangeText={(text) => onChange({ ...draft, otherSizes: text })}
                  placeholder="Other sizes installed, like 16x25x1"
                  placeholderTextColor={theme.mutedForeground}
                  value={draft.otherSizes}
                />
              </View>
            ) : null}
          </View>
        );
      })}

      <TextInput
        accessibilityLabel="Notes for the office"
        className="min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
        multiline
        onChangeText={(text) => onChange({ ...draft, notes: text })}
        placeholder="Anything else for the office (optional)"
        placeholderTextColor={theme.mutedForeground}
        value={draft.notes}
      />
    </Card>
  );
}

/** A checkbox row, drawn the way the area checklist draws a covered item. */
function CheckRow({ checked, label, onPress }: { checked: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      className={`min-h-12 flex-row items-center gap-3 rounded-xl border px-3 active:opacity-60 ${
        checked ? 'border-chart-3/40 bg-chart-3/10' : 'border-border bg-card'
      }`}
      onPress={onPress}
    >
      {checked ? (
        <CheckIcon size={18} className="text-chart-3" />
      ) : (
        <CircleIcon size={18} className="text-muted-foreground" />
      )}
      <Text className={`min-w-0 flex-1 text-sm text-foreground ${checked ? 'font-semibold' : ''}`}>{label}</Text>
    </Pressable>
  );
}
