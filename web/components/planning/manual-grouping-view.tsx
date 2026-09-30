'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';

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
import { Skeleton } from '@/components/ui/skeleton';

import type { GroupFile, GroupFileRow } from './group-file';
import type { MapFrame } from './group-file-map';
import {
  clickIntent,
  DEFAULT_MINUTES_PER_PROPERTY,
  drawnGroups,
  exportCsv,
  historyReducer,
  newGroupId,
  toSaved,
  writeSaved,
  type ManualEdit,
  type ManualGroup,
  type ManualState,
} from './manual-grouping';
import { ManualGroupingPanel, type GroupFields } from './manual-grouping-panel';
import {
  formatDrive,
  getRouteStore,
  routeKey,
  useRoadRoutes,
  type LngLat,
  type RoadRoute,
  type RouteRequest,
} from './road-routes';
import { fastestOrder, getMatrixSource, pathSeconds } from './route-order';
import type { ZoneTerritory } from './zone-territories';

/** How long after the last change to a group its stops are put in order: clicking five in a row orders once. */
const ORDER_DEBOUNCE_MS = 600;

/** Mapbox measures its container, so the map is client-only like every other map here. */
const GroupFileMap = dynamic(() => import('./group-file-map').then((module) => module.GroupFileMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-lg" />,
});

/** Where a click would take a property from, to be confirmed first. */
interface PendingMove {
  row: GroupFileRow;
  from: ManualGroup;
  to: ManualGroup;
}

/** A keystroke meant for a text box is the text box's: its own undo, not the map's. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Manual grouping on the Groups map: the office builds route groups by
 * clicking properties one at a time, each click the next stop, the route
 * drawing as it goes (2026-09-30).
 *
 * Every change goes through one history, so Ctrl+Z and Ctrl+Shift+Z undo and
 * redo adds, removals and moves alike -- and the rest (a new group, a rename, a
 * reorder), because a history that skipped some changes would undo the wrong
 * one. Saved on every change, as fingerprints rather than addresses.
 */
