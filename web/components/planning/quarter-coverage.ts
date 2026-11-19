import {
  COVERAGE_DETAILS,
  COVERAGE_GROUPS,
  type CoverageDetail,
  type CoverageGroup,
  type QuarterCoverage,
  type QuarterCoverageProperty,
} from '@texasrenters/shared';

import { csvText } from '@/lib/csv';
import { EMPTY, formatDate, formatDay } from '@/lib/format';

/**
 * The words of the plan's Coverage tab (the office, 2026-11-20), kept apart
 * from the view so they can be read and tested on their own.
 */

export type BadgeTone = 'success' | 'info' | 'warning' | 'destructive' | 'secondary';

/** "Completed", "Scheduled, not completed" -- the office's own four. */
export function groupLabel(group: CoverageGroup, quarter: string): string {
  switch (group) {
    case 'COMPLETED':
      return 'Completed';
    case 'SCHEDULED':
      return 'Scheduled, not completed';
    case 'NOT_SCHEDULED':
      return 'Not scheduled';
    default:
      return `No ${quarter} visit`;
  }
}

/** The badge beside a property: what its visit is, in a word or two. */
export const DETAIL_BADGE: Record<CoverageDetail, { label: string; tone: BadgeTone }> = {
  IN_REVIEW: { label: 'In review', tone: 'success' },
  FINISHED: { label: 'Finished', tone: 'success' },
  PAST_DUE: { label: 'Past its day', tone: 'destructive' },
  UPCOMING: { label: 'Scheduled', tone: 'info' },
  NEEDS_PERSON: { label: 'Needs a person', tone: 'warning' },
  NO_DAY: { label: 'No day', tone: 'warning' },
  NOT_SENT: { label: 'Not booked', tone: 'warning' },
  NOT_PLANNED: { label: 'Not in the plan', tone: 'destructive' },
  EXCLUDED: { label: 'Excluded', tone: 'secondary' },
};

/** How many properties are in each group, and for each reason. */
export function coverageCounts(properties: readonly QuarterCoverageProperty[]) {
  const groups = Object.fromEntries(COVERAGE_GROUPS.map((group) => [group, 0])) as Record<CoverageGroup, number>;
  const details = Object.fromEntries(COVERAGE_DETAILS.map(({ detail }) => [detail, 0])) as Record<CoverageDetail, number>;
  for (const property of properties) {
    groups[property.group] += 1;
    details[property.detail] += 1;
  }
  return { groups, details, total: properties.length };
}

const SUMMARY_WORDS: Record<CoverageDetail, string> = {
  IN_REVIEW: 'in review',
  FINISHED: 'finished',
  PAST_DUE: 'past their day',
  UPCOMING: 'upcoming',
  NEEDS_PERSON: 'need a person',
  NO_DAY: 'with no day',
  NOT_SENT: 'never booked',
  NOT_PLANNED: 'not in the plan',
  EXCLUDED: 'excluded',
};

/** "279 in review · 60 finished": a group's reasons that have any, in the order they are listed. */
export function groupDetail(group: CoverageGroup, details: Record<CoverageDetail, number>): string | undefined {
  const parts = COVERAGE_DETAILS.filter((entry) => entry.group === group && details[entry.detail] > 0).map(
    ({ detail }) => `${details[detail].toLocaleString()} ${SUMMARY_WORDS[detail]}`,
  );
  return parts.length ? parts.join(' · ') : undefined;
}

