'use client';

import { TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { LONG_HOP_MINUTES, sortGroups, UNGROUPED_GREEN, type FileGroup, type GroupFile, type GroupOrder } from './group-file';
import { formatDrive, formatKm, milesToMetres, type RouteView } from './road-routes';

/**
 * A group's number, as the map and the list both draw it.
 *
 * A pale disc ringed in the group's colour, where a stop is a solid disc in
 * it: the two are told apart by more than their colour, so a group's "7" is
 * never read as somebody's seventh stop. The same look as the quarter's own
 * numbered days on this tab.
 */
export function GroupBadge({ group, className }: { group: Pick<FileGroup, 'label' | 'color'>; className?: string }) {
  return (
    <span
      className={cn(
        'bg-card text-foreground flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border-2 px-1 text-xs font-semibold shadow-sm',
        className,
      )}
      style={{ borderColor: group.color.fill }}
    >
      {group.label}
    </span>
  );
}

/** A figure as the file writes it: 28 stays 28, 30.5 stays 30.5. */
const figure = (value: number) => value.toLocaleString();

/**
 * The group's line in the list: "10 properties · 1 h 12 min drive · 61.8 km".
 *
 * The drive along the roads once Mapbox has routed it (2026-09-30) and
 * "calculating…" until then. Where it could not be routed, or nothing asked,
 * the file's own figures, as the list always showed.
 */
export function groupSummary(group: Pick<FileGroup, 'size' | 'driveMinutes' | 'routeMiles'>, route?: RouteView): string {
  const size = `${figure(group.size)} ${group.size === 1 ? 'property' : 'properties'}`;
  if (route?.status === 'ok')
    return [size, `${formatDrive(route.route.durationS)} drive`, formatKm(route.route.distanceM)].join(' · ');
  if (route?.status === 'loading') return `${size} · calculating…`;
  return [
    size,
    group.driveMinutes === null ? null : `${figure(group.driveMinutes)} min drive`,
    // The file's own figure is in miles; shown in kilometres like everything else.
    group.routeMiles === null ? null : formatKm(milesToMetres(group.routeMiles)),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A distance along the roads, from Mapbox, in purple-blue: never to be read as
 * a straight line or as the file's own figure (the office, 2026-09-30).
 */
export function RoadDistance({ metres }: { metres: number }) {
  return (
    <span className="text-road-distance font-medium" title="Along the roads, from Mapbox">
      {formatKm(metres)}
    </span>
  );
}

/** The group's line in the list, with the road distance in its own colour when Mapbox has routed it. */
function GroupSummaryLine({ group, route }: { group: FileGroup; route?: RouteView }) {
  if (route?.status !== 'ok') return <>{groupSummary(group, route)}</>;
  return (
    <>
      {`${figure(group.size)} ${group.size === 1 ? 'property' : 'properties'} · ${formatDrive(route.route.durationS)} drive · `}
      <RoadDistance metres={route.route.distanceM} />
    </>
  );
}

/** What the list calls a group, and a property in none. */
export interface LegendNoun {
  one: string;
  many: string;
  /** A property in no group, after "Green: ". */
  loose: string;
}

const GROUP_NOUN: LegendNoun = { one: 'group', many: 'groups', loose: 'in no group' };

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** What a group is sorted by when sorted by drive: its road route's minutes, else the file's. */
export const driveMinutesOf = (group: FileGroup, route?: RouteView) =>
  route?.status === 'ok' ? route.route.durationS / 60 : group.driveMinutes;

/**
 * Every group in the file, which is both the legend and the filter.
 *
 * Nothing ticked is every group; ticking some shows only those, and the map
 * goes to them. Each line carries the file's own figures for the group -- its
 * size, its drive and its route miles, then how far across it is -- so two
 * groups can be weighed against each other without opening either. Sorted by
 * drive, the longest days come first.
 */
export function GroupFileLegend({
  file,
  picked,
  order,
  onOrder,
  onToggle,
  onShowAll,
  routeViews,
  noun = GROUP_NOUN,
}: {
  file: GroupFile;
  /** What a group is called: a file's "group", a quarter's "day". */
  noun?: LegendNoun;
  /** Each group's road route, by group key. */
  routeViews?: ReadonlyMap<string, RouteView>;
  /** The groups ticked. Empty is every group. */
  picked: ReadonlySet<string>;
  order: GroupOrder;
  onOrder: (order: GroupOrder) => void;
  onToggle: (key: string) => void;
  onShowAll: () => void;
}) {
  const approximate = file.groups.reduce((sum, group) => sum + group.rows.filter((row) => row.approximate).length, 0);
  const longHops = file.groups.filter((group) => group.longHop !== null).length;
  const listed = sortGroups(file.groups, order, (group) => driveMinutesOf(group, routeViews?.get(group.key)));

  return (
    <aside className="bg-card flex min-h-0 flex-col rounded-lg border lg:h-full">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-sm font-medium">
          {picked.size
            ? `${picked.size.toLocaleString()} of ${file.groups.length.toLocaleString()} ${noun.many}`
            : `All ${file.groups.length.toLocaleString()} ${noun.many}`}
        </p>
        <Button disabled={!picked.size} onClick={onShowAll} size="sm" variant="outline">
          Show all
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-muted-foreground text-xs">Sort</span>
        <Select onValueChange={(value) => onOrder(value as GroupOrder)} value={order}>
          <SelectTrigger aria-label={`Sort the ${noun.many}`} className="h-7 w-auto text-xs" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="number">By {noun.one} number</SelectItem>
            <SelectItem value="drive">By drive time, longest first</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ul className="divide-border max-h-96 divide-y overflow-y-auto lg:max-h-none lg:flex-1">
        {listed.map((group) => {
          const view = routeViews?.get(group.key);
          // The leg the map draws red: the one Mapbox times longest, when it has routed the group.
          const hopIndex =
            group.longHop === null
              ? null
              : view?.status === 'ok' && view.route.legs.length === group.rows.length - 1
                ? view.route.legs.reduce((longest, leg, index, legs) => (leg.durationS > legs[longest]!.durationS ? index : longest), 0)
                : group.longHop;
          const hop = hopIndex === null ? null : group.rows[hopIndex]!;
          return (
            <li key={group.key}>
              <label
                className={cn(
                  'hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-3 py-2',
                  picked.has(group.key) && 'bg-muted/60',
                )}
              >
                <Checkbox
                  aria-label={`${capital(noun.one)} ${group.label}`}
                  checked={picked.has(group.key)}
                  onCheckedChange={() => onToggle(group.key)}
                />
                <GroupBadge group={group} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {/* A name given by hand (an exported manual grouping) before the area. */}
                    <span className="min-w-0 truncate text-sm font-medium">
                      {group.name ?? group.area ?? `${capital(noun.one)} ${group.label}`}
                    </span>
                    {hop ? (
                      <Badge
                        className="px-1.5 py-0 text-[10px]"
                        title={`Longest drive between two stops: ${figure(group.longestHopMinutes!)} min. Drawn in red on the route, between stops ${hop.stop ?? '?'} and ${group.rows[hopIndex! + 1]!.stop ?? '?'}.`}
                        variant="destructive"
                      >
                        long hop
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1 text-xs">
                    <span>
                      <GroupSummaryLine group={group} route={routeViews?.get(group.key)} />
                    </span>
                    {routeViews?.get(group.key)?.status === 'error' ? (
                      <TriangleAlertIcon
                        aria-label="No road route: drawn as straight lines"
                        className="text-warning size-3.5 shrink-0"
                        role="img"
                      >
                        <title>No road route from Mapbox, so it is drawn as straight lines and the figures are the file's.</title>
                      </TriangleAlertIcon>
                    ) : null}
                  </span>
                  {(group.name && group.area) || group.spanMiles !== null ? (
                    <span className="text-muted-foreground block text-xs">
                      {[group.name ? group.area : null, group.spanMiles === null ? null : `${formatKm(milesToMetres(group.spanMiles))} across`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="text-muted-foreground grid gap-1 border-t px-3 py-2 text-xs">
        <p className="flex items-center gap-1.5">
          <svg aria-hidden height="14" viewBox="0 0 22 22" width="14">
            <circle className="fill-muted-foreground" cx="11" cy="11" r="9" stroke="#fff" strokeWidth="2" />
          </svg>
          A property, numbered in its {noun.one}&rsquo;s visiting order. Click one for its details.
        </p>
        <p className="flex items-center gap-1.5">
          <svg aria-hidden height="14" viewBox="0 0 22 22" width="14">
            <path className="stroke-road-distance" d="M3 11h16" strokeLinecap="round" strokeWidth="4" />
          </svg>
          Purple-blue: the drive along the roads, from Mapbox.
        </p>
        {file.ungrouped.length ? (
          <p className="flex items-center gap-1.5">
            <svg aria-hidden height="14" viewBox="0 0 22 22" width="14">
              <circle cx="11" cy="11" fill={UNGROUPED_GREEN} r="6.5" stroke="#fff" strokeWidth="2" />
            </svg>
            Green: {noun.loose} ({file.ungrouped.length.toLocaleString()})
          </p>
        ) : null}
        {longHops ? (
          <p className="flex items-center gap-1.5">
            <svg aria-hidden height="14" viewBox="0 0 22 22" width="14">
              <path className="stroke-destructive" d="M3 11h16" strokeLinecap="round" strokeWidth="4" />
            </svg>
            <span>
              Red: a drive of {LONG_HOP_MINUTES} min or more between two stops ({longHops.toLocaleString()}{' '}
              {longHops === 1 ? noun.one : noun.many}), drawn on the leg Mapbox times longest; with straight lines, the
              longest straight step.
            </span>
          </p>
        ) : null}
        {approximate ? (
          <p className="flex items-center gap-1.5">
            <svg aria-hidden height="14" viewBox="0 0 22 22" width="14">
              <circle cx="11" cy="11" fill="#fff" r="9" />
              <circle
                className="fill-muted-foreground stroke-muted-foreground"
                cx="11"
                cy="11"
                fillOpacity={0.35}
                r="9"
                strokeDasharray="3.5 2"
                strokeWidth="2.5"
              />
            </svg>
            Pale and dashed: an approximate location, at its zip code&rsquo;s centre rather than the building (
            {approximate.toLocaleString()})
          </p>
        ) : null}
        {file.skippedRows.length ? (
          <p>
            Not on the map, with no group or no position: row{file.skippedRows.length === 1 ? '' : 's'}{' '}
            {file.skippedRows.join(', ')}.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