export function ManualGroupingView({
  file,
  fileName,
  properties,
  prints,
  initial,
  lines,
  road,
  showOutlines,
  showLegTimes,
  zones,
  persist = true,
  onChange,
}: {
  file: GroupFile;
  fileName: string;
  /** Every property in the file, by row number. */
  properties: readonly GroupFileRow[];
  prints: ReadonlyMap<number, string>;
  initial: { state: ManualState; activeId: string | null; minutesPerProperty?: number; autoOrder?: boolean };
  lines: boolean;
  /** Along the roads where routed, rather than straight from stop to stop. */
  road: boolean;
  /** The straight-edged outline around each group. */
  showOutlines: boolean;
  /** Each zone's ground and fence, when shown. */
  zones: readonly ZoneTerritory[];
  /** Each leg's drive time on the map. */
  showLegTimes: boolean;
  /**
   * Save the work in this browser as it changes, as fingerprints. Off in the
   * Group maker, whose work is saved to the server as a template instead.
   */
  persist?: boolean;
  /** Told the groups and the minutes per property whenever either changes. */
  onChange?: (snapshot: { state: ManualState; minutesPerProperty: number }) => void;
}) {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: initial.state,
    future: [],
  }));
  const state = history.present;
  const [chosenId, setChosenId] = useState<string | null>(initial.activeId);
  const [dimOthers, setDimOthers] = useState(false);
  /** Minutes at each property, for the estimated day. Saved with the work. */
  const [minutesPerProperty, setMinutesPerProperty] = useState(initial.minutesPerProperty ?? DEFAULT_MINUTES_PER_PROPERTY);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  /**
   * Optimize a group's route again every time a stop is added or taken out.
   * Off unless chosen: the office clicks a group's properties in any order and
   * then asks for the best route with the button (2026-09-30), and stop numbers
   * that jump on every click would be in the way. Saved with the work.
   */
  const [autoOrder, setAutoOrder] = useState(initial.autoOrder ?? false);
  /** Groups whose order is being worked out. */
  const [ordering, setOrdering] = useState<ReadonlySet<string>>(() => new Set());
  const [frame, setFrame] = useState<MapFrame>(() => ({ key: 'manual:all', points: properties }));

  // An undo can take away the group being built; then nothing is.
  const activeId = chosenId && state.groups.some((group) => group.id === chosenId) ? chosenId : null;

  const byRow = useMemo(() => new Map(properties.map((row) => [row.rowNumber, row])), [properties]);
  const groups = useMemo(() => drawnGroups(state, byRow), [state, byRow]);
  const ungrouped = useMemo(() => {
    const placed = new Set(state.groups.flatMap((group) => group.stops));
    return properties.filter((row) => !placed.has(row.rowNumber));
  }, [properties, state]);

  const edit = useCallback((change: ManualEdit) => dispatch({ type: 'edit', edit: change }), []);

  /** The state as it is now, for work that finishes after a render. */
  const latest = useRef(state);
  latest.current = state;
  const orderTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = orderTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  /**
   * Put a group's stops in the order with the least driving: the best stop to
   * start at, the best to go to next, the best to end at.
   *
   * The drive times come from Mapbox's Matrix API -- every stop to every
   * other, one way -- and the order is worked out from them here. Nothing
   * changes if the group changed while the times were on their way: an order
   * for other stops is not this group's. After a click (`auto`) the new order
   * is part of that click, so one undo takes back both; from the button it is
   * a step of its own, and says what it saved.
   */
  const optimize = useCallback(
    async (id: string, how: 'auto' | 'button') => {
      const group = latest.current.groups.find((entry) => entry.id === id);
      if (!group) return;
      const snapshot = group.stops;
      const coordinates = snapshot.flatMap((row) => {
        const property = byRow.get(row);
        return property ? [[property.longitude, property.latitude] as LngLat] : [];
      });
      if (snapshot.length < 2 || coordinates.length !== snapshot.length) {
        if (how === 'button')
          toast.info(`${group.name} has nothing to optimize yet`, { description: 'Add at least two properties first.' });
        return;
      }
      setOrdering((current) => new Set(current).add(id));
      try {
        const durations = await getMatrixSource().durations(coordinates);
        const order = fastestOrder(durations);
        const now = latest.current.groups.find((entry) => entry.id === id);
        if (!now || now.stops.length !== snapshot.length || now.stops.some((row, index) => row !== snapshot[index])) return;
        const stops = order.map((index) => snapshot[index]!);
        const unchanged = order.every((stop, index) => stop === index);
        if (!unchanged)
          dispatch({ type: 'edit', edit: { type: 'order', id, stops }, amend: how === 'auto' });
        if (how !== 'button') return;

        /**
         * Said in the road route's own times, the ones the panel shows. The
         * pairwise times the order is worked out from come from the same
         * roads but are timed a little differently, and two figures for one
         * drive would only raise the question of which is right.
         */
        const store = getRouteStore();
        const coordinatesOf = (rows: readonly number[]) =>
          rows.map((row) => coordinates[snapshot.indexOf(row)]!);
        const drive = async (rows: readonly number[]) => {
          const points = coordinatesOf(rows);
          return (await store.ensure(routeKey(points), points)).durationS;
        };
        const [before, after] = await Promise.all([drive(snapshot), drive(stops)]).catch(() => [
          pathSeconds(durations, snapshot.map((_, index) => index)),
          pathSeconds(durations, order),
        ]);
        if (unchanged)
          toast.success(`${group.name} is already the fastest route`, {
            description: `${formatDrive(before)} of driving through its ${snapshot.length} stops.`,
          });
        else
          toast.success(`${group.name}: optimized route`, {
            description: `${formatDrive(before)} → ${formatDrive(after)} of driving${
              after < before ? ` (${formatDrive(before - after)} saved)` : ''
            }. The start, the order and the finish are chosen for the shortest drive.`,
          });
      } catch (error) {
        toast.warning(`${group.name}: the route could not be optimized`, {
          description: error instanceof Error ? error.message : 'Mapbox did not answer.',
        });
      } finally {
        setOrdering((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [byRow],
  );

  /** After a stop is added, moved or taken out: order those groups again, once the clicking stops. */
  const orderSoon = useCallback(
    (...ids: string[]) => {
      if (!autoOrder) return;
      for (const id of ids) {
        clearTimeout(orderTimers.current.get(id));
        orderTimers.current.set(
          id,
          setTimeout(() => {
            orderTimers.current.delete(id);
            void optimize(id, 'auto');
          }, ORDER_DEBOUNCE_MS),
        );
      }
    },
    [autoOrder, optimize],
  );

  /**
   * Each group's road route, asked for 600ms after its stops last changed and
   * kept by the exact stops in order, so an unchanged group is never asked for
   * again. Keyed by group id, which is also the map's key for the group.
   */
  const routeRequests = useMemo<RouteRequest[]>(
    () =>
      state.groups.map((group) => ({
        id: group.id,
        coordinates: group.stops.flatMap((row) => {
          const property = byRow.get(row);
          return property ? [[property.longitude, property.latitude] as [number, number]] : [];
        }),
      })),
    [byRow, state.groups],
  );
  const routeViews = useRoadRoutes(routeRequests);
  /** The group being built has its legs' drive times on the map at any zoom. */
  const legTimeGroups = useMemo<ReadonlySet<string> | null>(
    () => (showLegTimes ? new Set(activeId ? [activeId] : []) : null),
    [activeId, showLegTimes],
  );

  // Saved on every change, so a reload loses nothing.
  useEffect(() => {
    if (persist) writeSaved(toSaved(state, activeId, prints, fileName, true, { minutesPerProperty, autoOrder }));
  }, [activeId, autoOrder, fileName, minutesPerProperty, persist, prints, state]);

  /** The newest listener, so a parent's new function each render is not a change of its own. */
  const listener = useRef(onChange);
  listener.current = onChange;
  useEffect(() => {
    listener.current?.({ state, minutesPerProperty });
  }, [minutesPerProperty, state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || typing(event.target)) return;
      const key = event.key.toLowerCase();
      const redo = (key === 'z' && event.shiftKey) || key === 'y';
      if (key !== 'z' && !redo) return;
      event.preventDefault();
      dispatch({ type: redo ? 'redo' : 'undo' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const raiseTarget = useCallback(
    (id: string) => {
      const group = state.groups.find((entry) => entry.id === id);
      if (group) edit({ type: 'update', id, changes: { target: Math.max(group.target, group.stops.length) + 1 } });
    },
    [edit, state.groups],
  );

  /** Make a group the one being built, and go to it. */
  const select = useCallback(
    (id: string) => {
      setChosenId(id);
      const rows = state.groups.find((group) => group.id === id)?.stops.flatMap((row) => byRow.get(row) ?? []) ?? [];
      if (rows.length) setFrame({ key: `manual:${id}:${Date.now()}`, points: rows });
    },
    [byRow, state.groups],
  );

  const onRowClick = useCallback(
    (row: GroupFileRow) => {
      const intent = clickIntent(state, activeId, row.rowNumber);
      switch (intent.kind) {
        case 'no-active':
          toast.info('Pick a group to build first', {
            description: 'Choose one in the list, or make one with New group.',
          });
          return;
        case 'remove':
          edit({ type: 'remove', row: row.rowNumber });
          orderSoon(intent.group.id);
          return;
        case 'full':
          toast.warning(`${intent.group.name} is full`, {
            description: `It holds ${intent.group.target}. Raise it by one to add ${row.address || 'this property'}.`,
            action: { label: '+1 more', onClick: () => raiseTarget(intent.group.id) },
          });
          return;
        case 'move':
          setPendingMove({ row, from: intent.from, to: intent.to });
          return;
        case 'add':
          edit({ type: 'add', id: intent.group.id, row: row.rowNumber });
          orderSoon(intent.group.id);
      }
    },
    [activeId, edit, orderSoon, raiseTarget, state],
  );

  const create = (fields: GroupFields) => {
    const id = newGroupId();
    edit({ type: 'create', group: { id, ...fields, stops: [] } });
    setChosenId(id);
  };

  const download = async () => {
    // The drive columns come from the road routes: any still on their way are
    // waited for, so a quick export is not a file of blanks.
    const store = getRouteStore();
    const pending = routeRequests.filter((request) => request.coordinates.length >= 2);
    const waiting = pending.filter((request) => store.view(routeKey(request.coordinates))?.status !== 'ok');
    const toastId = waiting.length
      ? toast.loading(`Waiting for ${waiting.length} road ${waiting.length === 1 ? 'route' : 'routes'}…`)
      : undefined;
    const settled = await Promise.allSettled(
      pending.map((request) => store.ensure(routeKey(request.coordinates), request.coordinates)),
    );
    if (toastId !== undefined) toast.dismiss(toastId);
    const routes = new Map<string, RoadRoute>();
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') routes.set(pending[index]!.id, result.value);
    });
    const unrouted = pending.length - routes.size;
    const csv = exportCsv(file, state, properties, { routes, minutesPerProperty });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    link.href = url;
    link.download = `tbp-groups-manual-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('Exported', {
      description: `${
        unrouted ? `${unrouted} ${unrouted === 1 ? 'group has' : 'groups have'} no road route, so their drive columns are blank. ` : ''
      }It names tenants: keep it in data/, which git leaves alone. Choose another file loads it back.`,
    });
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="h-80 lg:h-[36rem]">
        <GroupFileMap
          frame={frame}
          groups={groups}
          lines={lines}
          manual={{ activeKey: activeId, dimOthers, onRowClick }}
          onPickGroup={select}
          road={road}
          routeViews={routeViews}
          showOutlines={showOutlines}
          zones={zones}
          legTimes={legTimeGroups}
          slowLegs
          ungrouped={ungrouped}
        />
      </div>

      <ManualGroupingPanel
        activeId={activeId}
        byRow={byRow}
        canRedo={history.future.length > 0}
        canUndo={history.past.length > 0}
        dimOthers={dimOthers}
        minutesPerProperty={minutesPerProperty}
        onCreate={create}
        onDelete={(id) => edit({ type: 'delete', id })}
        onDimOthers={setDimOthers}
        onExport={() => void download()}
        onMinutesPerProperty={setMinutesPerProperty}
        onRaiseTarget={raiseTarget}
        onRedo={() => dispatch({ type: 'redo' })}
        onRemoveStop={(row) => {
          const owner = state.groups.find((group) => group.stops.includes(row));
          edit({ type: 'remove', row });
          if (owner) orderSoon(owner.id);
        }}
        autoOrder={autoOrder}
        onAutoOrder={setAutoOrder}
        onOptimize={(id) => void optimize(id, 'button')}
        ordering={ordering}
        onReorder={(id, from, to) => edit({ type: 'reorder', id, from, to })}
        onSelect={select}
        onUndo={() => dispatch({ type: 'undo' })}
        onUpdate={(id, fields) => edit({ type: 'update', id, changes: fields })}
        routeViews={routeViews}
        state={state}
        total={properties.length}
      />

      <AlertDialog onOpenChange={(open) => !open && setPendingMove(null)} open={Boolean(pendingMove)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to {pendingMove?.to.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingMove
                ? `${pendingMove.row.address || 'This property'} is stop ${
                    pendingMove.from.stops.indexOf(pendingMove.row.rowNumber) + 1
                  } of ${pendingMove.from.name}. It becomes the next stop of ${pendingMove.to.name}, and ${
                    pendingMove.from.name
                  }'s stops after it move up one.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Leave it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingMove) {
                  edit({ type: 'add', id: pendingMove.to.id, row: pendingMove.row.rowNumber });
                  orderSoon(pendingMove.to.id, pendingMove.from.id);
                }
                setPendingMove(null);
              }}
            >
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
