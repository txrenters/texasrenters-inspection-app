import { StyleSheet, Text, View } from 'react-native';

import { useNavColors } from './nav-colors';

/** Metres per second to miles per hour. */
const MPH_PER_MS = 2.236936;

/**
 * How fast the van is going, and nothing else.
 *
 * ## There is no speed limit here, deliberately
 *
 * Every consumer navigator puts the limit beside the speed, and it is the first
 * thing anybody asks for. Nothing in this system knows it: the Routes API
 * returns `speedLimit` only under a separate licence the account does not hold,
 * and the day route carries no per-road data at all. The alternative — showing
 * a limit inferred from the road class — would be a number an employer is
 * displaying to an employee about their driving, which had better be right.
 * So it shows what the phone actually measured and leaves the rest alone.
 *
 * ## Why it can be blank
 *
 * A stationary phone reports a speed of zero, a phone with no fix reports none,
 * and `normaliseNavFix` turns the platforms' `-1` into null rather than letting
 * it read as stopped. Null draws a dash: not knowing is a different thing from
 * being parked, and at a junction the driver can see which one they are.
 */
export function SpeedPill({ speedMetersPerSecond }: { speedMetersPerSecond: number | null }) {
  const colors = useNavColors();
  const mph = speedMetersPerSecond === null ? null : Math.round(speedMetersPerSecond * MPH_PER_MS);

  return (
    <View
      accessible
      accessibilityLabel={mph === null ? 'Speed unknown' : `${mph} miles per hour`}
      style={[styles.pill, { backgroundColor: colors.surface }]}
    >
      <Text numberOfLines={1} style={[styles.value, { color: colors.text }]}>
        {mph === null ? '–' : mph}
      </Text>
      <Text style={[styles.unit, { color: colors.muted }]}>MPH</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 29,
  },
  // Tight line height and a nudge up, so the number and its unit read as one
  // stack rather than as two lines that happen to be in the same circle.
  value: { fontSize: 22, fontWeight: '700', lineHeight: 24, letterSpacing: -0.5 },
  unit: { marginTop: -1, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
});
