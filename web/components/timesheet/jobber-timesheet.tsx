'use client';

import { CarFrontIcon, ChevronRightIcon, HomeIcon, MapIcon, PencilIcon, StoreIcon } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState, type ReactNode } from 'react';

import { PersonDisc } from '@/components/schedule/calendar-visit';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatTime } from '@/lib/format';
import {
  asHours,
  jobLabel,
  namedByOpenStreetMap,
  stopDetail,
  stopKind,
  stopTitle,
  technicianDay,
  type DayEntry,
  type Timesheet,
  type TimesheetTotal,
  type TimesheetVisit,
} from '@/lib/timesheet-queries';
import { cn } from '@/lib/utils';

/**
 * The timesheet as Jobber's reads: one row per technician with their hours,
 * opening into their day as a list -- each property, each drive and each stop,
 * when it started, when it ended and how long it took (the office, 2026-11-04:
 * "we should be able to determine the drive time, time on the property ...
 * where did they stop, like hardwares, convenient store including the name of
 * the stores").
 *
 * Everything on it is what the timesheet already reads; nothing here asks a
 * provider anything. A stop's name and kind were looked up once, on the
 * server, when the stop was found, and the map is a link, not a map.
 */

/** Below this a silence is not worth a mention. */
const QUIET_WORTH_SAYING_SECONDS = 60;

export function JobberTimesheet({
  sheet,
  date,
  canChange,
  onCorrect,
}: {
  sheet: Timesheet;
  date: string;
  canChange: boolean;
  onCorrect: (visit: TimesheetVisit) => void;
}) {
  const seesStops = sheet.stops !== undefined;
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    // One technician needs no click to see their day.
    sheet.totals.length === 1 ? new Set([sheet.totals[0]!.technicianId]) : new Set(),
  );
  const everyoneOpen = sheet.totals.length > 0 && sheet.totals.every((row) => open.has(row.technicianId));
  const toggle = (technicianId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(technicianId)) next.delete(technicianId);
      else next.add(technicianId);
      return next;
    });

  const sum = (pick: (row: TimesheetTotal) => number) => sheet.totals.reduce((total, row) => total + pick(row), 0);

  return (
    <>
      <section aria-label="The day at a glance" className="-mx-1 mb-6 overflow-x-auto px-1 pb-1">
        <div className="flex gap-3">
          <Figure caption="Inside a property’s circle" title="On site" value={asHours(sum((row) => row.onsiteSeconds))} />
          <Figure caption="On the road between places" title="Driving" value={asHours(sum((row) => row.generalSeconds))} />
          <Figure caption="Stores, supply runs, lunch" title="Stops" value={asHours(sum((row) => row.stopSeconds))} />
          <Figure caption="First arrival to last departure" title="Total" value={asHours(sum((row) => row.totalSeconds))} />
        </div>
      </section>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-heading text-lg font-bold">
          Team <span className="text-muted-foreground font-normal">({sheet.totals.length})</span>
        </h2>
        <Button
          onClick={() =>
            setOpen(everyoneOpen ? new Set() : new Set(sheet.totals.map((row) => row.technicianId)))
          }
          size="sm"
          variant="outline"
        >
          {everyoneOpen ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>

      <ul className="flex flex-col gap-2">
        {sheet.totals.map((total) => (
          <li key={total.technicianId}>
            <TechnicianDay
              canChange={canChange}
              date={date}
              entries={technicianDay(sheet, total.technicianId)}
              onCorrect={onCorrect}
              onToggle={() => toggle(total.technicianId)}
              open={open.has(total.technicianId)}
              seesStops={seesStops}
              total={total}
            />
          </li>
        ))}
      </ul>

      {/* The licence the names are kept under asks for this. */}
      {sheet.stops?.some(namedByOpenStreetMap) ? (
        <p className="text-muted-foreground mt-3 text-xs">
          Place names ©{' '}
          <a
            className="underline-offset-2 hover:underline"
            href="https://www.openstreetmap.org/copyright"
            rel="noreferrer"
            target="_blank"
          >
            OpenStreetMap
          </a>{' '}
          contributors
        </p>
      ) : null}
    </>
  );
}

