/**
 * A file of properties already split into groups, read for the Groups map.
 *
 * The office works groupings out in a spreadsheet as well as in the planner --
 * first 44 groups of 9, then 39 of 9 to 11 in the fastest driving order -- and
 * wanted to see one on the map a quarter is judged against. So it is drawn
 * there as the file says it: its groups however many and however large, its
 * visiting order, its positions (already geocoded, so none is looked up
 * again), and its own miles and minutes for each group.
 *
 * **Never committed, bundled or served as a static file.** It names every
 * tenant and their home address, and this repository is public. It reaches the
 * console two ways only: from the server's `data/` folder through the API,
 * behind sign-in and to the organization that plans; or chosen in the browser,
 * read there and sent nowhere, the way the office's Details sheet is.
 */

import { parseCsv } from '@/lib/planning';

import { metresBetween } from './plan-groups';

/** The columns, by the names the file uses. Found by name, so their order does not matter. */
const COLUMNS = {
  group: 'group',
  area: 'group_area',
  stop: 'stop',
  address: 'address',
  city: 'city',
  zip: 'zip',
  unit: 'unit',
  lease: 'lease',
  zone: 'zone',
  hvacPlan: 'hvac_plan',
  latitude: 'latitude',
  longitude: 'longitude',
  spanMiles: 'group_span_miles',
  routeMiles: 'group_route_miles',
  geocodeSource: 'geocode_source',
  size: 'group_size',
  driveMinutes: 'group_drive_minutes',
  longestHopMinutes: 'longest_hop_minutes',
  // Written by the manual grouping's export, so a file made by hand comes back
  // with the names and colours it was made with.
  name: 'group_name',
  colorHex: 'group_color',
} as const;

/** A drive between two stops this long or longer is called out: 15 minutes (the office, 2026-09-30). */
export const LONG_HOP_MINUTES = 15;

/** Without these there is nothing to draw. The rest only add to what a pin says. */
const REQUIRED = ['group', 'address', 'latitude', 'longitude'] as const;

export interface GroupFileRow {
  /**
   * Its row in the file, counting the header as 1 -- the number a spreadsheet
   * shows beside it. Unique, so it is the row's identity here too.
   */
  rowNumber: number;
  /** Its group as the file writes it; empty for a property in no group. */
  group: string;
  /** Its place in the group's visiting order, or null when the file gives none. */
  stop: number | null;
  address: string;
  unit: string | null;
  city: string | null;
  zip: string | null;
  lease: string | null;
  hvacPlan: string | null;
  zone: string | null;
  latitude: number;
  longitude: number;
  /** How the file placed it, in its own words: "address", "zip centroid". */
  geocodeSource: string | null;
  /** At the middle of a zip code or the like, not at the building. */
  approximate: boolean;
  /**
   * Every cell of its row by column name, exactly as written. What an export
   * writes back, so a column this reader knows nothing about still survives.
   */
  cells: Readonly<Record<string, string>>;
}

export interface GroupColor {
  /** `#rrggbb`: a form Mapbox paints as readily as CSS does. */
  fill: string;
  /** White or near-black, whichever reads better on the fill: the stop numbers. */
  ink: string;
}

export interface FileGroup {
  /** The group as the file writes it. */
  key: string;
  /** What its badge on the map says: the group as the file writes it. */
  label: string;
  /** A name given by hand, from a manual grouping's export; null in the office's files. */
  name: string | null;
  area: string | null;
  /** In visiting order. */
  rows: GroupFileRow[];
  /** How many properties the file says the group has; its rows when the file does not say. */
  size: number;
  spanMiles: number | null;
  routeMiles: number | null;
  /** Driving through every stop in order, not counting the time spent at each. */
  driveMinutes: number | null;
  /** The longest single drive between two of its stops. */
  longestHopMinutes: number | null;
  /**
   * Where a long hop is drawn -- from `rows[longHop]` to the row after it --
   * when the longest drive is `LONG_HOP_MINUTES` or more; otherwise null.
   *
   * **An estimate.** The file gives the hop's minutes but not which two stops
   * it runs between, and the positions are all there is to go on, so it is the
   * longest straight line between consecutive stops. Roads usually agree; a
   * river or a freeway with few exits can make a shorter line the longer drive.
   */
  longHop: number | null;
  color: GroupColor;
  /** The convex hull of its properties, `[longitude, latitude]`: see `groupOutline`. */
  outline: [number, number][];
  /** Where the group's number stands: its northernmost property, the top of its outline. */
  labelAt: { latitude: number; longitude: number };
}

