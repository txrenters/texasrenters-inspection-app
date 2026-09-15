import { Text, TextInput, View } from 'react-native';

import { useThemeColors } from '../lib/theme-colors';
import type { ClosingComments } from '../utils/closing-comments';

/** The report's closing block, in the order it prints it. */
const FIELDS: { key: keyof ClosingComments; label: string; placeholder: string }[] = [
  { key: 'nextInspectionAlert', label: 'Next inspection alert', placeholder: 'Filter 2 due for a change next visit…' },
  { key: 'maintenanceComments', label: 'Maintenance comments', placeholder: 'Coil guard bent on the north side…' },
  { key: 'generalComments', label: 'General comments', placeholder: 'Tenant says the upstairs runs warm…' },
];

/**
 * The closing comments of an HVAC inspection, on the final review.
 *
 * Optional, and said to be: the office can edit them after submission, so a
 * technician with nothing to add is not stopped at the last screen.
 */
export function ClosingCommentsCard({
  draft,
  onChange,
  className,
}: {
  draft: ClosingComments;
  onChange: (next: ClosingComments) => void;
  className?: string;
}) {
  const theme = useThemeColors();
  return (
    <View className={`rounded-2xl bg-card p-5 ${className ?? ''}`}>
      <Text className="text-base font-semibold text-foreground">Closing comments</Text>
      <Text className="mt-1 text-xs leading-5 text-muted-foreground">
        The end of the HVAC report. Optional — the office can edit them after you submit.
      </Text>
      {FIELDS.map((field) => (
        <View className="mt-4" key={field.key}>
          <Text
            className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            nativeID={`closing-${field.key}`}
          >
            {field.label}
          </Text>
          <TextInput
            accessibilityLabel={`${field.label}, optional`}
            accessibilityLabelledBy={`closing-${field.key}`}
            className="min-h-20 rounded-xl border border-border bg-background px-4 py-3 text-foreground"
            multiline
            onChangeText={(text) => onChange({ ...draft, [field.key]: text })}
            placeholder={field.placeholder}
            placeholderTextColor={theme.mutedForeground}
            textAlignVertical="top"
            value={draft[field.key]}
          />
        </View>
      ))}
    </View>
  );
}
