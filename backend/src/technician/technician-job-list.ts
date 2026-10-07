import { InspectionStatus, InspectionType, type Prisma } from '@prisma/client';

import { searchTerms } from '../common/search-terms';

/**
 * How the phone's Jobs list narrows, orders and searches. Apart from the
 * service so each rule is testable as the query it builds.
 *
 * The list became a day at a time on 2026-10-07 (the office: "a calendar
 * filter... we will only show the day's schedule, not all the schedules"), with
 * a History of finished work beside it and one search across every job.
 */

/** A Texas day as the phone sends it. */
export const JOB_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `scheduledAt` a day stands for.
 *
 * `scheduledAt` is a `@db.Date`, so a day is an equality on its midnight UTC --
 * never a pair of instants, which the column truncates and which once pulled
 * the next day's visits into the console's list.
 */
export function jobDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The day a `scheduledAt` stands for, as the phone names it. */
export function jobDayOf(scheduledAt: Date): string {
  return scheduledAt.toISOString().slice(0, 10);
}

/** One day, or everything before one, or no date at all. */
export function jobDayWhere(query: {
  scheduledOn?: string;
  scheduledBefore?: string;
}): Prisma.InspectionWhereInput {
  if (query.scheduledOn) return { scheduledAt: jobDay(query.scheduledOn) };
  if (query.scheduledBefore) return { scheduledAt: { lt: jobDay(query.scheduledBefore) } };
  return {};
}

/**
 * The order a list reads in.
 *
 * A day reads as the round is driven: by the booked window, earliest first,
 * with day-booked work after it. History reads backwards, newest first -- the
 * job a technician is looking for there is nearly always the one they just did.
 * The id last, so a page boundary never lands between two rows that compare
 * equal and shows one twice.
 */
