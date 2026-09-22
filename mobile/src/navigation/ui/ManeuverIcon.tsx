import Svg, { Circle, G, Path } from 'react-native-svg';

import { NAV_MANEUVERS, maneuverSide, type NavManeuver } from '@texasrenters/shared';

/**
 * One arrow per maneuver, drawn rather than fetched.
 *
 * ## Why these are hand-drawn paths and not an icon set
 *
 * Lucide has `CornerUpRight` and `ArrowUp` and little else that maps onto a
 * road. It has no ramp, no fork, no roundabout exit, no U-turn and no
 * sharp-versus-slight distinction — which is nine of the nineteen maneuvers in
 * `NAV_MANEUVERS`, and they are not the rare ones on a Houston day. Substituting
 * the nearest available glyph would draw a sharp left and a slight left
 * identically, and the whole point of the enum is that those are different
 * instructions.
 *
 * ## Why every left is a mirrored right
 *
 * The enum pairs off: `maneuverSide` already tells us which way a maneuver
 * turns, so only the right-hand form of each shape is drawn and the left is the
 * same path under `scale(-1, 1)`. Drawing both by hand is twice the geometry
 * and twice the chance of one of them being subtly heavier than its twin —
 * which is visible, because the two appear one after the other in the step list.
 *
 * ## The colour is a prop, not a class
 *
 * `stroke` is an SVG prop and cannot take a className — `Loader` documents the
 * same constraint. Callers pass a value from `nav-colors.ts` or
 * `theme-colors.ts`; nothing in here knows a hex literal, and none of these
 * icons is a Lucide component, so the `cssInterop` trap that renders an icon
 * invisible when it is given `color` does not apply here.
 */

/** The twelve drawings. Every left/right pair shares one. */
type ShapeName =
  | 'DEPART'
  | 'CONTINUE'
  | 'TURN'
  | 'TURN_SLIGHT'
  | 'TURN_SHARP'
  | 'UTURN'
  | 'RAMP'
  | 'MERGE'
  | 'FORK'
  | 'ROUNDABOUT'
  | 'FERRY'
  | 'ARRIVE';

interface Shape {
  /** Stroked paths, in a 24x24 box, drawn as if the maneuver turns right. */
  paths: readonly string[];
  /** Stroked rings — the roundabout island, the pin's hole. */
  rings?: readonly { cx: number; cy: number; r: number }[];
  /** Filled dots — the point a departure starts from. */
  dots?: readonly { cx: number; cy: number; r: number }[];
}

const SHAPES: Record<ShapeName, Shape> = {
  // A straight arrow rising out of a dot: you are here, and you set off that
  // way. Without the dot it is indistinguishable from CONTINUE, and the two
  // sit next to each other at the top of every step list.
  DEPART: {
    paths: ['M12 21 V8', 'M7.5 12.5 L12 8 L16.5 12.5'],
    dots: [{ cx: 12, cy: 21, r: 1.8 }],
  },
  CONTINUE: { paths: ['M12 21 V5', 'M6.5 10.5 L12 5 L17.5 10.5'] },
  TURN: { paths: ['M7 21 V12.5 C7 10 9 8.5 11.5 8.5 H16.5', 'M13.5 5 L17.5 8.5 L13.5 12'] },
  TURN_SLIGHT: { paths: ['M8 21 V14.2 L16.5 7', 'M11.4 7 H16.5 V12.1'] },
  // Past ninety degrees, so the arrow comes back down the way it came. That is
  // the whole difference from TURN, and at 19px in the step list it is the only
  // thing telling a driver they are about to double back.
  TURN_SHARP: {
    paths: ['M6.5 21 V12 C6.5 8 10.5 6 13.5 8.2 L16.8 13.5', 'M16.6 8.5 L16.8 13.5 L12.4 11.2'],
  },
  UTURN: { paths: ['M8 21 V12 A4 4 0 0 1 16 12 V16.4', 'M12.7 12.9 L16 16.4 L19.3 12.9'] },
  RAMP: { paths: ['M7 21 V15 C7 10 10.5 7 15.5 7', 'M12.5 3.8 L16 7 L12.5 10.2'] },
  // No side: `maneuverSide('MERGE')` is null, because a merge is described by
  // the road being joined rather than by a turn. The thin line is the slip road.
  MERGE: {
    paths: [
      'M14.5 21 V6.5',
      'M10.5 10.5 L14.5 6.5 L18.5 10.5',
      'M6.5 21 V16 C6.5 12.5 9.5 11.5 13 10.6',
    ],
  },
  FORK: { paths: ['M9 21 V14.5', 'M9 14.5 L4.8 9.8', 'M9 14.5 L16.2 7.6', 'M11.7 7.6 H16.2 V12.1'] },
  ROUNDABOUT: {
    paths: ['M10.5 21 V14.7', 'M14.7 10.5 H19.4', 'M16 7.4 L19.4 10.5 L16 13.6'],
    rings: [{ cx: 10.5, cy: 10.5, r: 4.2 }],
  },
  FERRY: {
    paths: ['M3.8 17.2 C6.5 20 17.5 20 20.2 17.2', 'M5.6 17 L7 12.2 H17 L18.4 17', 'M12 12.2 V7.6', 'M9 7.6 H15'],
  },
  // A pin, not a chequered flag. The flag reads as the end of a race; the pin
  // is the same mark the map draws at the stop, so the banner and the map agree
  // about what the driver is looking for.
  ARRIVE: {
    paths: ['M12 21.2 C12 21.2 18.6 14.4 18.6 10.2 A6.6 6.6 0 1 0 5.4 10.2 C5.4 14.4 12 21.2 12 21.2 Z'],
    rings: [{ cx: 12, cy: 10.2, r: 2.3 }],
  },
};

