import { estimatedDriveMinutes, type DriveEstimate } from './quarter-assignment.js';

/**
 * What changed in the benefit package under a group template (the office,
 * 2026-10-15): "we should have a way to know if a property has opted out or
 * left the TBP ... where was that, what group", and for a property that joined,
 * "a suggestion where or what group we can let it grouped based on the driving
 * time".
 *
 * A template names buildings. A building that left the package stays a member
 * -- nothing takes it out but the office -- and the Group maker draws only the
 * properties still in the package, so a leaver used to vanish from the map with
 * a passing warning, and a newcomer sat green in no group with nothing saying
 * where it would fit.
 */

/** Why a member of a template is no longer in the benefit package. */
export type PackageLeftReasonCode =
  /** "Owner ended the management" switched on, on the property's page. */
  | 'MANAGEMENT_ENDED'
  /** "Opted out of the benefit package" switched on, on the property's page. */
  | 'OPTED_OUT'
  /** Propertyware's tenant report no longer says Yes for any of its tenancies. */
  | 'NOT_ENROLLED'
  /** Its tenancies are in a zone the package does not cover (zone 5). */
  | 'ZONE_EXCLUDED'
  /** No tenancy of it is on the tenant report any more: the lease ended or left Propertyware. */
  | 'NO_ACTIVE_LEASE';

export interface PackageLeftReason {
  code: PackageLeftReasonCode;
  /** When it happened, where that is recorded; null when nothing says. ISO timestamp. */
  since: string | null;
  /** Who did it, for the office's own switches. */
  by: string | null;
  /** What the report says instead, for NOT_ENROLLED ("No", "Not Verified"). */
  detail: string | null;
}

/** A template group, as the changes name it. */
export interface PackageChangeGroup {
  id: string;
  /** 1-based, as the Group maker numbers its groups. */
  position: number;
  name: string;
  color: string;
}

/** A member of the template that is no longer in the benefit package, and the group it is still in. */
export interface PackageLeaver {
  buildingId: string;
  address: string;
  group: PackageChangeGroup;
  /** Most telling first: the office's switches, then what Propertyware says. */
  reasons: PackageLeftReason[];
}

/** A member still in the package that the map cannot draw: it has no position yet. */
export interface PackageUnplaced {
  buildingId: string;
  address: string;
  group: PackageChangeGroup;
}

/** A group a newcomer would fit, and what it would cost. */
export interface GroupSuggestion {
  group: PackageChangeGroup;
  /** Properties in the group that are still in the package. */
  members: number;
  /** How many properties the office meant the group to hold. */
  target: number;
  /** Below its target and below the most a day can be routed with. */
  hasRoom: boolean;
  /**
   * Minutes the group's drive grows by with the property put where it adds
   * least, as a quarter built from the template would put it. Whole minutes.
   */
  addedMinutes: number;
  /** Timed on the road, or estimated in a straight line when no router answered. */
  timing: 'ROAD' | 'ESTIMATE';
  /** The group's property nearest to it, and the drive from it in minutes. */
  nearest: { address: string; minutes: number } | null;
}

/** A property in the benefit package that is in no group of the template. */
export interface PackageNewcomer {
  buildingId: string;
  address: string;
  city: string | null;
  zone: string | null;
  /** The first time any of its enrolled tenancies was on the tenant report. ISO timestamp. */
  firstOnReport: string | null;
  /** Nearest first, by the driving each would add. */
  suggestions: GroupSuggestion[];
}

export interface GroupTemplateChanges {
  templateId: string;
  /** The template's revision these were worked out from. */
  revision: number;
  leavers: PackageLeaver[];
  unplaced: PackageUnplaced[];
  newcomers: PackageNewcomer[];
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Where a property goes in a group's drive, and what it adds. */
export interface GroupInsertion {
  groupId: string;
  /** Its place in the group's order: 0 first, the group's length last. */
  at: number;
  /** Minutes the drive grows by. */
  addedMinutes: number;
  /** The group's member nearest to it by the same drive, by index, and the drive in minutes. */
  nearest: { index: number; minutes: number } | null;
}

/**
 * Where a property adds least to a group's drive, and how much: an open path,
 * so either end counts -- nobody drives back to the first. The same arithmetic
 * a quarter built from the template uses to place a property the template does
 * not name (`cheapestInsertion` in quarter-assignment), so a suggestion here is
 * where a build would put it.
 */
export function insertionInto(
  point: Point,
  path: readonly Point[],
  drive: DriveEstimate = estimatedDriveMinutes,
): { at: number; addedMinutes: number } {
  if (!path.length) return { at: 0, addedMinutes: 0 };
  let at = 0;
  let addedMinutes = drive(point, path[0]!);
  const atEnd = drive(path[path.length - 1]!, point);
  if (atEnd < addedMinutes) {
    addedMinutes = atEnd;
    at = path.length;
  }
  for (let index = 1; index < path.length; index += 1) {
    const between = drive(path[index - 1]!, point) + drive(point, path[index]!) - drive(path[index - 1]!, path[index]!);
    if (between < addedMinutes) {
      addedMinutes = between;
      at = index;
    }
  }
  return { at, addedMinutes };
}

/** The members either side of a place in a group's order: none before the first, none after the last. */
export function insertionNeighbours(at: number, length: number): { before: number | null; after: number | null } {
  return { before: at > 0 ? at - 1 : null, after: at < length ? at : null };
}

/**
 * The groups a property would fit best, nearest first: each group it adds the
 * least driving to, `limit` of them. An empty group is never offered -- it has
 * nowhere to measure from. Ties go to the group with the nearer member.
 */
export function nearestGroups(
  point: Point,
  groups: readonly { id: string; points: readonly Point[] }[],
  { limit = 3, drive = estimatedDriveMinutes }: { limit?: number; drive?: DriveEstimate } = {},
): GroupInsertion[] {
  const ranked: GroupInsertion[] = [];
  for (const group of groups) {
    if (!group.points.length) continue;
    const { at, addedMinutes } = insertionInto(point, group.points, drive);
    let nearest: GroupInsertion['nearest'] = null;
    group.points.forEach((member, index) => {
      const minutes = drive(member, point);
      if (!nearest || minutes < nearest.minutes) nearest = { index, minutes };
    });
    ranked.push({ groupId: group.id, at, addedMinutes, nearest });
  }
  ranked.sort(
    (left, right) =>
      left.addedMinutes - right.addedMinutes ||
      (left.nearest?.minutes ?? Infinity) - (right.nearest?.minutes ?? Infinity),
  );
  return ranked.slice(0, Math.max(0, limit));
}