export function jobListOrder(order: 'schedule' | 'recent' = 'schedule'): Prisma.InspectionOrderByWithRelationInput[] {
  if (order === 'recent')
    return [
      { scheduledAt: 'desc' },
      { submittedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ];
  return [
    { scheduledAt: 'asc' },
    { scheduledStartAt: { sort: 'asc', nulls: 'last' } },
    { id: 'asc' },
  ];
}

/**
 * Words that name a kind of job, as a technician types them.
 *
 * Built from the enum, so a new job type is searchable the day it exists:
 * MOVE_OUT answers "move", "out", "move-out" and "moveout". The extra words are
 * the ones the office and the crew actually say.
 */
const TYPE_ALIASES: Partial<Record<InspectionType, readonly string[]>> = {
  BACK_TO_MARKET: ['btm'],
  AC_FILTER_DELIVERY: ['filter', 'filters', 'ac'],
  SUPRA_LOCKBOX_PLACEMENT: ['lockbox', 'supra'],
  SUPRA_LOCKBOX_REMOVAL: ['lockbox', 'supra'],
};

/** Joining words in an enum name that nobody searches by. */
const TYPE_FILLER = new Set(['to']);

const TYPE_WORDS = (() => {
  const words = new Map<string, InspectionType[]>();
  const add = (word: string, type: InspectionType) =>
    words.set(word, [...new Set([...(words.get(word) ?? []), type])]);
  for (const type of Object.values(InspectionType)) {
    const parts = type.toLowerCase().split('_');
    parts.filter((part) => !TYPE_FILLER.has(part)).forEach((part) => add(part, type));
    add(parts.join('-'), type);
    add(parts.join(''), type);
    TYPE_ALIASES[type]?.forEach((alias) => add(alias, type));
  }
  return words;
})();

/** Words for where a job stands, in the phone's own labels. */
const STATUS_WORDS = new Map<string, readonly InspectionStatus[]>([
  ['assigned', [InspectionStatus.SCHEDULED]],
  ['scheduled', [InspectionStatus.SCHEDULED]],
  ['progress', [InspectionStatus.IN_PROGRESS]],
  ['started', [InspectionStatus.IN_PROGRESS]],
  ['submitted', [InspectionStatus.TECHNICIAN_SUBMITTED]],
  [
    'office',
    [
      InspectionStatus.PROCESSING,
      InspectionStatus.REVIEW_REQUIRED,
      InspectionStatus.UNDER_REVIEW,
      InspectionStatus.TBD,
    ],
  ],
  ['follow-up', [InspectionStatus.FOLLOW_UP_REQUIRED]],
  ['followup', [InspectionStatus.FOLLOW_UP_REQUIRED]],
  ['completed', [InspectionStatus.COMPLETED]],
  ['complete', [InspectionStatus.COMPLETED]],
  ['done', [InspectionStatus.COMPLETED]],
]);

const insensitive = (value: string) => ({ contains: value, mode: 'insensitive' as const });

/**
 * One word, found in any place a job is known by: its property's name, street,
 * city and ZIP (Propertyware's building, or the property it was created
 * against), its unit, and the Jobber visit's title.
 *
 * The phone's search used to be one `contains` of the whole text on the street,
 * the building name and the unit -- while its placeholder promised the city.
 */
function textFieldsContain(word: string): Prisma.InspectionWhereInput[] {
  const match = insensitive(word);
  return [
    { propertywareBuilding: { name: match } },
    { propertywareBuilding: { addressLine1: match } },
    { propertywareBuilding: { city: match } },
    { propertywareBuilding: { postalCode: match } },
    { propertywareUnit: { name: match } },
    { property: { name: match } },
    { property: { addressLine1: match } },
    { property: { city: match } },
    { property: { postalCode: match } },
    { jobberVisitTitle: match },
  ];
}

/**
 * Every word of the search found somewhere, in any order (`searchTerms`), each
 * an OR of the text fields, the job types and the statuses it names.
 *
 * A keyword of two letters or fewer -- "in" of "move in", "ac" -- is matched as
 * that keyword only. As text it is inside half the addresses in Texas ("Main",
 * "Acres"), and would match nearly everything.
 */
export function technicianJobSearchWhere(search: string | undefined): Prisma.InspectionWhereInput[] {
  return searchTerms(search).map((spellings) => {
    const types = [...new Set(spellings.flatMap((word) => TYPE_WORDS.get(word) ?? []))];
    const statuses = [...new Set(spellings.flatMap((word) => STATUS_WORDS.get(word) ?? []))];
    const keywordOnly =
      (types.length > 0 || statuses.length > 0) && spellings.every((word) => word.length <= 2);
    const or: Prisma.InspectionWhereInput[] = [
      ...(keywordOnly ? [] : spellings.flatMap(textFieldsContain)),
      ...(types.length ? [{ inspectionType: { in: types } }] : []),
      ...(statuses.length ? [{ status: { in: statuses } }] : []),
    ];
    return { OR: or };
  });
}

/** Statuses still in the technician's hands. */
const OPEN_STATUSES = new Set<InspectionStatus>([InspectionStatus.SCHEDULED, InspectionStatus.IN_PROGRESS]);

export interface JobDayCount {
  /** The Texas day, `YYYY-MM-DD`. */
  day: string;
  total: number;
  /** Still to do: assigned or in progress. */
  open: number;
}

/** Per-day totals from a `groupBy` on day and status, in day order. */
export function jobDayCounts(
  rows: readonly { scheduledAt: Date; status: InspectionStatus; _count: { _all: number } }[],
): JobDayCount[] {
  const byDay = new Map<string, JobDayCount>();
  for (const row of rows) {
    const day = jobDayOf(row.scheduledAt);
    const entry = byDay.get(day) ?? { day, total: 0, open: 0 };
    entry.total += row._count._all;
    if (OPEN_STATUSES.has(row.status)) entry.open += row._count._all;
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The widest range the day strip may ask counts for: a month either side, roughly. */
export const MAX_JOB_DAY_RANGE_DAYS = 93;
