import { useThemeColors } from '@/src/lib/theme-colors';

/**
 * The colours navigation chrome needs, and the units it prints them in.
 *
 * ## Why these are not theme tokens
 *
 * `GuidedCaptureOverlay` is the app's documented exception to the token rule,
 * and it is one for a reason that applies here word for word: it sits on a live
 * camera feed, so what is behind it is a room rather than a surface the palette
 * controls. Navigation chrome sits on a **map** — a drawn photograph of Harris
 * County in whatever colours the tile server chose — and the same argument
 * holds. A banner tinted `--primary` would be legible over a residential street
 * and invisible over a park; a route line drawn in `--chart-2` would disappear
 * the moment it crossed water.
 *
 * So the map-facing colours are fixed values, measured against map tiles rather
 * than against a card, and they live here instead of being sprinkled through
 * eight components. Everything that sits on a real themed surface — the sheets,
 * the step list, the no-route screen — still uses tokens and classNames; these
 * appear there only for the specific accents the design names (the teal wash,
 * the ochre warning) that no token covers.
 *
 * ## Why the units live here too
 *
 * `shared/` is metric throughout, deliberately: the console is read by the
 * office and every threshold in `navigation.ts` is in metres. The phone is read
 * by a technician in Texas, so the conversion happens at the screen. Putting it
 * in the one non-component module this group owns keeps eight components from
 * each rounding feet their own way — `DayRouteSummary` and the route card
 * already disagree about whether 9.96 miles is "10 mi" or "9.96 mi", and that
 * is exactly the drift this avoids.
 */

export interface NavPalette {
  /** Behind the chrome, where a panel covers the map entirely. */
  background: string;
  /** A floating control or card over the map. */
  surface: string;
  text: string;
  muted: string;
  hairline: string;
  /** A fill quieter than `surface` — the step list's "then" divider. */
  subtleFill: string;

  /** The maneuver banner. Dark enough that white type clears AA over it. */
  banner: string;
  bannerText: string;
  /** Second-rank type inside the banner: the "then" row, the road name. */
  bannerMuted: string;

  /** Drawn under the route line so it reads over pale and dark tiles alike. */
  routeCasing: string;
  /** The part of the leg still to drive. */
  routeActive: string;
  /** The part already driven, and every node behind the technician. */
  routeDriven: string;
  /** The ring on a stop not yet reached. */
  nodeRing: string;

  /** Off route, rerouting, an address that could not be placed. */
  warning: string;
  warningWash: string;
  /** Exit, and nothing else. */
  danger: string;
  dangerWash: string;

  /** The pale teal strip: the day row, the arrival note, the arrival step. */
  wash: string;
  /** Type on `wash`. */
  washText: string;
}

/**
 * Light.
 *
 * These are the values the design was approved at. The greens are the brand's
 * own — `--primary` is `#114E45` — so the chrome still reads as this app rather
 * than as a generic navigator, even though it cannot use the token.
 *
 * `surface`, `text`, `muted` and `background` are deliberately the same values
 * as `--card`, `--foreground`, `--muted-foreground` and `--background`. That is
 * not a copy waiting to drift: it means a panel can carry a Lucide icon
 * className'd `text-foreground` next to an SVG stroked with `colors.text` and
 * show no seam, which matters because a Lucide icon **must** take its colour
 * from a class (`cssInterop` overwrites a `color` prop and the glyph renders
 * invisible) while an SVG stroke **cannot**.
 */
export const NAV_LIGHT: NavPalette = {
  background: '#F4F2ED',
  surface: '#FFFFFF',
  text: '#1A1816',
  muted: '#57514B',
  hairline: '#EDEAE4',
  subtleFill: '#FAF9F6',

  banner: '#114E45',
  bannerText: '#F7FEFC',
  bannerMuted: '#CFEDE7',

  routeCasing: '#0B5F55',
  routeActive: '#12A594',
  routeDriven: '#A8A199',
  nodeRing: '#C4BEB6',

  warning: '#92570F',
  warningWash: '#F7EBD6',
  danger: '#A81616',
  dangerWash: '#F3E2E0',

  wash: '#E7F3F0',
  washText: '#114E45',
};