/** What to do about a property, or what is true of it, in one line. */
export function nextStep(property: QuarterCoverageProperty): string {
  const visit = property.visit;
  switch (property.detail) {
    case 'IN_REVIEW':
      return visit?.previousLease ? 'Visited for the previous lease; waiting for the office’s review' : 'Waiting for the office’s review';
    case 'FINISHED':
      return visit?.previousLease ? 'Visited for the previous lease; report finished' : 'Report finished';
    case 'PAST_DUE':
      return visit?.bookedInJobber
        ? 'Its day has passed and nothing was submitted'
        : 'Never booked in Jobber, so the technician never saw it';
    case 'UPCOMING':
      return visit?.bookedInJobber ? 'Booked in Jobber' : 'Not booked in Jobber yet';
    case 'NEEDS_PERSON':
      return visit?.note ?? 'Something needs fixing before it can be booked';
    case 'NO_DAY':
      return visit?.previousLease
        ? 'Planned for the previous lease, with no day: give it a day for the new one'
        : 'On Jobber’s Unscheduled list: give it a day';
    case 'NOT_SENT':
      return visit?.scheduledOn
        ? 'Has a day but was never booked: publish the rest'
        : 'In the plan with no day: give it a day, then publish the rest';
    case 'EXCLUDED':
      return visit?.note ?? 'Taken out of this quarter';
    default:
      return property.firstOnReport
        ? `On the tenant report since ${formatDate(property.firstOnReport)}, after the quarter was built`
        : 'Not in this quarter’s plan';
  }
}

/** The smaller facts under a property's next step; empty when there are none. */
export function extraNotes(property: QuarterCoverageProperty): string[] {
  return [
    property.visit?.fromJobber ? 'Booked in Jobber, not by the plan' : null,
    property.previousLeaseOpen
      ? `${property.previousLeaseOpen === 1 ? 'A visit' : `${property.previousLeaseOpen} visits`} for an ended lease still waiting in Jobber: cancel ${property.previousLeaseOpen === 1 ? 'it' : 'them'}`
      : null,
    property.leases > 1 ? `${property.leases} enrolled leases` : null,
    // A visit for the property, but not for every lease it has now: a new
    // tenant, or a unit the quarter left out. Whether it needs one is the office's call.
    property.missingLeases && property.group !== 'NONE'
      ? `${property.missingLeases === 1 ? 'Its current lease has' : `${property.missingLeases} of its leases have`} no visit this quarter`
      : null,
  ].filter((note): note is string => Boolean(note));
}

/** "HVAC" or "Occupied". */
export const visitTypeLabel = (type: string | null | undefined) =>
  type === 'HVAC' ? 'HVAC' : type === 'OCCUPIED' ? 'Occupied' : type ? type.charAt(0) + type.slice(1).toLowerCase() : null;

/** "Zone 2" for a bare "2", and the zone as written otherwise. */
export const zoneLabel = (zone: string | null) => (zone ? (/^\d+$/.test(zone) ? `Zone ${zone}` : zone) : null);

/** A property whose address, city or zone holds what was typed. */
export function matchesSearch(property: QuarterCoverageProperty, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [property.address, property.city, zoneLabel(property.zone), property.visit?.technician]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Days from `today` to the quarter's last day, both YYYY-MM-DD; none once it is over. */
export function daysLeftInQuarter(today: string, year: number, quarter: number): number {
  const last = Date.UTC(year, quarter * 3, 0);
  const now = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((last - now) / 86_400_000));
}

/** The rows shown, as a spreadsheet the office can sort and send on. */
export function coverageCsv(properties: readonly QuarterCoverageProperty[], coverage: Pick<QuarterCoverage, 'quarterYear' | 'quarterNumber'>): string {
  const quarter = `Q${coverage.quarterNumber} ${coverage.quarterYear}`;
  return csvText(
    ['Group', 'Visit', 'Address', 'City', 'Zone', 'Type', 'Day', 'Technician', 'Booked in Jobber', 'Next step', 'Notes'],
    properties.map((property) => [
      groupLabel(property.group, quarter),
      DETAIL_BADGE[property.detail].label,
      property.address,
      property.city,
      zoneLabel(property.zone),
      visitTypeLabel(property.visit?.inspectionType),
      property.visit?.scheduledOn ?? null,
      property.visit?.technician ?? null,
      property.visit ? (property.visit.bookedInJobber ? 'Yes' : 'No') : null,
      nextStep(property),
      extraNotes(property).join('; ') || null,
    ]),
  );
}

/** "Fri, Nov 20", or a dash for a visit with no day. */
export const dayText = (day: string | null | undefined) => (day ? formatDay(day) : EMPTY);
