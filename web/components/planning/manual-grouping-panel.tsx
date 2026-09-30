'use client';

import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  GripVerticalIcon,
  PencilIcon,
  RouteIcon,
  PlusIcon,
  Redo2Icon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { uniqueGroupName } from '@texasrenters/shared';
import { useState, type FormEvent } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import { nearUngroupedGreen, type GroupFileRow } from './group-file';
import { RoadDistance } from './group-file-legend';
import {
  COLOR_PRESETS,
  DEFAULT_TARGET,
  estDaySeconds,
  nextGroupName,
  groupPalette,
  nextGroupColor,
  routeMiles,
  type ManualGroup,
  type ManualState,
} from './manual-grouping';
import { formatDrive, formatKm, milesToMetres, SLOW_LEG_S, type RouteView } from './road-routes';

/** What the group form asks for. */
export interface GroupFields {
  name: string;
  color: string;
  target: number;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** More than any day anyone drives, and a guard against a typo of 90 for 9. */
const MAX_TARGET = 50;

/** One colour to pick, dimmed with the group's name when another group has it. */
function Swatch({
  value,
  chosen,
  usedBy,
  small = false,
  onPick,
}: {
  value: string;
  chosen: boolean;
  usedBy: string | undefined;
  small?: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <button
      aria-label={usedBy ? `${value}, used by ${usedBy}` : value}
      aria-pressed={chosen}
      className={cn(
        'rounded-full border-2 border-background shadow-sm outline-offset-2',
        small ? 'size-4' : 'size-6',
        chosen && 'outline-foreground outline-2',
        usedBy && !chosen && 'opacity-30',
      )}
      onClick={() => onPick(value)}
      style={{ backgroundColor: value }}
      title={usedBy ? `${value} · used by ${usedBy}` : value}
      type="button"
    />
  );
}

/**
 * A group's name, colour and size: for a new group, or to change one.
 *
 * Twenty swatches picked to be told apart, then 180 more for a template of up
 * to two hundred groups (the office, 2026-10-01), and any other colour by its
 * hex -- typed, or from the browser's own picker. A colour another group has
 * is dimmed and named, not refused: two groups far apart can share one.
 */
function GroupForm({
  open,
  title,
  initial,
  used,
  taken,
  submitLabel,
  onSubmit,
  onOpenChange,
}: {
  open: boolean;
  title: string;
  initial: GroupFields;
  /** Each colour the other groups have, and the group that has it. */
  used: ReadonlyMap<string, string>;
  /** The other groups' names: a group's name is its own (the office, 2026-10-01). */
  taken: readonly string[];
  submitLabel: string;
  onSubmit: (fields: GroupFields) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState(initial.color);
  const [hex, setHex] = useState(initial.color);
  const [target, setTarget] = useState(String(initial.target));
  const palette = groupPalette();
  const presets = palette.slice(0, COLOR_PRESETS.length);
  const more = palette.slice(COLOR_PRESETS.length);
  // Open already when the colour is one of them, so the chosen swatch shows.
  const [showMore, setShowMore] = useState(() => more.includes(initial.color.toLowerCase()));
  const inUse = palette.filter((value) => used.has(value)).length;

  const size = Number(target);
  const clash = name.trim() && taken.some((other) => other.trim().toLowerCase() === name.trim().toLowerCase());
  /** A free name in the same pattern, one click away, when the one typed is taken. */
  const free = clash ? uniqueGroupName(name, taken) : null;
  const problems = [
    name.trim() ? null : 'Give the group a name.',
    clash ? `${name.trim()} is already a group’s name.` : null,
    HEX.test(color) ? null : 'A colour is a # and six hex digits, like #0067a5.',
    Number.isInteger(size) && size >= 1 && size <= MAX_TARGET ? null : `The size is a whole number from 1 to ${MAX_TARGET}.`,
  ].filter((problem): problem is string => problem !== null);

  const pick = (value: string) => {
    setColor(value.toLowerCase());
    setHex(value.toLowerCase());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problems.length) return;
    onSubmit({ name: name.trim().slice(0, 60), color: color.toLowerCase(), target: size });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Its stops take this colour on the map, and it holds this many before it is full.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              aria-invalid={clash ? true : undefined}
              autoFocus
              id="group-name"
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            {free ? (
              <p className="text-warning flex flex-wrap items-center gap-1.5 text-xs" role="status">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                Another group is called {name.trim()}.
                <Button className="h-6 px-2 text-xs" onClick={() => setName(free)} size="sm" type="button" variant="outline">
                  Use {free}
                </Button>
              </p>
            ) : null}
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Colour</legend>
            <div className="grid grid-cols-10 gap-1.5">
              {presets.map((preset) => (
                <Swatch chosen={color === preset} key={preset} onPick={pick} usedBy={used.get(preset)} value={preset} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                aria-expanded={showMore}
                className="h-7 px-2 text-xs"
                onClick={() => setShowMore((open) => !open)}
                type="button"
                variant="ghost"
              >
                {showMore ? <ChevronUpIcon /> : <ChevronDownIcon />}
                {showMore ? 'Fewer colours' : `${more.length} more colours`}
              </Button>
              <span className="text-muted-foreground text-xs">
                {inUse.toLocaleString()} of {palette.length.toLocaleString()} in use
              </span>
            </div>
            {showMore ? (
              <div
                aria-label="More colours"
                className="grid max-h-44 grid-cols-15 gap-1 overflow-y-auto rounded-md border p-1.5"
                role="group"
              >
                {more.map((value) => (
                  <Swatch chosen={color === value} key={value} onPick={pick} small usedBy={used.get(value)} value={value} />
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                aria-label="Pick any colour"
                className="h-8 w-10 cursor-pointer rounded border bg-transparent p-0.5"
                onChange={(event) => pick(event.target.value)}
                type="color"
                value={HEX.test(color) ? color : '#000000'}
              />
              <Input
                aria-label="Custom colour, as hex"
                className="h-8 w-28 font-mono"
                maxLength={7}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setHex(value);
                  if (HEX.test(value)) setColor(value.toLowerCase());
                }}
                placeholder="#0067a5"
                value={hex}
              />
              <span aria-hidden className="size-6 rounded-full border" style={{ backgroundColor: HEX.test(color) ? color : 'transparent' }} />
            </div>
            {/* A warning, not a refusal: the colour is the reader's to choose. */}
            {HEX.test(color) && nearUngroupedGreen(color) ? (
              <p className="text-warning flex items-center gap-1.5 text-xs" role="status">
                <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
                Close to the green an ungrouped property is drawn in: this group's stops could be taken for ungrouped ones.
              </p>
            ) : null}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="group-target">Target size</Label>
            <Input
              className="w-24"
              id="group-target"
              inputMode="numeric"
              max={MAX_TARGET}
              min={1}
              onChange={(event) => setTarget(event.target.value)}
              type="number"
              value={target}
            />
          </div>

          {problems.length ? <p className="text-destructive text-sm">{problems[0]}</p> : null}

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={problems.length > 0} type="submit">
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Straight-line miles, as `routeMiles` measures them, shown in kilometres. */
const straightKm = (miles: number) => formatKm(milesToMetres(miles));

/**
 * A group's figures in the list: "7 / 9 properties · 1 h 12 min drive · 61.8 km",
 * and under it the day that makes -- drive, and every stop at so many minutes.
 *
 * "calculating…" while the road route is on its way. When Mapbox cannot route
 * it, the straight-line miles and a warning: the map draws it straight too.
 */
function GroupDrive({
  group,
  view,
  straightMiles,
  minutesPerProperty,
}: {
  group: ManualGroup;
  view: RouteView | undefined;
  straightMiles: number;
  minutesPerProperty: number;
}) {
  const stops = group.stops.length;
  const size = `${stops} / ${group.target} properties`;
  const route = view?.status === 'ok' ? view.route : null;
  const drive =
    stops < 2 ? (
      size
    ) : route ? (
      <span>
        {`${size} · ${formatDrive(route.durationS)} drive · `}
        <RoadDistance metres={route.distanceM} />
      </span>
    ) : view?.status === 'error'
          ? `${size} · ${straightKm(straightMiles)} straight`
          : `${size} · calculating…`;
  // One stop drives nowhere; otherwise the day waits for the drive.
  const driveSeconds = stops === 1 ? 0 : route?.durationS;
  const day =
    stops === 0
      ? null
      : driveSeconds === undefined
        ? view?.status === 'error'
          ? null
          : 'Est. day: calculating…'
        : `Est. day: ${formatDrive(estDaySeconds(driveSeconds, stops, minutesPerProperty))}`;
  return (
    <>
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        {drive}
        {view?.status === 'error' ? (
          <TriangleAlertIcon aria-label="No road route" className="text-warning size-3.5 shrink-0" role="img">
            <title>{`No road route from Mapbox (${view.message}), so it is drawn as straight lines.`}</title>
          </TriangleAlertIcon>
        ) : null}
      </span>
      {day ? <span className="text-muted-foreground block text-xs">{day}</span> : null}
    </>
  );
}

/**
 * The drive to a stop from the one before it: "↳ 8 min · 5.0 km", amber from
 * 15 minutes -- the same legs are amber on the map.
 */
function LegLine({ index, view }: { index: number; view: RouteView | undefined }) {
  if (view?.status === 'loading') return <span className="text-muted-foreground block text-xs">↳ calculating…</span>;
  const leg = view?.status === 'ok' ? view.route.legs[index] : undefined;
  if (!leg) return null;
  const slow = leg.durationS >= SLOW_LEG_S;
  // The miles in the road-distance purple-blue, as on the group's line; the
  // time and "long leg" keep the amber, so the warning still reads.
  return (
    <span className={cn('block text-xs', slow ? 'text-warning font-medium' : 'text-muted-foreground')}>
      ↳ {formatDrive(leg.durationS)} · <RoadDistance metres={leg.distanceM} />
      {slow ? ' · long leg' : null}
    </span>
  );
}

/**
 * The side panel while groups are built by hand.
 *
 * At the top, how much is left; then every group, the one being built
 * highlighted; and under them, the stops of that group in order, dragged or
 * moved with the arrows to change the order -- the route redraws as they move.
 */
export function ManualGroupingPanel({
  state,
  activeId,
  byRow,
  total,
  dimOthers,
  canUndo,
  canRedo,
  onDimOthers,
  onUndo,
  onRedo,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onReorder,
  onRemoveStop,
  onRaiseTarget,
  onExport,
  routeViews,
  minutesPerProperty,
  onMinutesPerProperty,
  autoOrder,
  onAutoOrder,
  onOptimize,
  ordering,
  editingBy,
}: {
  state: ManualState;
  activeId: string | null;
  byRow: ReadonlyMap<number, GroupFileRow>;
  /** Every property in the file. */
  total: number;
  dimOthers: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onDimOthers: (dim: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSelect: (id: string) => void;
  onCreate: (fields: GroupFields) => void;
  onUpdate: (id: string, fields: GroupFields) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, from: number, to: number) => void;
  onRemoveStop: (row: number) => void;
  onRaiseTarget: (id: string) => void;
  onExport: () => void;
  /** Each group's road route, by group id. */
  routeViews: ReadonlyMap<string, RouteView>;
  /** Minutes spent at each property, for the estimated day. */
  minutesPerProperty: number;
  onMinutesPerProperty: (minutes: number) => void;
  /** Stops put in the fastest order as they are added and taken out. */
  autoOrder: boolean;
  onAutoOrder: (on: boolean) => void;
  /** Put a group in the fastest order now. */
  onOptimize: (id: string) => void;
  /** Groups whose order is being worked out. */
  ordering: ReadonlySet<string>;
  /** Who else is building each group of a live template, by group id. */
  editingBy?: ReadonlyMap<string, readonly string[]>;
}) {
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; group: ManualGroup } | null>(null);
  const [deleting, setDeleting] = useState<ManualGroup | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const grouped = state.groups.reduce((sum, group) => sum + group.stops.length, 0);
  const active = state.groups.find((group) => group.id === activeId) ?? null;
  const rowsOf = (group: ManualGroup) => group.stops.flatMap((row) => byRow.get(row) ?? []);

  const drop = (to: number) => {
    if (active && dragFrom !== null && dragFrom !== to) onReorder(active.id, dragFrom, to);
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <aside className="bg-card flex min-h-0 flex-col rounded-lg border lg:h-full">
      <div className="grid gap-2 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {grouped.toLocaleString()} of {total.toLocaleString()} grouped
            <span className="text-muted-foreground font-normal"> · {(total - grouped).toLocaleString()} left</span>
          </p>
          <div className="flex items-center gap-1">
            <Button aria-label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} size="icon-sm" title="Undo (Ctrl+Z)" variant="ghost">
              <Undo2Icon />
            </Button>
            <Button
              aria-label="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={onRedo}
              size="icon-sm"
              title="Redo (Ctrl+Shift+Z)"
              variant="ghost"
            >
              <Redo2Icon />
            </Button>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch aria-label="Show only ungrouped" checked={dimOthers} onCheckedChange={onDimOthers} />
          Show only ungrouped
          <span className="text-muted-foreground text-xs">(other groups fade)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Minutes per property
          <Input
            aria-label="Minutes per property"
            className="h-7 w-16"
            inputMode="numeric"
            max={240}
            min={0}
            onChange={(event) => {
              const minutes = Number(event.target.value);
              if (Number.isInteger(minutes) && minutes >= 0 && minutes <= 240) onMinutesPerProperty(minutes);
            }}
            type="number"
            value={minutesPerProperty}
          />
          <span className="text-muted-foreground text-xs">for the estimated day</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch aria-label="Optimize the route after every click" checked={autoOrder} onCheckedChange={onAutoOrder} />
          Optimize the route after every click
        </label>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => setForm({ mode: 'new' })} size="sm">
            <PlusIcon />
            New group
          </Button>
          <Button disabled={!state.groups.length} onClick={onExport} size="sm" variant="outline">
            <DownloadIcon />
            Export CSV
          </Button>
        </div>
      </div>

      <ul aria-label="Groups" className="divide-border min-h-24 flex-1 divide-y overflow-y-auto">
        {state.groups.length === 0 ? (
          <li className="text-muted-foreground px-3 py-6 text-center text-sm">
            No groups yet. Make one with New group, then click properties on the map to add them in order.
          </li>
        ) : null}
        {state.groups.map((group, index) => {
          const rows = rowsOf(group);
          const isActive = group.id === activeId;
          return (
            <li
              className={cn('group/row flex items-center gap-2 px-3 py-2', isActive ? 'bg-muted' : 'hover:bg-muted/50')}
              key={group.id}
            >
              <button
                aria-current={isActive ? 'true' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onClick={() => onSelect(group.id)}
                title="Build this group, and go to it on the map"
                type="button"
              >
                <span
                  aria-hidden
                  className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-background text-[11px] font-semibold shadow-sm"
                  style={{ backgroundColor: group.color, color: '#fff', textShadow: '0 0 2px rgba(0,0,0,0.6)' }}
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', isActive && 'font-semibold')}>{group.name}</span>
                  {editingBy?.get(group.id)?.length ? (
                    <span className="text-info block truncate text-xs font-medium" title="Building this group now">
                      {editingBy.get(group.id)!.join(', ')} {editingBy.get(group.id)!.length === 1 ? 'is' : 'are'} building it
                    </span>
                  ) : null}
                  <GroupDrive
                    group={group}
                    minutesPerProperty={minutesPerProperty}
                    straightMiles={routeMiles(rows)}
                    view={routeViews.get(group.id)}
                  />
                </span>
              </button>
              <Button
                aria-label={`Optimize the route of ${group.name}`}
                disabled={group.stops.length < 2 || ordering.has(group.id)}
                onClick={() => onOptimize(group.id)}
                size="icon-sm"
                title="Optimize route: the best start, order and finish for the least driving"
                variant="ghost"
              >
                {ordering.has(group.id) ? <Spinner /> : <RouteIcon />}
              </Button>
              <Button
                aria-label={`Change ${group.name}`}
                onClick={() => setForm({ mode: 'edit', group })}
                size="icon-sm"
                title="Rename, change colour or size"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              <Button aria-label={`Delete ${group.name}`} onClick={() => setDeleting(group)} size="icon-sm" title="Delete" variant="ghost">
                <Trash2Icon />
              </Button>
            </li>
          );
        })}
      </ul>

      {active ? (
        <section aria-label={`Stops of ${active.name}`} className="flex max-h-[45%] min-h-0 flex-col border-t">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ backgroundColor: active.color }} />
              <span className="truncate">{active.name}</span>
              {active.stops.length >= active.target ? <Badge variant="warning">Group full</Badge> : null}
            </p>
            {active.stops.length >= active.target ? (
              <Button onClick={() => onRaiseTarget(active.id)} size="sm" variant="outline">
                +1 more
              </Button>
            ) : (
              <span className="text-muted-foreground shrink-0 text-xs">Click properties to add</span>
            )}
          </div>
          {/* Click the properties in any order, then this: the best start, the
              best order and the best finish, by real drive times. */}
          <div className="grid gap-1 px-3 pb-2">
            <Button
              className="w-full"
              disabled={active.stops.length < 2 || ordering.has(active.id)}
              onClick={() => onOptimize(active.id)}
              size="sm"
              title="Work out the best stop to start at, the best order and the best stop to finish at, for the least driving, from Mapbox drive times."
            >
              {ordering.has(active.id) ? <Spinner /> : <RouteIcon />}
              {ordering.has(active.id) ? 'Finding the best route…' : 'Optimize route'}
            </Button>
            <span className="text-muted-foreground text-xs">
              {autoOrder
                ? 'Optimized again after every click.'
                : 'Click the properties in any order, then optimize: it picks the start, the order and the finish.'}
            </span>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {active.stops.length === 0 ? (
              <li className="text-muted-foreground px-1 py-2 text-xs">No stops yet: click an ungrouped property on the map.</li>
            ) : null}
            {active.stops.map((rowNumber, index) => {
              const row = byRow.get(rowNumber);
              return (
                <li
                  className={cn(
                    'flex items-center gap-1.5 rounded px-1 py-1 text-sm',
                    dragOver === index && dragFrom !== null && dragFrom !== index && 'bg-accent',
                    dragFrom === index && 'opacity-50',
                  )}
                  draggable
                  key={rowNumber}
                  onDragEnd={() => {
                    setDragFrom(null);
                    setDragOver(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragOver(index);
                  }}
                  onDragStart={(event) => {
                    setDragFrom(index);
                    event.dataTransfer.effectAllowed = 'move';
                    // Firefox starts no drag without data.
                    event.dataTransfer.setData('text/plain', String(index));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    drop(index);
                  }}
                >
                  <GripVerticalIcon aria-hidden className="text-muted-foreground size-4 shrink-0 cursor-grab" />
                  <span className="w-5 shrink-0 text-right text-xs font-semibold tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={row ? `${row.address}${row.city ? `, ${row.city}` : ''}` : undefined}>
                      {row ? `${row.address}${row.unit ? `, ${row.unit}` : ''}` : `Row ${rowNumber}`}
                      {row?.city ? <span className="text-muted-foreground">, {row.city}</span> : null}
                    </span>
                    {index > 0 ? <LegLine index={index - 1} view={routeViews.get(active.id)} /> : null}
                  </span>
                  {/* The same moves without a mouse. */}
                  <Button
                    aria-label="Earlier"
                    className="size-6"
                    disabled={index === 0}
                    onClick={() => onReorder(active.id, index, index - 1)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronUpIcon />
                  </Button>
                  <Button
                    aria-label="Later"
                    className="size-6"
                    disabled={index === active.stops.length - 1}
                    onClick={() => onReorder(active.id, index, index + 1)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <ChevronDownIcon />
                  </Button>
                  <Button aria-label="Take out of the group" className="size-6" onClick={() => onRemoveStop(rowNumber)} size="icon-sm" variant="ghost">
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ol>
        </section>
      ) : state.groups.length ? (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">Pick a group above to build it.</p>
      ) : null}

      {form ? (
        <GroupForm
          initial={
            form.mode === 'edit'
              ? { name: form.group.name, color: form.group.color, target: form.group.target }
              : { name: nextGroupName(state), color: nextGroupColor(state), target: DEFAULT_TARGET }
          }
          used={
            new Map(
              state.groups
                .filter((group) => form.mode !== 'edit' || group.id !== form.group.id)
                .map((group) => [group.color.toLowerCase(), group.name] as const),
            )
          }
          taken={state.groups.filter((group) => form.mode !== 'edit' || group.id !== form.group.id).map((group) => group.name)}
          // A fresh form each time it opens, not the last one's leftovers.
          key={form.mode === 'edit' ? form.group.id : 'new'}
          onOpenChange={(open) => !open && setForm(null)}
          onSubmit={(fields) => {
            if (form.mode === 'edit') onUpdate(form.group.id, fields);
            else onCreate(fields);
            setForm(null);
          }}
          open
          submitLabel={form.mode === 'edit' ? 'Save' : 'Create group'}
          title={form.mode === 'edit' ? `Change ${form.group.name}` : 'New group'}
        />
      ) : null}

      <AlertDialog onOpenChange={(open) => !open && setDeleting(null)} open={Boolean(deleting)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.stops.length
                ? `Its ${deleting.stops.length} ${deleting.stops.length === 1 ? 'property goes' : 'properties go'} back to ungrouped.`
                : 'It has no properties yet.'}{' '}
              Undo (Ctrl+Z) brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) onDelete(deleting.id);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
