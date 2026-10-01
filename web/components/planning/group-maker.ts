import type { LiveGroups } from '@texasrenters/shared';

import type {
  GroupMakerProperty,
  GroupTemplateDetail,
  GroupTemplateInput,
  GroupTemplateMatch,
} from '@/lib/planning-queries';

import type { GroupFile, GroupFileRow } from './group-file';
import { newGroupId, type ManualGroup, type ManualState } from './manual-grouping';

/**
 * The Group maker (2026-09-30): the manual grouping tool, over the properties
 * the database holds rather than a file, saved as a template the quarterly
 * plan is built from.
 *
 * The map and the manual grouping draw rows of a groups file, so the
 * properties are made into those rows: one per building, numbered from 2 the
 * way a spreadsheet numbers a file's first row under its header. A template
 * names buildings; these convert between the two.
 */

/** The maker's properties as the rows the map draws, and the way between rows and buildings. */
export interface MakerProperties {
  file: GroupFile;
  rows: GroupFileRow[];
  rowOf: ReadonlyMap<string, number>;
  buildingOf: ReadonlyMap<number, string>;
}

/** The columns a row carries, in the order an export writes them. */
const HEADER = ['group', 'stop', 'address', 'city', 'zip', 'unit', 'lease', 'zone', 'hvac_plan', 'latitude', 'longitude', 'geocode_source'];

/** The properties as rows, every one in no group yet. */
export function makerProperties(properties: readonly GroupMakerProperty[]): MakerProperties {
  const rows = properties.map((property, index): GroupFileRow => {
    const unit = property.units.join(', ') || null;
    const lease = property.leases.join(' · ') || null;
    const hvacPlan = [...new Set(property.hvacPlans)].join(' · ') || null;
    const geocodeSource = property.approximate ? 'zip centroid' : 'address';
    return {
      rowNumber: index + 2,
      group: '',
      stop: null,
      address: property.address,
      unit,
      city: property.city,
      zip: property.postalCode,
      lease,
      hvacPlan,
      zone: property.zone,
      latitude: property.latitude,
      longitude: property.longitude,
      geocodeSource,
      approximate: property.approximate,
      cells: {
        group: '',
        stop: '',
        address: property.address,
        city: property.city ?? '',
        zip: property.postalCode ?? '',
        unit: unit ?? '',
        lease: lease ?? '',
        zone: property.zone ?? '',
        hvac_plan: hvacPlan ?? '',
        latitude: String(property.latitude),
        longitude: String(property.longitude),
        geocode_source: geocodeSource,
      },
    };
  });
  return {
    file: { groups: [], placed: 0, ungrouped: rows, skippedRows: [], missing: [], header: HEADER },
    rows,
    rowOf: new Map(properties.map((property, index) => [property.buildingId, index + 2])),
    buildingOf: new Map(properties.map((property, index) => [index + 2, property.buildingId])),
  };
}

/** A building a template names that is no longer among the properties, and the group it was in. */
export interface MissingStop {
  buildingId: string;
  /** Its street address, from the template; null when the server sent none. */
  address: string | null;
  group: string;
}

/**
 * A saved template as groups to edit. A building it names that is no longer
 * among the properties -- its tenants left the package, or it lost its
 * position -- is left out, and listed with its group so the office is told
 * which (the office, 2026-10-01: a count alone said nothing they could act on).
 */
export function stateFromTemplate(
  template: {
    groups: (Omit<GroupTemplateDetail['groups'][number], 'id'> & { id?: string })[];
    addresses?: Readonly<Record<string, string>>;
  },
  rowOf: ReadonlyMap<string, number>,
): { state: ManualState; missing: MissingStop[] } {
  const missing: MissingStop[] = [];
  const groups = template.groups.map(
    (group): ManualGroup => ({
      // The server's id, so every browser editing it live names the same group.
      id: group.id ?? newGroupId(),
      name: group.name,
      color: group.color,
      target: group.target,
      stops: group.buildingIds.flatMap((buildingId) => {
        const row = rowOf.get(buildingId);
        if (row === undefined)
          missing.push({ buildingId, address: template.addresses?.[buildingId] ?? null, group: group.name });
        return row === undefined ? [] : [row];
      }),
    }),
  );
  return { state: { groups }, missing };
}

/** How many missing properties the warning names before "and N more". */
export const MISSING_NAMED = 8;

