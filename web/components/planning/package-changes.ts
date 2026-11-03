import type {
  GroupSuggestion,
  GroupTemplateChanges,
  GroupTemplateOp,
  PackageChangeGroup,
  PackageLeftReason,
  PackageNewcomer,
} from '@texasrenters/shared';

import { formatDate } from '@/lib/format';

/**
 * The words for what changed in the benefit package under a template (the
 * office, 2026-10-15): who left and why, who is new and where they would fit.
 */

/** One reason a property left the package, as the office would say it. */
export function leftReasonText(reason: PackageLeftReason): string {
  const when = reason.since ? ` on ${formatDate(reason.since)}` : '';
  const who = reason.by ? ` by ${reason.by}` : '';
  switch (reason.code) {
    case 'MANAGEMENT_ENDED':
      return `Owner ended the management${when}${who}`;
    case 'OPTED_OUT':
      return `Opted out of the benefit package${when}${who}`;
    case 'NOT_ENROLLED': {
      // The report's own change carries no date; the package's history does, since 2026-10-15.
      const since = reason.since ? ` since ${formatDate(reason.since)}` : '';
      return reason.detail
        ? `Not enrolled on the tenant report${since}: it says ${reason.detail}`
        : `Not enrolled on the tenant report${since}`;
    }
    case 'ZONE_EXCLUDED':
      return `${reason.detail ?? 'Its zone'} is not part of the benefit package`;
    case 'NO_ACTIVE_LEASE':
      return reason.since
        ? `No lease on the tenant report since ${formatDate(reason.since)}`
        : 'No lease on the tenant report';
  }
}

/**
 * When a newcomer came into the package: the day it joined, where the history
 * saw it, or else how long it has been on the tenant report.
 */
export function newcomerSince(newcomer: Pick<PackageNewcomer, 'joinedAt' | 'firstOnReport'>): string | null {
  if (newcomer.joinedAt) return `joined the package on ${formatDate(newcomer.joinedAt)}`;
  return newcomer.firstOnReport ? `on the tenant report since ${formatDate(newcomer.firstOnReport)}` : null;
}

/** "3 left the package · 5 new, not in a group", or null when nothing changed. */
export function changesSummary(changes: Pick<GroupTemplateChanges, 'leavers' | 'newcomers' | 'unplaced'>): string | null {
  const parts = [
    changes.leavers.length ? `${changes.leavers.length.toLocaleString()} left the package` : null,
    changes.newcomers.length ? `${changes.newcomers.length.toLocaleString()} new, not in a group` : null,
    changes.unplaced.length
      ? `${changes.unplaced.length.toLocaleString()} in a group with no position on the map`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : null;
}

/** "+4 min", the driving a suggestion adds; "+0 min" reads as what it is, on the way. */
export const addedText = (suggestion: Pick<GroupSuggestion, 'addedMinutes'>) => `+${suggestion.addedMinutes} min`;

/** "8 of 10", or "full" when the group is at its target. */
export const roomText = (suggestion: Pick<GroupSuggestion, 'members' | 'target' | 'hasRoom'>) =>
  suggestion.hasRoom ? `${suggestion.members} of ${suggestion.target}` : 'full';

/** What hovering a suggestion explains: what it adds, how it was timed, its nearest property, its room. */
export function suggestionTitle(suggestion: GroupSuggestion): string {
  const timed = suggestion.timing === 'ROAD' ? 'by road' : 'estimated in a straight line; no road time was available';
  const nearest = suggestion.nearest
    ? ` Nearest in it: ${suggestion.nearest.address}, ${suggestion.nearest.minutes} min away.`
    : '';
  const room = suggestion.hasRoom
    ? ` It has ${suggestion.members} of the ${suggestion.target} properties it is meant to hold.`
    : ` It already has ${suggestion.members} of the ${suggestion.target} it is meant to hold; adding makes it longer than planned.`;
  return `Adds about ${suggestion.addedMinutes} min of driving to ${suggestion.group.name} (${timed}).${nearest}${room}`;
}

/**
 * Template members taken out of their group since the package changes were
 * read, and groups deleted since: what the one read no longer describes.
 */
export interface RemovedSince {
  stops: ReadonlySet<string>;
  groups: ReadonlySet<string>;
}

export const NOTHING_REMOVED: RemovedSince = { stops: new Set(), groups: new Set() };

/**
 * `was`, with what `ops` took out -- by this person or anyone else. The same
 * object when they took out nothing, so nothing redraws for a reorder.
 */
export function removedBy(was: RemovedSince, ops: readonly GroupTemplateOp<string>[]): RemovedSince {
  let stops: Set<string> | null = null;
  let groups: Set<string> | null = null;
  for (const op of ops) {
    if (op.type === 'stop.remove') (stops ??= new Set(was.stops)).add(op.stop);
    else if (op.type === 'stop.add' && (stops ?? was.stops).has(op.stop)) (stops ??= new Set(was.stops)).delete(op.stop);
    else if (op.type === 'group.delete') (groups ??= new Set(was.groups)).add(op.groupId);
  }
  return stops || groups ? { stops: stops ?? was.stops, groups: groups ?? was.groups } : was;
}

/**
 * The package changes read when the template opened, as they stand now.
 *
 * Read once rather than after every edit (the Mapbox invoice for October
 * 2026): every read times the newcomers' suggestions on the road, which Mapbox
 * bills, and re-reading after each click on the map is what ran it up. So what
 * the office does since is applied here instead. A newcomer now in a group is
 * no longer new; a leaver taken out, or whose group was deleted, is no longer
 * in it; a suggested group that was deleted is no longer offered. The drive
 * times and room counts stay as read, until Refresh.
 */
export function changesSince(
  changes: GroupTemplateChanges,
  grouped: ReadonlySet<string>,
  removed: RemovedSince,
): GroupTemplateChanges {
  const stillIn = (member: { buildingId: string; group: PackageChangeGroup }) =>
    !removed.stops.has(member.buildingId) && !removed.groups.has(member.group.id);
  return {
    ...changes,
    newcomers: changes.newcomers
      .filter((newcomer) => !grouped.has(newcomer.buildingId))
      .map((newcomer) =>
        newcomer.suggestions.some((suggestion) => removed.groups.has(suggestion.group.id))
          ? { ...newcomer, suggestions: newcomer.suggestions.filter((suggestion) => !removed.groups.has(suggestion.group.id)) }
          : newcomer,
      ),
    leavers: changes.leavers.filter(stillIn),
    unplaced: changes.unplaced.filter(stillIn),
  };
}
