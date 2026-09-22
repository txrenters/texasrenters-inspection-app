import { LocateFixedIcon, RouteIcon, Volume2Icon, VolumeXIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';

import { PRESS_SURFACE } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';

import { useNavColors } from './nav-colors';

// Lucide icons take their colour from `className`; a `color` prop is
// overwritten by `cssInterop` and the glyph renders invisible — which over a
// map is indistinguishable from a button that failed to draw.
registerIcons(LocateFixedIcon, RouteIcon, Volume2Icon, VolumeXIcon);

/**
 * The three controls that live on the map itself, and the one that comes and
 * goes.
 *
 * They are circles rather than a toolbar because they float over map tiles: a
 * bar would mask a strip of the road ahead, and the three do not belong to each
 * other — muting the voice, turning the map and seeing the whole day are three
 * unrelated decisions that simply have nowhere else to be.
 *
 * ## Why every one of them is labelled
 *
 * All three are icon-only, and two of them are toggles whose *current* state is
 * the thing being conveyed. A speaker glyph with a line through it means "the
 * voice is off" to one person and "press to turn the voice off" to another, and
 * a screen reader has to be told which. The labels below say the state and the
 * hints say the action.
 */
export function MapButtons({
  muted,
  onToggleMute,
  northUp,
  onToggleOrientation,
  headingDegrees,
  overviewOpen,
  onToggleOverview,
}: {
  muted: boolean;
  onToggleMute: () => void;
  /** True when the map is held north-up; false when it turns with the van. */
  northUp: boolean;
  onToggleOrientation: () => void;
  /** Where the van is pointing, or null when it is too slow to have a course. */
  headingDegrees: number | null;
  overviewOpen: boolean;
  onToggleOverview: () => void;
}) {
  const colors = useNavColors();
  const Speaker = muted ? VolumeXIcon : Volume2Icon;

  return (
    <View style={styles.stack}>
      <MapButton
        background={colors.surface}
        hint={muted ? 'Turns spoken directions back on' : 'Turns spoken directions off'}
        label={muted ? 'Spoken directions are off' : 'Spoken directions are on'}
        onPress={onToggleMute}
        pressed={muted}
      >
        <Speaker className={muted ? 'text-muted-foreground' : 'text-foreground'} size={21} />
      </MapButton>

      <MapButton
        background={colors.surface}
        hint={northUp ? 'Turns the map with the van' : 'Holds the map north-up'}
        label={northUp ? 'Map is north-up' : 'Map turns with the van'}
        onPress={onToggleOrientation}
        pressed={!northUp}
      >
        <CompassNeedle
          headingDegrees={headingDegrees}
          northColor={colors.danger}
          northUp={northUp}
          southColor={colors.muted}
        />
      </MapButton>

      <MapButton
        background={overviewOpen ? colors.wash : colors.surface}
        hint="Shows the whole day instead of the next turn"
        label={overviewOpen ? 'Showing the whole day' : 'Show the whole day'}
        onPress={onToggleOverview}
        pressed={overviewOpen}
      >
        <RouteIcon className={overviewOpen ? 'text-primary' : 'text-foreground'} size={21} />
      </MapButton>
    </View>
  );
}

/**
 * Back to the van.
 *
 * Separate from the stack above, and shown only when the map has been dragged
 * away from the driver — it is the answer to a thing they just did, so it
 * belongs where their thumb already is rather than in a column of permanent
 * chrome. A pill rather than a circle for the same reason: it carries a word,
 * because a technician who has lost the van on a pinch-zoomed map is not in the
 * mood to decode a crosshair.
 */
export function RecentrePill({ onPress }: { onPress: () => void }) {
  const colors = useNavColors();

  return (
    <Pressable
      accessibilityLabel="Re-centre the map on the van"
      accessibilityRole="button"
      className={PRESS_SURFACE}
      onPress={onPress}
      style={[styles.recentre, { backgroundColor: colors.surface }]}
    >
      <LocateFixedIcon className="text-primary" size={17} />
      <Text style={[styles.recentreLabel, { color: colors.text }]}>Re-centre</Text>
    </Pressable>
  );
}

function MapButton({
  label,
  hint,
  onPress,
  background,
  pressed,
  children,
}: {
  label: string;
  hint: string;
  onPress: () => void;
  background: string;
  /** Reported as `selected`, so a toggle's state is announced, not guessed. */
  pressed: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: pressed }}
      className={PRESS_SURFACE}
      onPress={onPress}
      style={[styles.button, { backgroundColor: background }]}
    >
      {children}
    </Pressable>
  );
}

/**
 * A needle rather than the letter N.
 *
 * The button has two jobs — say which way the map is held, and turn it — and a
 * static compass glyph only does the second. The needle points at true north
 * wherever north currently is on screen, so in course-up it swings as the van
 * turns and in north-up it sits still pointing up. Red half north, grey half
 * south, which is the convention every physical compass in a van already uses.
 *
 * The rotation is a plain SVG transform on a value that already arrives once
 * per fix. Animating it would need a driver of its own, and a needle that lags
 * the map it describes is worse than one that steps.
 */
function CompassNeedle({
  northUp,
  headingDegrees,
  northColor,
  southColor,
}: {
  northUp: boolean;
  headingDegrees: number | null;
  northColor: string;
  southColor: string;
}) {
  // North-up: north is up, always. Course-up: the map is rotated by the
  // heading, so north appears rotated the other way. A null heading means the
  // van is too slow to have a course and `normaliseNavFix` dropped it — hold
  // the needle up rather than spinning it on GPS noise.
  const rotation = northUp || headingDegrees === null ? 0 : -headingDegrees;

  return (
    <Svg
      accessibilityElementsHidden
      height={24}
      importantForAccessibility="no-hide-descendants"
      viewBox="0 0 24 24"
      width={24}
    >
      <G transform={`rotate(${rotation}, 12, 12)`}>
        <Path d="M12 3 L16.2 13 L12 11.2 Z" fill={northColor} />
        <Path d="M12 21 L7.8 11 L12 12.8 Z" fill={southColor} />
      </G>
    </Svg>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  button: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
  },
  recentre: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
  },
  recentreLabel: { fontSize: 14, fontWeight: '700' },
});
