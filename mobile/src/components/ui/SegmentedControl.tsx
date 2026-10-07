import * as Haptics from 'expo-haptics';
import { Platform, Pressable, Text, View } from 'react-native';

/**
 * Two or three equal choices side by side, one always chosen: the platform's
 * own segmented control, drawn with the app's tokens.
 *
 * A pill track with the chosen segment raised on a card surface, as iOS draws
 * it, and the light selection tick iOS plays when one lands. Each segment is a
 * radio to a screen reader, because that is what it is.
 */
export function SegmentedControl<Value extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      className="mx-5 flex-row rounded-xl bg-muted p-1"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            className={`min-h-9 flex-1 items-center justify-center rounded-lg ${selected ? 'bg-card' : ''}`}
            key={option.value}
            onPress={() => {
              if (selected) return;
              if (Platform.OS === 'ios') void Haptics.selectionAsync().catch(() => undefined);
              onChange(option.value);
            }}
          >
            <Text
              className={`text-sm font-semibold ${selected ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
