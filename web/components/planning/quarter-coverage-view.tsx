'use client';

import { COVERAGE_GROUPS, type CoverageGroup, type QuarterCoverage, type QuarterCoverageProperty } from '@texasrenters/shared';
import { DownloadIcon, MapPinnedIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Stat, StatGroup } from '@/components/stat-card';
import { EmptyState } from '@/components/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';

import {
  coverageCounts,
  coverageCsv,
  dayText,
  daysLeftInQuarter,
  DETAIL_BADGE,
  extraNotes,
  groupDetail,
  groupLabel,
  matchesSearch,
  nextStep,
  visitTypeLabel,
  zoneLabel,
} from './quarter-coverage';

type Show = 'ALL' | CoverageGroup;

/**
 * The plan's "Coverage" tab (the office, 2026-11-20): every property in the
 * benefit package, sorted into the four groups the office asked for --
 * completed, scheduled but not completed, not scheduled, and no visit created
 * -- with what to do next about each.
 *
 * A property is counted once, from the best visit the quarter has there: a
 * new tenant's property visited for the old lease is completed, and a visit
 * booked straight in Jobber counts as much as one the plan made.
 */
export function QuarterCoverageView({
  coverage,
  onOpenStop,
  onAdd,
  adding = null,
}: {
  coverage: QuarterCoverage;
  /** Opens a plan visit's window, where it is given a day or fixed. */
  onOpenStop?: (stopId: string) => void;
  /** Gives a property its missing visit in the quarter; absent for someone who cannot change the plan. */
  onAdd?: (buildingId: string) => void;
  /** The property being added, while it is. */
  adding?: string | null;
}) {
  const [show, setShow] = useState<Show>('ALL');
  const [search, setSearch] = useState('');
  const quarter = `Q${coverage.quarterNumber} ${coverage.quarterYear}`;
  const counts = useMemo(() => coverageCounts(coverage.properties), [coverage.properties]);
  const listed = useMemo(
    () =>
      coverage.properties.filter((property) => (show === 'ALL' || property.group === show) && matchesSearch(property, search)),
    [coverage.properties, show, search],
  );
  const visited = counts.total ? Math.round((counts.groups.COMPLETED / counts.total) * 100) : 0;
  const daysLeft = daysLeftInQuarter(coverage.today, coverage.quarterYear, coverage.quarterNumber);

  const exportShown = () => {
    const name = show === 'ALL' ? 'coverage' : `coverage-${show.toLowerCase().replace('_', '-')}`;
    downloadCsv(`${quarter.replace(' ', '-').toLowerCase()}-${name}.csv`, coverageCsv(listed, coverage));
  };

  if (!counts.total)
    return (
      <EmptyState
        description="The tenant report enrols no property in the benefit package, so there is nothing to cover."
        icon={MapPinnedIcon}
        title="No property in the package"
      />
    );

  return (
    // One column no wider than the page: the filters and the table scroll inside it on a phone.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <p className="text-muted-foreground text-sm" role="status">
        {`${counts.total.toLocaleString()} ${counts.total === 1 ? 'property is' : 'properties are'} in the benefit package · ${visited}% visited for ${quarter}`}
        {daysLeft ? ` · ${daysLeft.toLocaleString()} ${daysLeft === 1 ? 'day' : 'days'} left` : ' · the quarter is over'}
      </p>

      <StatGroup columns="grid-cols-2 lg:grid-cols-4">
        {COVERAGE_GROUPS.map((group) => (
          <Stat
            detail={groupDetail(group, counts.details)}
            key={group}
            label={groupLabel(group, quarter)}
            tone={
              group === 'NONE' && counts.groups.NONE
                ? 'destructive'
                : (group === 'NOT_SCHEDULED' && counts.groups.NOT_SCHEDULED) || (group === 'SCHEDULED' && counts.details.PAST_DUE)
                  ? 'warning'
                  : 'default'
            }
            value={counts.groups[group].toLocaleString()}
          />
        ))}
      </StatGroup>

      {coverage.leftWithOpenVisit.length ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>{`Left the package, still in Jobber (${coverage.leftWithOpenVisit.length.toLocaleString()})`}</AlertTitle>
          <AlertDescription>
            <p>These properties are out of the benefit package now, but their visit this quarter is still booked or waiting. Cancel it in Jobber, or keep it.</p>
            <ul className="mt-1 grid gap-0.5">
              {coverage.leftWithOpenVisit.map((leaver) => (
                <li key={leaver.buildingId}>
                  <Link className="font-medium hover:underline" href={`/properties/${leaver.buildingId}`}>
                    {leaver.address}
                  </Link>
                  {` · ${leaver.visit.scheduledOn ? `booked ${dayText(leaver.visit.scheduledOn)}` : 'on Jobber’s Unscheduled list'}`}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Show"
          onChange={setShow}
          options={[
            { value: 'ALL', label: 'All', count: counts.total },
            ...COVERAGE_GROUPS.map((group) => ({ value: group, label: groupLabel(group, quarter), count: counts.groups[group] })),
          ]}
          value={show}
        />
        <div className="relative min-w-48 flex-1">
          <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            aria-label="Search properties"
            className="pl-8"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Address, city, zone or technician"
            type="search"
            value={search}
          />
        </div>
        <Button disabled={!listed.length} onClick={exportShown} size="sm" variant="outline">
          <DownloadIcon aria-hidden />
          Export CSV
        </Button>
      </div>

      {listed.length ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Property</TableHead>
                <TableHead scope="col">{`${quarter} visit`}</TableHead>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col">Next step</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listed.map((property) => (
                <CoverageRow
                  adding={adding === property.buildingId}
                  key={property.buildingId}
                  onAdd={onAdd}
                  onOpenStop={onOpenStop}
                  property={property}
                  quarter={quarter}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState
          description={search ? 'No property here matches the search.' : 'No property is in this group.'}
          icon={MapPinnedIcon}
          title="Nothing to show"
        />
      )}
    </div>
  );
}

function CoverageRow({
  property,
  quarter,
  onOpenStop,
  onAdd,
  adding,
}: {
  property: QuarterCoverageProperty;
  quarter: string;
  onOpenStop?: (stopId: string) => void;
  onAdd?: (buildingId: string) => void;
  adding: boolean;
}) {
  const { visit } = property;
  const badge = DETAIL_BADGE[property.detail];
  const facts = [property.city, zoneLabel(property.zone), visitTypeLabel(visit?.inspectionType)].filter(Boolean).join(' · ');
  const notes = extraNotes(property);
  // A visit not yet booked is fixed in its window here; one booked is opened as the inspection.
  // Not one about to move to a new lease: its window would give the old lease's visit a day.
  const fixHere = Boolean(
    visit?.stopId &&
      onOpenStop &&
      property.missingLeaseAction !== 'CARRY_OVER' &&
      (property.group === 'NOT_SCHEDULED' || property.detail === 'EXCLUDED'),
  );
  const addable = property.missingLeaseAction === 'ADD' || property.missingLeaseAction === 'CARRY_OVER';

  return (
    <TableRow>
      <TableCell className="align-top">
        <Link className="font-medium hover:underline" href={`/properties/${property.buildingId}`}>
          {property.address}
        </Link>
        {facts ? <p className="text-muted-foreground text-xs">{facts}</p> : null}
      </TableCell>
      <TableCell className="align-top">
        <Badge variant={badge.tone}>{badge.label}</Badge>
      </TableCell>
      <TableCell className="align-top whitespace-nowrap">
        <span className="tabular-nums">{dayText(visit?.scheduledOn)}</span>
        {visit?.technician ? <p className="text-muted-foreground text-xs">{visit.technician}</p> : null}
      </TableCell>
      <TableCell className="align-top">
        <p className="text-sm">{nextStep(property)}</p>
        {notes.length ? <p className="text-muted-foreground text-xs">{notes.join(' · ')}</p> : null}
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
          {onAdd && addable ? (
            <button
              className="text-primary font-medium hover:underline disabled:opacity-60"
              disabled={adding}
              onClick={() => onAdd(property.buildingId)}
              type="button"
            >
              {adding ? 'Adding…' : property.missingLeaseAction === 'CARRY_OVER' ? 'Move to the new lease' : `Add to ${quarter}`}
            </button>
          ) : null}
          {fixHere ? (
            <button className="text-primary font-medium hover:underline" onClick={() => onOpenStop!(visit!.stopId!)} type="button">
              Open in the plan
            </button>
          ) : null}
          {visit?.inspectionId ? (
            <Link className="text-primary font-medium hover:underline" href={`/inspections/${visit.inspectionId}`}>
              Open visit
            </Link>
          ) : null}
          {property.detail === 'NOT_PLANNED' && !onAdd ? (
            <Link className="text-primary font-medium hover:underline" href="/group-maker">
              Find it a group
            </Link>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