/**
 * Dark.
 *
 * The design specified nine of these; the rest are derived, and the derivation
 * is stated so the next person does not have to guess whether a value was
 * chosen or inherited.
 *
 * - `warning` and `danger` are the dark theme's own `--chart-4` and
 *   `--destructive`. Carrying light mode's `#92570F` and `#A81616` across would
 *   put a dark brown and a dark red on a near-black panel, which is 2:1 at
 *   best — the palette notes in `theme.ts` document that exact failure for
 *   badges, and it is the same pairing here.
 * - The washes behind them, and the teal `wash`, are the same hues at the
 *   depth `--card` sits at, so a strip reads as a tinted surface rather than as
 *   a solid block of colour.
 * - `bannerText` and `bannerMuted` do not change. The banner is already dark in
 *   both modes, so its type does not have to move.
 */
export const NAV_DARK: NavPalette = {
  background: '#121110',
  surface: '#1E1C1A',
  text: '#F2F0EC',
  muted: '#A7A097',
  hairline: '#36332F',
  subtleFill: '#24221F',

  banner: '#0E3C35',
  bannerText: '#F7FEFC',
  bannerMuted: '#CFEDE7',

  routeCasing: '#0A3D37',
  routeActive: '#2DD4BF',
  routeDriven: '#57534E',
  nodeRing: '#57534E',

  warning: '#FBC46E',
  warningWash: '#33270F',
  danger: '#F87171',
  dangerWash: '#34201F',

  wash: '#17302C',
  washText: '#7FE3D5',
};

export function navColors(isDark: boolean): NavPalette {
  return isDark ? NAV_DARK : NAV_LIGHT;
}

/**
 * The active scheme's navigation colours.
 *
 * Goes through `useThemeColors` for the flag rather than subscribing to
 * `useColorScheme` separately, for the reason that hook's own notes give: a
 * screen that needs a colour and a screen that needs the flag should call the
 * same hook, or the two drift apart the next time either changes.
 */
export function useNavColors(): NavPalette & { isDark: boolean } {
  const { isDark } = useThemeColors();
  return { ...navColors(isDark), isDark };
}

const METRES_PER_MILE = 1609.344;
const METRES_PER_FOOT = 0.3048;

/** Below this, a distance is spoken and printed in feet. 0.1 mi. */
const FEET_BELOW_METRES = METRES_PER_MILE / 10;

/**
 * Miles, with one decimal until the number is big enough not to need it.
 *
 * "9.8 mi" and "24 mi", never "9.84 mi" — a tenth of a mile is already finer
 * than the router's own figure, and a second decimal implies a precision the
 * road network does not have.
 */
export function navMiles(meters: number): string {
  const value = Math.max(0, meters) / METRES_PER_MILE;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} mi`;
}

/**
 * How far to the next thing, in the units a Texan driver reads.
 *
 * Feet under a tenth of a mile, miles above it. The rounding gets coarser as
 * the number grows because the fix underneath it is not that good: a GPS fix is
 * five to fifteen metres out on a clear day, so "437 ft" is three digits of
 * confidence over one digit of knowledge. Nearest ten under a hundred feet
 * (where the driver is committing to the turn and the difference is real),
 * nearest fifty above it.
 */
export function navDistance(meters: number): string {
  const metres = Math.max(0, meters);
  if (metres >= FEET_BELOW_METRES) return navMiles(metres);

  const feet = metres / METRES_PER_FOOT;
  if (feet < 100) return `${Math.max(0, Math.round(feet / 10) * 10)} ft`;
  return `${Math.round(feet / 50) * 50} ft`;
}

/**
 * Minutes, or hours and minutes. Never seconds.
 *
 * Matches `DayRouteSummary.drive` deliberately — the day card and the
 * navigator are read one after the other, and a drive that says "18 min" on one
 * screen and "17 min 40 s" on the next reads as two different estimates of the
 * same thing. Floors at one minute for the same reason: "0 min" to a stop you
 * can see through the windscreen is not information.
 */
export function navDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(Math.max(0, seconds) / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;

/**
 * A bearing in words, for the screen that has no route to draw.
 *
 * Eight points, not sixteen. "Roughly west-north-west" is a direction nobody
 * can act on from a driving seat, and the whole sentence it appears in already
 * says "roughly" — the number behind it is a straight line over a road network
 * that does not go straight.
 */
export function roughBearing(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalised / 45) % 8;
  return COMPASS[index] ?? 'north';
}
