import type { Inspection } from '../domain/models';
import { dayHeading, jobDayOf, type JobDay } from './job-day';

/** One titled run of jobs in the Jobs list. */
export interface JobSection {
  key: string;
  title: string;
  data: Inspection[];
  /** Whether each row repeats its day; off when the heading already says it. */
  showDay: boolean;
}

/**
 * A day of the schedule, with today's jobs still open from earlier days first.
 *
 * Those come first because they are the ones at risk: a job booked yesterday
 * and never finished does not belong to yesterday's page any more, and a
 * calendar that only ever showed the day it was booked for would let it drop
 * out of sight (the office's choice, 2026-10-07).
 */
export function scheduleSections({
  day,
  today,
  rows,
  stillOpen,
}: {
  day: JobDay;
  today: JobDay;
  rows: readonly Inspection[];
  stillOpen: readonly Inspection[];
}): JobSection[] {
  const sections: JobSection[] = [];
  if (day === today && stillOpen.length)
    sections.push({
      key: 'still-open',
      title: 'Still open from earlier days',
      data: [...stillOpen],
      showDay: true,
    });
  if (rows.length) sections.push({ key: day, title: dayHeading(day, today), data: [...rows], showDay: false });
  return sections;
}

/**
 * History by day, newest first, each day under its own heading. The rows
 * arrive newest first from the server; this only cuts them where the day
 * changes.
 */
export function historySections(rows: readonly Inspection[], today: JobDay): JobSection[] {
  const sections: JobSection[] = [];
  for (const row of rows) {
    const day = jobDayOf(row.scheduledAt);
    const last = sections.at(-1);
    if (last?.key === day) last.data.push(row);
    else sections.push({ key: day, title: dayHeading(day, today), data: [row], showDay: false });
  }
  return sections;
}

/**
 * Search results in three groups: Today, Upcoming (soonest first), and History
 * (latest first). A search spans every date, so the group says when a match is
 * before the row does.
 */
export function searchSections(rows: readonly Inspection[], today: JobDay): JobSection[] {
  const todays: Inspection[] = [];
  const upcoming: Inspection[] = [];
  const history: Inspection[] = [];
  for (const row of rows) {
    const day = jobDayOf(row.scheduledAt);
    if (day === today) todays.push(row);
    else if (day > today) upcoming.push(row);
    else history.push(row);
  }
  // The server answers newest first, which puts next month above tomorrow.
  upcoming.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return [
    { key: 'today', title: 'Today', data: todays, showDay: false },
    { key: 'upcoming', title: 'Upcoming', data: upcoming, showDay: true },
    { key: 'history', title: 'History', data: history, showDay: true },
  ].filter((section) => section.data.length > 0);
}