function Figure({ title, caption, value }: { title: string; caption: string; value: string }) {
  return (
    <div className="bg-card flex min-w-44 flex-1 flex-col rounded-lg border p-4">
      <h3 className="text-heading text-base font-bold">{title}</h3>
      <p className="text-muted-foreground text-xs">{caption}</p>
      <span className="font-display text-heading mt-auto pt-4 text-3xl leading-none font-extrabold tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** One technician: a row with their hours, and their day beneath it once opened. */
function TechnicianDay({
  total,
  entries,
  open,
  onToggle,
  date,
  seesStops,
  canChange,
  onCorrect,
}: {
  total: TimesheetTotal;
  entries: DayEntry[];
  open: boolean;
  onToggle: () => void;
  date: string;
  seesStops: boolean;
  canChange: boolean;
  onCorrect: (visit: TimesheetVisit) => void;
}) {
  const panelId = `day-${total.technicianId}`;
  return (
    <div className="overflow-hidden rounded-lg border">
      <h3>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className="bg-muted/60 hover:bg-muted flex w-full items-center gap-3 px-4 py-3 text-left"
          onClick={onToggle}
          type="button"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn('text-muted-foreground size-4 shrink-0 transition-transform', open && 'rotate-90')}
          />
          <PersonDisc className="size-7 text-[10px]" name={total.technician} />
          <span className="text-heading min-w-0 flex-1 truncate font-semibold">{total.technician}</span>
          <span className="text-muted-foreground hidden gap-3 text-xs md:flex">
            <span>On site {asHours(total.onsiteSeconds)}</span>
            <span>Driving {asHours(total.generalSeconds)}</span>
            <span>Stops {asHours(total.stopSeconds)}</span>
          </span>
          <span className="text-success font-semibold tabular-nums">{asHours(total.totalSeconds)}</span>
        </button>
      </h3>
      {open ? (
        <div id={panelId}>
          <Table aria-label={`${total.technician}’s day`}>
            {/* Not sticky: a page of open days would stack their heads under the top bar. */}
            <TableHeader className="sr-only md:not-sr-only lg:static">
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4" scope="col">
                  Title
                </TableHead>
                <TableHead className="hidden px-4 md:table-cell" scope="col">
                  Details
                </TableHead>
                <TableHead className="hidden px-4 text-right md:table-cell" scope="col">
                  Start time
                </TableHead>
                <TableHead className="hidden px-4 text-right md:table-cell" scope="col">
                  End time
                </TableHead>
                <TableHead className="px-4 text-right" scope="col">
                  Duration
                </TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <EntryRow
                  canChange={canChange}
                  date={date}
                  entry={entry}
                  key={entry.key}
                  onCorrect={onCorrect}
                />
              ))}
            </TableBody>
          </Table>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2.5 text-xs">
            <span>On site {asHours(total.onsiteSeconds)}</span>
            <span>Driving {asHours(total.generalSeconds)}</span>
            <span>Stops {asHours(total.stopSeconds)}</span>
            {total.quietSeconds >= QUIET_WORTH_SAYING_SECONDS ? (
              <span>Phone quiet {asHours(total.quietSeconds)}, counted in the hours</span>
            ) : null}
            {seesStops ? (
              <Link
                className="text-foreground ml-auto inline-flex items-center gap-1 font-semibold underline-offset-2 hover:underline"
                href={`/map?${new URLSearchParams({ technician: total.technicianId, date }).toString()}`}
              >
                <MapIcon aria-hidden className="size-3.5" />
                See the day on the map
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One line of the day: a property, a drive, or a stop. */
function EntryRow({
  entry,
  date,
  canChange,
  onCorrect,
}: {
  entry: DayEntry;
  date: string;
  canChange: boolean;
  onCorrect: (visit: TimesheetVisit) => void;
}) {
  const quiet = entry.kind === 'visit' ? entry.visit.quietSeconds : entry.kind === 'stop' ? entry.stop.quietSeconds : entry.drive.quietSeconds;
  const details: string[] = [];
  let title: ReactNode;
  let action: ReactNode = null;

  if (entry.kind === 'visit') {
    const { visit } = entry;
    title = (
      <Titled icon={null} subtitle={visit.address ?? 'A property'}>
        <Jobs visit={visit} />
      </Titled>
    );
    if (visit.adjusted) details.push('Corrected');
    if (visit.addedByHand) details.push('Added by hand');
    if (visit.stays > 1)
      details.push(
        `Stepped out ${visit.stays - 1} ${visit.stays === 2 ? 'time' : 'times'}` +
          (entry.steppedOutSeconds >= 60 ? ` (${asHours(entry.steppedOutSeconds)})` : ''),
      );
    if (canChange)
      action = (
        <Button
          aria-label={`Correct the time at ${visit.address ?? 'this property'}`}
          onClick={() => onCorrect(visit)}
          size="icon-sm"
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      );
  } else if (entry.kind === 'drive') {
    title = (
      <Titled
        icon={<CarFrontIcon aria-hidden className="text-muted-foreground size-4" />}
        subtitle={driveRoute(entry.from, entry.to)}
      >
        Drive
      </Titled>
    );
  } else {
    const { stop } = entry;
    const kind = stopKind(stop);
    const detail = stopDetail(stop);
    title = (
      <Titled
        icon={
          stop.place?.kind === 'HOME' ? (
            <HomeIcon aria-hidden className="text-muted-foreground size-4" />
          ) : (
            <StoreIcon aria-hidden className="text-muted-foreground size-4" />
          )
        }
        subtitle={kind ?? (stop.place?.kind === 'PROPERTY' ? null : 'Stop')}
      >
        <span className="font-semibold">{stopTitle(stop)}</span>
      </Titled>
    );
    if (detail) details.push(detail);
    action = (
      <Button asChild size="icon-sm" variant="ghost">
        <Link
          aria-label={`Show ${stopTitle(stop)} on the map`}
          href={`/map?${new URLSearchParams({ technician: stop.technicianId, date }).toString()}`}
        >
          <MapIcon />
        </Link>
      </Button>
    );
  }
  if (quiet >= QUIET_WORTH_SAYING_SECONDS) details.push(`Phone quiet ${asHours(quiet)}`);

  return (
    <TableRow className={cn('align-top', entry.kind === 'drive' && 'bg-muted/25')}>
      <TableCell className="px-4 align-top">
        {title}
        {/* On a phone the times and details fold under the title. */}
        <div className="text-muted-foreground mt-1 text-xs md:hidden">
          <span className="font-mono tabular-nums">
            {formatTime(entry.startedAt)} – {formatTime(entry.endedAt)}
          </span>
          {details.length ? <Details items={details} /> : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground hidden px-4 align-top text-xs md:table-cell">
        {details.length ? <Details items={details} /> : '—'}
      </TableCell>
      <TableCell className="hidden px-4 text-right align-top font-mono whitespace-nowrap tabular-nums md:table-cell">
        {formatTime(entry.startedAt)}
      </TableCell>
      <TableCell className="hidden px-4 text-right align-top font-mono whitespace-nowrap tabular-nums md:table-cell">
        {formatTime(entry.endedAt)}
      </TableCell>
      <TableCell className="px-4 text-right align-top font-semibold whitespace-nowrap tabular-nums">
        {asHours(entry.seconds)}
      </TableCell>
      <TableCell className="w-10 py-2 pr-2 text-right align-top jobber:py-2">{action}</TableCell>
    </TableRow>
  );
}

/** "From 1 Oak St to The Home Depot", with whatever of it the day knows. */
export function driveRoute(from: string | null, to: string | null): string | null {
  if (from && to) return `From ${from} to ${to}`;
  if (to) return `To ${to}`;
  if (from) return `From ${from}`;
  return null;
}

function Titled({ icon, subtitle, children }: { icon: ReactNode; subtitle: string | null; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0">
        <div className="text-heading">{children}</div>
        {subtitle ? <div className="text-muted-foreground mt-0.5 text-xs">{subtitle}</div> : null}
      </div>
    </div>
  );
}

function Details({ items }: { items: string[] }) {
  return (
    <span className="flex flex-wrap gap-x-1.5">
      {items.map((item, index) => (
        <Fragment key={item}>
          {index ? <span aria-hidden>·</span> : null}
          <span>{item}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * What the technician was there to do, linked to each inspection, as Jobber's
 * entry titles link to the job. The benefit package is said beside it.
 */
function Jobs({ visit }: { visit: TimesheetVisit }) {
  if (!visit.jobs.length) return <span className="font-semibold">No visit booked</span>;
  return (
    <span className="flex flex-wrap gap-x-1.5 font-semibold">
      {visit.jobs.map((job, index) => (
        // With its place in the list: the key must hold even if a visit is
        // ever listed twice, rather than React dropping one of them.
        <Fragment key={`${index}:${job.inspectionId}`}>
          {index ? (
            <span aria-hidden className="text-muted-foreground">
              +
            </span>
          ) : null}
          <Link className="underline underline-offset-2" href={`/inspections/${job.inspectionId}`}>
            {jobLabel(job)}
          </Link>
        </Fragment>
      ))}
      {visit.jobs.some((job) => job.benefitPackage) ? (
        <span className="text-muted-foreground font-normal">· Benefit package</span>
      ) : null}
    </span>
  );
}