/**
 * Maneuver to drawing, written out in full rather than derived from the name.
 *
 * Stripping `_LEFT`/`_RIGHT` off the enum member would produce this table
 * exactly, and would also silently produce a missing drawing the day a member
 * is added whose name does not follow the pattern. Spelled out, the `Record`
 * fails to compile instead.
 */
const SHAPE_FOR: Record<NavManeuver, ShapeName> = {
  DEPART: 'DEPART',
  CONTINUE: 'CONTINUE',
  TURN_SLIGHT_LEFT: 'TURN_SLIGHT',
  TURN_LEFT: 'TURN',
  TURN_SHARP_LEFT: 'TURN_SHARP',
  TURN_SLIGHT_RIGHT: 'TURN_SLIGHT',
  TURN_RIGHT: 'TURN',
  TURN_SHARP_RIGHT: 'TURN_SHARP',
  UTURN_LEFT: 'UTURN',
  UTURN_RIGHT: 'UTURN',
  RAMP_LEFT: 'RAMP',
  RAMP_RIGHT: 'RAMP',
  MERGE: 'MERGE',
  FORK_LEFT: 'FORK',
  FORK_RIGHT: 'FORK',
  ROUNDABOUT_LEFT: 'ROUNDABOUT',
  ROUNDABOUT_RIGHT: 'ROUNDABOUT',
  FERRY: 'FERRY',
  ARRIVE: 'ARRIVE',
};

/**
 * Every maneuver has a drawing.
 *
 * `NAV_MANEUVERS` is exported for exactly this, and the check is a single
 * comparison at module load rather than a test in a suite this directory does
 * not have. It cannot fail while `SHAPE_FOR` is a complete `Record`; it is here
 * so that loosening that type later fails loudly rather than drawing a blank
 * box in the banner.
 */
const DRAWN = NAV_MANEUVERS.every((maneuver) => SHAPE_FOR[maneuver] in SHAPES);

export function ManeuverIcon({
  maneuver,
  size = 24,
  color,
  strokeWidth = 1.9,
  accessibilityLabel,
}: {
  maneuver: NavManeuver;
  size?: number;
  /** A real value — from `nav-colors.ts`, never a literal at the call site. */
  color: string;
  /** Scales with `size` by default; pass a value only to thin a large arrow. */
  strokeWidth?: number;
  /**
   * Only when the arrow stands alone. Every place this icon appears beside its
   * instruction it is decoration, and labelling it makes a screen reader say
   * the turn twice.
   */
  accessibilityLabel?: string;
}) {
  const shape = DRAWN ? SHAPES[SHAPE_FOR[maneuver]] : SHAPES.CONTINUE;
  const mirrored = maneuverSide(maneuver) === 'LEFT';

  return (
    <Svg
      accessibilityElementsHidden={!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      height={size}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      viewBox="0 0 24 24"
      width={size}
    >
      {/* Mirrored about the box's own centre line, so a left turn lands in the
          same place a right turn does and the step list's icon column does not
          shuffle sideways as the instructions change. */}
      <G transform={mirrored ? 'translate(24, 0) scale(-1, 1)' : undefined}>
        {shape.paths.map((d) => (
          <Path
            d={d}
            fill="none"
            key={d}
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        ))}
        {shape.rings?.map((ring) => (
          <Circle
            cx={ring.cx}
            cy={ring.cy}
            fill="none"
            key={`ring-${ring.cx}-${ring.cy}-${ring.r}`}
            r={ring.r}
            stroke={color}
            strokeWidth={strokeWidth}
          />
        ))}
        {shape.dots?.map((dot) => (
          <Circle
            cx={dot.cx}
            cy={dot.cy}
            fill={color}
            key={`dot-${dot.cx}-${dot.cy}-${dot.r}`}
            r={dot.r}
          />
        ))}
      </G>
    </Svg>
  );
}