/** "1 Main St (Group 4)", one per missing property, the first few by name. */
export function missingStopLines(missing: readonly MissingStop[]): string[] {
  const named = missing
    .slice(0, MISSING_NAMED)
    .map((stop) => `${stop.address ?? 'A property no longer in Propertyware'} (${stop.group})`);
  const more = missing.length - named.length;
  return more > 0 ? [...named, `and ${more.toLocaleString()} more`] : named;
}

/** The groups being edited as live editing holds them: stops as building ids. */
export function liveGroupsOf(state: ManualState, buildingOf: ReadonlyMap<number, string>): LiveGroups<string> {
  return {
    groups: state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      target: group.target,
      stops: group.stops.flatMap((row) => buildingOf.get(row) ?? []),
    })),
  };
}

/** The server's groups as this browser can draw them: a property it does not draw is left out. */
export function visibleGroups(groups: LiveGroups<string>, rowOf: ReadonlyMap<string, number>): LiveGroups<string> {
  return { groups: groups.groups.map((group) => ({ ...group, stops: group.stops.filter((stop) => rowOf.has(stop)) })) };
}

/** A template's groups as live editing holds them. */
export function liveGroupsOfTemplate(template: Pick<GroupTemplateDetail, 'groups'>): LiveGroups<string> {
  return {
    groups: template.groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      target: group.target,
      stops: [...group.buildingIds],
    })),
  };
}

/** The most a group's target may say: the most stops a day can be routed with. */
const MOST_TARGET = 24;

/** The groups being edited, as a template to save. */
export function templateInput(
  state: ManualState,
  buildingOf: ReadonlyMap<number, string>,
  name: string,
  minutesPerProperty: number,
): GroupTemplateInput {
  return {
    name: name.trim(),
    minutesPerProperty,
    groups: state.groups.map((group) => ({
      name: group.name.trim() || 'Group',
      color: group.color,
      target: Math.min(MOST_TARGET, Math.max(1, Math.round(group.target))),
      buildingIds: group.stops.flatMap((row) => {
        const building = buildingOf.get(row);
        return building ? [building] : [];
      }),
    })),
  };
}

/** Two templates' contents compared, whatever their revision: unsaved changes when they differ. */
export function sameTemplate(left: GroupTemplateInput, right: GroupTemplateInput): boolean {
  const content = ({ name, minutesPerProperty, groups }: GroupTemplateInput) =>
    JSON.stringify({ name, minutesPerProperty, groups });
  return content(left) === content(right);
}

/** A groups file's grouped rows, in group order: what is sent to be matched to properties by address. */
export function rowsToMatch(file: GroupFile): { address: string; postalCode: string | null }[] {
  return file.groups.flatMap((group) => group.rows.map((row) => ({ address: row.address, postalCode: row.zip })));
}

/** What starting from a groups file made of it. */
export interface MatchedFile {
  state: ManualState;
  /** Rows now in a group. */
  matched: number;
  /** Rows no property answered to. */
  unmatched: number;
  /** Rows two properties answered to, left for the office. */
  ambiguous: number;
  /** Rows of a property an earlier row already placed: another unit of one building. */
  repeated: number;
}

/**
 * A groups file's groups over the maker's properties: each row placed at the
 * property its address matched (`matches`, in `rowsToMatch` order), in the
 * file's own order and colours. A building's other units are one property here.
 */
export function stateFromMatchedFile(
  file: GroupFile,
  matches: readonly GroupTemplateMatch[],
  rowOf: ReadonlyMap<string, number>,
): MatchedFile {
  const placed = new Set<number>();
  let at = 0;
  let unmatched = 0;
  let ambiguous = 0;
  let repeated = 0;
  const groups = file.groups.map((group): ManualGroup => {
    const stops: number[] = [];
    for (let count = 0; count < group.rows.length; count += 1) {
      const match = matches[at];
      at += 1;
      if (!match || match.buildingId === null) {
        if (match?.outcome === 'AMBIGUOUS') ambiguous += 1;
        else unmatched += 1;
      } else {
        const row = rowOf.get(match.buildingId);
        if (row === undefined) unmatched += 1;
        else if (placed.has(row)) repeated += 1;
        else {
          placed.add(row);
          stops.push(row);
        }
      }
    }
    return {
      id: newGroupId(),
      name: group.name ?? `Group ${group.key}`,
      color: group.color.fill,
      target: Math.min(MOST_TARGET, Math.max(group.size, stops.length, 1)),
      stops,
    };
  });
  return { state: { groups }, matched: placed.size, unmatched, ambiguous, repeated };
}
