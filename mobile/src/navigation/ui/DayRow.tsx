import { ChevronRightIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { PRESS_SURFACE } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';

import { useNavColors } from './nav-colors';

registerIcons(ChevronRightIcon);

/**
 * The day, reduced to one strip above the HUD.
 *
 * ## It counts the day, not the drive
 *
 * Everything else on this screen is about the leg being driven. This is the one
 * line that is not, and that is the whole reason it exists: a technician who
 * only ever sees the current stop has no way of knowing whether they are ahead
 * or behind until the afternoon. "Then 3 more stops · finish 3:41 PM" is the
 * answer to the question they would otherwise stop driving to work out.
 *
 * The finish time is the day's, not this leg's arrival — those two are within a
 * few minutes of each other at the last stop and hours apart at the first,
 * which is exactly when the difference matters.
 */
export function DayRow({
  position,
  total,
  finishLabel,
  onPress,
}: {
  /** 1-based, the stop being driven to. */
  position: number;
  total: number;
  /** When the last job of the day is expected to end — "3:41 PM". */
  finishLabel: string;
  onPress: () => void;
}) {
  const colors = useNavColors();
  const remaining = Math.max(0, total - position);

  const copy =
    remaining === 0
      ? `Last stop of the day · finish ${finishLabel}`
      : `Then ${remaining} more ${remaining === 1 ? 'stop' : 'stops'} · finish ${finishLabel}`;

  return (
    <Pressable
      accessibilityHint="Opens the rest of the day"
      accessibilityLabel={copy}
      accessibilityRole="button"
      className={PRESS_SURFACE}
      onPress={onPress}
      style={[styles.row, { backgroundColor: colors.wash }]}
    >
      <DayGlyph
        activeColor={colors.washText}
        doneColor={colors.routeDriven}
        position={position}
        total={total}
      />
      <Text numberOfLines={1} style={[styles.copy, { color: colors.washText }]}>
        {copy}
      </Text>
      <ChevronRightIcon className="text-primary" size={18} />
    </Pressable>
  );
}

/**
 * A five-dot stand-in for the rail, at the size a row can carry.
 *
 * `ChainRail` cannot be shrunk to fit here — its radii and its 9px labels are
 * fixed, and scaling the whole SVG down would take the type with it. Five dots
 * is enough to say "some behind, one now, some ahead" without pretending to be
 * the rail; pressing the row opens the real one.
 */
function DayGlyph({
  position,
  total,
  doneColor,
  activeColor,
}: {
  position: number;
  total: number;
  doneColor: string;
  activeColor: string;
}) {
  const shown = Math.min(5, Math.max(1, total));
  // Which of the five dots is "now", kept proportional so a nine-stop day puts
  // the fifth stop in the middle rather than at the end.
  const active = total <= 1 ? 0 : Math.round(((position - 1) / (total - 1)) * (shown - 1));
  const width = 8 + (shown - 1) * 11;

  return (
    <Svg accessibilityElementsHidden height={14} importantForAccessibility="no-hide-descendants" width={width}>
      <Line
        stroke={doneColor}
        strokeLinecap="round"
        strokeWidth={1.6}
        x1={4}
        x2={width - 4}
        y1={7}
        y2={7}
      />
      {Array.from({ length: shown }, (_, index) => (
        <Circle
          cx={4 + index * 11}
          cy={7}
          fill={index === active ? activeColor : doneColor}
          key={index}
          r={index === active ? 4 : 2.6}
        />
      ))}
    </Svg>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  copy: { minWidth: 0, flex: 1, fontSize: 13, fontWeight: '600' },
});