export interface GroupFile {
  groups: FileGroup[];
  /** Rows in a group. */
  placed: number;
  /**
   * Rows with a position and no group: properties a manual grouping left
   * ungrouped. Drawn as grey dots; the office's files have none.
   */
  ungrouped: GroupFileRow[];
  /** Rows left off the map -- no position a map can use -- by their row number. */
  skippedRows: number[];
  /** Required columns the file does not have, by name. */
  missing: string[];
  /** The file's column names in its own order, lower-cased: what an export follows. */
  header: string[];
}

/** A position a map can draw. 0,0 is in the Atlantic, and is what a blank cell becomes. */
function onEarth(latitude: number | null, longitude: number | null): boolean {
  if (latitude === null || longitude === null) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  return latitude !== 0 || longitude !== 0;
}

/**
 * The file, read as it is.
 *
 * Every figure the map shows about a group -- its size, its area, its span,
 * its route, its drive -- is the file's own, not worked out here: whoever made
 * the file measured the route on real roads, and a second number beside theirs
 * would only start an argument about which is right. A group's size falls back
 * to counting its rows only when the file does not give one.
 */
export function readGroupFile(text: string): GroupFile {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([field, name]) => [field, header.indexOf(name)]),
  ) as Record<keyof typeof COLUMNS, number>;
  const missing = REQUIRED.filter((field) => at[field] < 0).map((field) => COLUMNS[field]);
  if (missing.length) return { groups: [], placed: 0, ungrouped: [], skippedRows: [], missing, header };

  const cell = (row: string[], index: number) => (index < 0 ? '' : (row[index] ?? '').trim());
  const words = (row: string[], index: number) => cell(row, index) || null;
  const number = (row: string[], index: number) => {
    const value = cell(row, index);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const byGroup = new Map<string, GroupFileRow[]>();
  const summary = new Map<string, GroupFigures>();
  const ungrouped: GroupFileRow[] = [];
  const skippedRows: number[] = [];

  table.forEach((row, index) => {
    if (index === 0 || !row.some((value) => value.trim())) return;
    const rowNumber = index + 1;
    const group = cell(row, at.group);
    const latitude = number(row, at.latitude);
    const longitude = number(row, at.longitude);
    if (!onEarth(latitude, longitude)) {
      skippedRows.push(rowNumber);
      return;
    }

    const geocodeSource = words(row, at.geocodeSource);
    const entry: GroupFileRow = {
      rowNumber,
      group,
      stop: number(row, at.stop),
      address: cell(row, at.address),
      unit: words(row, at.unit),
      city: words(row, at.city),
      zip: words(row, at.zip),
      lease: words(row, at.lease),
      hvacPlan: words(row, at.hvacPlan),
      zone: words(row, at.zone),
      latitude: latitude!,
      longitude: longitude!,
      geocodeSource,
      approximate: geocodeSource !== null && /centroid/i.test(geocodeSource),
      cells: Object.fromEntries(header.map((name, column) => [name, cell(row, column)])),
    };
    // A property in no group: left out of every group, not off the map.
    if (!group) {
      ungrouped.push(entry);
      return;
    }
    const rows = byGroup.get(group);
    if (rows) rows.push(entry);
    else byGroup.set(group, [entry]);

    // The group's figures repeat on each of its rows; the first one given is kept.
    const known = summary.get(group);
    summary.set(group, {
      name: known?.name ?? words(row, at.name),
      colorHex: known?.colorHex ?? words(row, at.colorHex),
      area: known?.area ?? words(row, at.area),
      size: known?.size ?? number(row, at.size),
      spanMiles: known?.spanMiles ?? number(row, at.spanMiles),
      routeMiles: known?.routeMiles ?? number(row, at.routeMiles),
      driveMinutes: known?.driveMinutes ?? number(row, at.driveMinutes),
      longestHopMinutes: known?.longestHopMinutes ?? number(row, at.longestHopMinutes),
    });
  });

  // "2" before "10", and a file that names its groups still sorts sensibly.
  const keys = [...byGroup.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const ordered = keys.map((key) =>
    byGroup
      .get(key)!
      .sort(
        (left, right) =>
          (left.stop ?? Number.POSITIVE_INFINITY) - (right.stop ?? Number.POSITIVE_INFINITY) ||
          left.rowNumber - right.rowNumber,
      ),
  );
  const colors = groupColors(ordered);

  const groups = keys.map((key, index): FileGroup => {
    const rows = ordered[index]!;
    const { colorHex, ...figures } = summary.get(key)!;
    const outline = groupOutline(rows);
    const top = outline.reduce((highest, point) => (point[1] > highest[1] ? point : highest));
    return {
      key,
      label: key,
      ...figures,
      size: figures.size ?? rows.length,
      longHop:
        figures.longestHopMinutes !== null && figures.longestHopMinutes >= LONG_HOP_MINUTES
          ? longestStep(rows)
          : null,
      rows,
      // A colour the file chose wins over the one worked out here.
      color: (colorHex && groupColorOf(colorHex)) || colors[index]!,
      outline,
      labelAt: { latitude: top[1], longitude: top[0] },
    };
  });

  return {
    groups,
    placed: ordered.reduce((sum, rows) => sum + rows.length, 0),
    ungrouped,
    skippedRows,
    missing,
    header,
  };
}

/** A group's own figures, as the file gives them on each of its rows. */
interface GroupFigures {
  name: string | null;
  colorHex: string | null;
  area: string | null;
  size: number | null;
  spanMiles: number | null;
  routeMiles: number | null;
  driveMinutes: number | null;
  longestHopMinutes: number | null;
}

/** The step from one stop to the next that covers the most ground: its first stop's index. */
function longestStep(rows: readonly GroupFileRow[]): number | null {
  let longest: number | null = null;
  let farthest = -1;
  for (let index = 0; index + 1 < rows.length; index += 1) {
    const metres = metresBetween(rows[index]!, rows[index + 1]!);
    if (metres > farthest) {
      farthest = metres;
      longest = index;
    }
  }
  return longest;
}

/** How the list of groups is ordered. */
export type GroupOrder = 'number' | 'drive';

/**
 * The groups in the order asked for.
 *
 * By number is the file's own order. By drive puts the longest drive first --
 * the days most worth a second look -- with any group the file gives no drive
 * for at the end, and ties left in number order.
 */
export function sortGroups(
  groups: readonly FileGroup[],
  order: GroupOrder,
  /** The drive each group is sorted by: the file's, unless a road route says otherwise. */
  driveMinutesOf: (group: FileGroup) => number | null = (group) => group.driveMinutes,
): FileGroup[] {
  if (order === 'number') return [...groups];
  return groups
    .map((group, index) => ({ group, index, drive: driveMinutesOf(group) ?? Number.NEGATIVE_INFINITY }))
    .sort((left, right) => right.drive - left.drive || left.index - right.index)
    .map(({ group }) => group);
}

/* ------------------------------------------------------------------------ */
/* Colours                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * OKLab: the space colour differences are measured in, where a step of one
 * size looks about the same size wherever it is taken. Picking in RGB or HSL
 * makes "evenly spaced" greens that nobody can tell apart and blues that jump.
 */
interface Lab {
  l: number;
  a: number;
  b: number;
}

/** OKLab to linear-light sRGB (Björn Ottosson's matrices). */
function linearRgb({ l, a, b }: Lab): [number, number, number] {
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

const inGamut = (rgb: readonly number[]) => rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);

function hex(lab: Lab): string {
  return `#${linearRgb(lab)
    .map((channel) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/** WCAG's contrast ratio between two relative luminances. */
const contrast = (one: number, other: number) => (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);

const NEAR_BLACK = '#111827';
const NEAR_BLACK_LUMINANCE = 0.0123;

/** Whichever of white or near-black reads better on a colour of this luminance. */
const inkOn = (luminance: number) =>
  contrast(luminance, 1) >= contrast(luminance, NEAR_BLACK_LUMINANCE) ? '#ffffff' : NEAR_BLACK;

/** Whichever of white or near-black reads better on this colour. */
function inkFor(lab: Lab): string {
  const [red, green, blue] = linearRgb(lab).map((channel) => Math.min(1, Math.max(0, channel)));
  return inkOn(0.2126 * red! + 0.7152 * green! + 0.0722 * blue!);
}

/** `#rrggbb` as linear-light sRGB, or null for anything that is not one. */
function linearOf(hex: string): [number, number, number] | null {
  const value = hex.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(value)) return null;
  return [1, 3, 5]
    .map((start) => parseInt(value.slice(start, start + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
}

/**
 * A group colour from `#rrggbb` -- chosen by hand, or read back from a file --
 * with the numeral that reads on it. Null for anything that is not one.
 */
export function groupColorOf(hex: string): GroupColor | null {
  const linear = linearOf(hex);
  if (!linear) return null;
  const [red, green, blue] = linear;
  return { fill: hex.trim().toLowerCase(), ink: inkOn(0.2126 * red + 0.7152 * green + 0.0722 * blue) };
}

/** `#rrggbb` in OKLab (Björn Ottosson's matrices, the other way round from `linearRgb`). */
function oklabOf(hex: string): Lab | null {
  const linear = linearOf(hex);
  if (!linear) return null;
  const [red, green, blue] = linear;
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

/**
 * A property in no group: a bright, saturated green, so what is left to group
 * stands out on the light roadmap and the dark one alike (the office,
 * 2026-09-30). Grey, as it was, disappeared into both.
 */
export const UNGROUPED_GREEN = '#16a34a';
const UNGROUPED_LAB = oklabOf(UNGROUPED_GREEN)!;

/**
 * How close to the ungrouped green is too close to tell apart on the map.
 *
 * 0.15 in OKLab. The greens the presets used to have stood 0.09 to 0.12 away;
 * with them gone the nearest preset stands 0.25 away, so the line falls in a
 * wide gap rather than splitting hairs.
 */
const NEAR_UNGROUPED = 0.15;

/** Whether a group colour could be taken for an ungrouped property. */
export function nearUngroupedGreen(hex: string): boolean {
  const lab = oklabOf(hex);
  return lab !== null && colorDistance(lab, UNGROUPED_LAB) < NEAR_UNGROUPED;
}

const colorDistance = (one: Lab, other: Lab) =>
  Math.hypot(one.l - other.l, one.a - other.a, one.b - other.b);

/**
 * Lightness bands the colours are drawn from.
 *
 * Nothing paler than 0.74: a pale yellow pin with a white rim disappears into
 * the light basemap. Nothing darker than 0.45, which would read as black on
 * the dark one. Four bands, so hue alone is not asked to carry forty-odd
 * differences.
 */
const LIGHTNESS = [0.45, 0.55, 0.65, 0.74];
/** Vivid enough to be a colour rather than a grey, and never past what a screen can show. */
const MIN_CHROMA = 0.08;
const MAX_CHROMA = 0.17;

/** The most colourful version of this lightness and hue a screen can show, up to the cap. */
function mostChroma(lightness: number, hue: number): number {
  let low = 0;
  let high = 0.4;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    const lab = { l: lightness, a: middle * Math.cos(hue), b: middle * Math.sin(hue) };
    if (inGamut(linearRgb(lab))) low = middle;
    else high = middle;
  }
  return Math.min(low, MAX_CHROMA);
}

/**
 * `count` colours, each as far as possible from all the others.
 *
 * A grid of candidates over lightness and hue, then farthest-point picking:
 * each colour taken is the candidate furthest from every colour already
 * taken. Deterministic, so the same file always draws in the same colours.
 */
export function distinctColors(count: number): Lab[] {
  const hues = Math.max(24, Math.ceil(count / 2));
  const candidates: Lab[] = [];
  for (const lightness of LIGHTNESS)
    for (let step = 0; step < hues; step += 1) {
      const hue = (step / hues) * 2 * Math.PI;
      const chroma = mostChroma(lightness, hue);
      const lab = { l: lightness, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) };
      // Never the green an ungrouped property is drawn in.
      if (chroma >= MIN_CHROMA && colorDistance(lab, UNGROUPED_LAB) >= NEAR_UNGROUPED) candidates.push(lab);
    }

  const chroma = (lab: Lab) => Math.hypot(lab.a, lab.b);
  const first = candidates.reduce((best, lab) => (chroma(lab) > chroma(best) ? lab : best));
  const chosen = [first];
  const nearest = candidates.map((lab) => colorDistance(lab, first));
  while (chosen.length < count) {
    let pick = 0;
    for (let index = 1; index < candidates.length; index += 1) if (nearest[index]! > nearest[pick]!) pick = index;
    const lab = candidates[pick]!;
    chosen.push(lab);
    candidates.forEach((candidate, index) => {
      nearest[index] = Math.min(nearest[index]!, colorDistance(candidate, lab));
    });
  }
  return chosen;
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Kilometres between the nearest two properties of two groups: how close the groups come. */
function closestApproachKm(one: readonly Point[], other: readonly Point[]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (const a of one) for (const b of other) closest = Math.min(closest, metresBetween(a, b) / 1000);
  return closest;
}

/**
 * How much two groups' colours matter to each other, from how close they come.
 *
 * Groups that touch count fully and it falls away over a few kilometres; past
 * 25km nobody compares them on the map at all.
 */
const closeness = (km: number) => (km > 25 ? 0 : 1 / (1 + (km / 3) ** 2));

/** Colour distance neighbours should be kept apart by. Past it, further apart buys nothing. */
const TARGET_DISTANCE = 0.3;
const shortfall = (distance: number) => Math.max(0, TARGET_DISTANCE - distance) ** 2;

/**
 * One distinct colour per group, with neighbouring groups kept furthest apart.
 *
 * Forty-odd colours cannot all be far from each other -- some two will be
 * close. The point is that those two are never groups that sit side by side.
 * Each group is given, in turn from the most crowded, the unused colour least
 * like its neighbours'; then any two groups swap colours while that makes
 * the neighbours differ more.
 */
export function groupColors(groups: readonly (readonly Point[])[]): GroupColor[] {
  const palette = distinctColors(groups.length);
  const neighbours = groups.map(() => [] as { other: number; weight: number }[]);
  for (let one = 0; one < groups.length; one += 1)
    for (let other = one + 1; other < groups.length; other += 1) {
      const weight = closeness(closestApproachKm(groups[one]!, groups[other]!));
      if (!weight) continue;
      neighbours[one]!.push({ other, weight });
      neighbours[other]!.push({ other: one, weight });
    }

  const colorOf: number[] = groups.map(() => -1);
  /** How badly colour `color` sits beside group `group`'s coloured neighbours, one of them excepted. */
  const cost = (group: number, color: number, except = -1) =>
    neighbours[group]!.reduce(
      (sum, { other, weight }) =>
        other === except || colorOf[other]! < 0
          ? sum
          : sum + weight * shortfall(colorDistance(palette[color]!, palette[colorOf[other]!]!)),
      0,
    );

  const crowded = groups
    .map((_, index) => index)
    .sort(
      (left, right) =>
        neighbours[right]!.reduce((sum, { weight }) => sum + weight, 0) -
          neighbours[left]!.reduce((sum, { weight }) => sum + weight, 0) || left - right,
    );
  const unused = new Set(palette.map((_, index) => index));
  for (const group of crowded) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const color of unused) {
      const value = cost(group, color);
      if (value < bestCost - 1e-12) {
        best = color;
        bestCost = value;
      }
    }
    colorOf[group] = best;
    unused.delete(best);
  }

  for (let pass = 0; pass < 20; pass += 1) {
    let improved = false;
    for (let one = 0; one < groups.length; one += 1)
      for (let other = one + 1; other < groups.length; other += 1) {
        const [mine, theirs] = [colorOf[one]!, colorOf[other]!];
        const before = cost(one, mine, other) + cost(other, theirs, one);
        const after = cost(one, theirs, other) + cost(other, mine, one);
        if (after < before - 1e-9) {
          colorOf[one] = theirs;
          colorOf[other] = mine;
          improved = true;
        }
      }
    if (!improved) break;
  }

  return colorOf.map((index) => ({ fill: hex(palette[index]!), ink: inkFor(palette[index]!) }));
}

/* ------------------------------------------------------------------------ */
/* Shapes                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * A group's outline: the convex hull of its properties, and nothing more.
 *
 * Drawn through the outermost properties themselves, not padded around them
 * (the office, 2026-09-30). The groups do not overlap -- no group's outline
 * holds another group's property -- and a padded outline swells into its
 * neighbours and hides exactly that. The outermost pins sit on the corners.
 *
 * A ring of `[longitude, latitude]`: closed when the group has an inside; the
 * two ends of a line when its properties all stand in a row; a single point
 * when they are all at one spot. The map draws each as what it is.
 */
export function groupOutline(points: readonly Point[]): [number, number][] {
  // Hulled flat, with longitude shrunk to its true width at this latitude:
  // left as degrees, the east-west edges would be judged ~15% too far out.
  const scale = Math.cos(((points[0]?.latitude ?? 0) * Math.PI) / 180);
  // Three units at one address are one corner, not three.
  const unique = new Map(points.map((point) => [`${point.longitude},${point.latitude}`, point]));
  const hull = convexHull([...unique.values()].map((point) => ({ x: point.longitude * scale, y: point.latitude, point })));
  const ring = hull.map(({ point }) => [point.longitude, point.latitude] as [number, number]);
  return ring.length >= 3 ? [...ring, ring[0]!] : ring;
}

/** Andrew's monotone chain. Counter-clockwise, without the first point repeated. */
function convexHull<T extends { x: number; y: number }>(points: readonly T[]): T[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length < 3) return sorted;
  const turn = (origin: T, a: T, b: T) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const half = (ordered: readonly T[]) => {
    const chain: T[] = [];
    for (const point of ordered) {
      while (chain.length >= 2 && turn(chain[chain.length - 2]!, chain[chain.length - 1]!, point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** The centre-to-centre gap, in pixels, between pins fanned out from one spot. A pin is 22px across. */
const FAN_GAP_PX = 24;

/**
 * Screen offsets for rows that share one spot, so each has a pin of its own.
 *
 * Three units at one address are three rows at identical coordinates, and so
 * are two properties the file could only place at their zip code's centre.
 * Drawn where they are, the last one covers the rest at every zoom and the
 * others cannot be clicked. Fanned out in pixels rather than moved in metres,
 * because a move in metres closes up again as the map zooms out.
 *
 * Keyed by row number. A row alone at its spot has no entry.
 */
export function fanOffsets(rows: readonly GroupFileRow[]): Map<number, [number, number]> {
  const bySpot = new Map<string, GroupFileRow[]>();
  for (const row of rows) {
    // Five decimals is about a metre: the same spot, not merely a near one.
    const spot = `${row.latitude.toFixed(5)},${row.longitude.toFixed(5)}`;
    const here = bySpot.get(spot);
    if (here) here.push(row);
    else bySpot.set(spot, [row]);
  }

  const offsets = new Map<number, [number, number]>();
  for (const here of bySpot.values()) {
    if (here.length < 2) continue;
    // The radius at which neighbouring pins on the ring are FAN_GAP_PX apart.
    const radius = FAN_GAP_PX / (2 * Math.sin(Math.PI / here.length));
    here.forEach((row, index) => {
      // From twelve o'clock, clockwise.
      const angle = -Math.PI / 2 + (index / here.length) * 2 * Math.PI;
      offsets.set(row.rowNumber, [Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))]);
    });
  }
  return offsets;
}
