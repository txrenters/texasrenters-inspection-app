import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PRESS_SURFACE } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';

import { navDuration, navMiles, useNavColors } from './nav-colors';

// Registered so the chevron takes its colour from `className`. A Lucide icon
// handed a `color` prop instead draws with none at all — see `src/lib/icons.ts`.
registerIcons(ChevronDownIcon, ChevronUpIcon);

/**
 * How long is left, where it ends, and the way out.
 *
 * The counterpart to the banner: the banner carries what has to be read at
 * speed, this carries what is read at a light. Time first, because that is the
 * number a technician relays to an office or a tenant — distance and clock time
 * sit beside it at a third of the size.
 *
 * ## Why "Exit" is a pill and not a button
 *
 * Ending navigation mid-drive is not destructive — nothing is lost and it can
 * be started again — but it is also not something to hit by accident on a bumpy
 * road. A tinted pill reads as available without competing with the chevron
 * beside it, and at 44px it is still a thumb target rather than a dare.
 *
 * ## Why rerouting shows a dash rather than the old number
 *
 * The arrival time it was showing was computed against a route the technician
 * is no longer on, and leaving it up means the one moment the estimate is
 * certainly wrong is the moment it looks most authoritative. A dash with a
 * sentence under it is honest and takes the same space.
 */
export function NavHud({
  remainingSeconds,
  remainingMeters,
  arrivalLabel,
  address,
  stepsOpen,
  onToggleSteps,
  onExit,
  rerouting = false,
}: {
  remainingSeconds: number;
  remainingMeters: number;
  /** The clock time of arrival, already in the property's own day. */
  arrivalLabel: string;
  /** One line. The city and postcode belong on the arrival sheet, not here. */
  address: string;
  stepsOpen: boolean;
  onToggleSteps: () => void;
  onExit: () => void;
  rerouting?: boolean;
}) {
  const colors = useNavColors();
  const Chevron = stepsOpen ? ChevronDownIcon : ChevronUpIcon;

  return (
    <View style={[styles.hud, { backgroundColor: colors.surface }]}>
      <Pressable
        accessibilityHint="Shows every turn to this stop"
        accessibilityLabel={stepsOpen ? 'Hide the turn list' : 'Show the turn list'}
        accessibilityRole="button"
        className={PRESS_SURFACE}
        onPress={onToggleSteps}
        style={[styles.chevron, { backgroundColor: colors.wash }]}
      >
        <Chevron className="text-primary" size={22} />
      </Pressable>

      <View
        accessible
        accessibilityLabel={
          rerouting
            ? `Working out the new time to ${address}`
            : `${navDuration(remainingSeconds)} left, ${navMiles(remainingMeters)}, arriving ${arrivalLabel}, at ${address}`
        }
        style={styles.copy}
      >
        <View style={styles.headline}>
          <Text
            numberOfLines={1}
            style={[styles.minutes, { color: rerouting ? colors.muted : colors.text }]}
          >
            {/* An em dash pair, not "…" or "--": it is the same visual weight as
                the two digits it stands in for, so the row does not jump when
                the real number comes back. */}
            {rerouting ? '——' : navDuration(remainingSeconds)}
          </Text>
          <Text numberOfLines={1} style={[styles.detail, { color: colors.muted }]}>
            {rerouting
              ? 'working out the new time'
              : `${navMiles(remainingMeters)} · ${arrivalLabel}`}
          </Text>
        </View>
        <Text numberOfLines={1} style={[styles.address, { color: colors.muted }]}>
          {address}
        </Text>
      </View>

      <Pressable
        accessibilityHint="Stops navigating. The job itself is not affected."
        accessibilityLabel="Exit navigation"
        accessibilityRole="button"
        className={PRESS_SURFACE}
        onPress={onExit}
        style={[styles.exit, { backgroundColor: colors.dangerWash }]}
      >
        <Text style={[styles.exitLabel, { color: colors.danger }]}>Exit</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  chevron: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  copy: { minWidth: 0, flex: 1 },
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  minutes: { fontSize: 25, fontWeight: '700', letterSpacing: -0.4 },
  detail: { minWidth: 0, flex: 1, fontSize: 13, fontWeight: '500' },
  address: { marginTop: 1, fontSize: 13 },
  // 44 tall rather than the pill's natural height: this is the control a
  // technician reaches for one-handed while parked, and the app's own button
  // floor is 48 for the same reason.
  exit: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    paddingHorizontal: 18,
  },
  exitLabel: { fontSize: 15, fontWeight: '700' },
});
