'use client';

import { FileSpreadsheetIcon, XIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { formatRelative } from '@/lib/format';
import { useGroupFileOnServer } from '@/lib/planning-queries';
import { cn } from '@/lib/utils';

import { readGroupFile, type GroupFile, type GroupOrder } from './group-file';
import { GroupFileLegend } from './group-file-legend';
import type { MapFrame } from './group-file-map';
import {
  DEFAULT_MINUTES_PER_PROPERTY,
  EMPTY_STATE,
  fingerprints,
  fromFile,
  fromSaved,
  propertiesOf,
  readSaved,
  writeSaved,
  type ManualState,
  type SavedGrouping,
} from './manual-grouping';
import { ManualGroupingView } from './manual-grouping-view';
import { useRoadRoutes, type RouteRequest } from './road-routes';
import { zoneTerritories } from './zone-territories';

const NO_REQUESTS: RouteRequest[] = [];

/** Mapbox measures its container, so the map is client-only like every other map here. */
const GroupFileMap = dynamic(() => import('./group-file-map').then((module) => module.GroupFileMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-lg" />,
});

/** What the groups map draws besides the pins, as the switches above it set it. */
export interface MapDisplay {
  /** Each group's route, stop to stop. */
  lines: boolean;
  /** Along the roads (the default) or straight from stop to stop. */
  road: boolean;
  /** The straight-edged outline around each group: off unless asked for (the office, 2026-09-30). */
  outlines: boolean;
  /** Each zone's ground and fence (the office, 2026-09-30). */
  zones: boolean;
  /** Each leg's drive time on the map (the office, 2026-09-30). */
  legTimes: boolean;
}

export const DEFAULT_MAP_DISPLAY: MapDisplay = { lines: true, road: true, outlines: false, zones: true, legTimes: true };

/** The switches for what the groups map draws: the file's view and the Group maker share them. */
export function MapDisplaySwitches({ display, onChange }: { display: MapDisplay; onChange: (next: MapDisplay) => void }) {
  const set = (changes: Partial<MapDisplay>) => onChange({ ...display, ...changes });
  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Switch aria-label="Route lines" checked={display.lines} onCheckedChange={(lines) => set({ lines })} />
        Route lines
      </label>
      <label
        className="flex cursor-pointer items-center gap-2 text-sm"
        title="The straight-edged outline around each group, in its colour"
      >
        <Switch aria-label="Group outlines" checked={display.outlines} onCheckedChange={(outlines) => set({ outlines })} />
        Group outlines
      </label>
      <label
        className="flex cursor-pointer items-center gap-2 text-sm"
        title="Each zone's ground: every spot within 3 km of a property goes to the zone of the property nearest it"
      >
        <Switch aria-label="Zones" checked={display.zones} onCheckedChange={(zones) => set({ zones })} />
        Zones
      </label>
      <label
        className="flex cursor-pointer items-center gap-2 text-sm"
        title="The drive time from each stop to the next, on the map: for the groups ticked, and for every group on screen once zoomed in"
      >
        <Switch aria-label="Leg times" checked={display.legTimes} onCheckedChange={(legTimes) => set({ legTimes })} />
        Leg times
      </label>
      <div aria-label="How the routes are drawn" className="bg-muted inline-flex rounded-md p-0.5" role="group">
        {([true, false] as const).map((alongRoads) => (
          <button
            aria-pressed={display.road === alongRoads}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50',
              display.road === alongRoads ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
            disabled={!display.lines}
            key={String(alongRoads)}
            onClick={() => set({ road: alongRoads })}
            title={alongRoads ? 'The drive along the roads, from Mapbox' : 'Straight from stop to stop, as the crow flies'}
            type="button"
          >
            {alongRoads ? 'Road routes' : 'Straight lines'}
          </button>
        ))}
      </div>
    </>
  );
}

/** A groups file, read, with the name it was chosen under. */
export interface LoadedGroupFile {
  name: string;
  /** The server's `data/` folder, or a file chosen in this browser. Said beside the name. */
  source: 'server' | 'browser';
  /** When it was chosen, or last changed on the server: a new one is a fresh start. */
  loadedAt: number;
  file: GroupFile;
}

/** A file's text, read -- or, when it cannot be drawn at all, why not in a line. */
export function loadGroupFile(
  name: string,
  text: string,
  source: LoadedGroupFile['source'],
  loadedAt: number,
): { loaded: LoadedGroupFile } | { problem: string } {
  const file = readGroupFile(text);
  if (file.missing.length) return { problem: `${name} has no ${file.missing.join(' or ')} column` };
  if (!file.groups.length && !file.ungrouped.length) return { problem: `${name} has no row with a position` };
  return { loaded: { name, source, loadedAt, file } };
}

/**
 * Which groups file the Groups tab shows: one chosen in this browser, or else
 * the server's.
 *
 * The server's is the default (the office, 2026-09-30: "load this file by
 * default"), so the tab opens on it with nothing to choose. Going back to the
 * quarter's days is remembered while the page is open, so the default does not
 * reappear on the next render; a file chosen here wins until the page is left.
 */
export function useGroupFileChoice(enabled: boolean) {
  const server = useGroupFileOnServer(enabled);
  const [chosen, setChosen] = useState<LoadedGroupFile | null>(null);
  const [closed, setClosed] = useState(false);
  const fromServer = useMemo(
    () =>
      server.data
        ? loadGroupFile(server.data.fileName, server.data.csv, 'server', Date.parse(server.data.modifiedAt))
        : null,
    [server.data],
  );
  const serverFile = fromServer && 'loaded' in fromServer ? fromServer.loaded : null;

  return {
    shown: chosen ?? (closed ? null : serverFile),
    serverFile,
    /** The server's file is there but cannot be drawn: said, rather than silently not opening. */
    serverProblem: fromServer && 'problem' in fromServer ? fromServer.problem : null,
    choose: (loaded: LoadedGroupFile) => {
      setChosen(loaded);
      setClosed(false);
    },
    close: () => {
      setChosen(null);
      setClosed(true);
    },
    showServerFile: () => {
      setChosen(null);
      setClosed(false);
    },
  };
}

/**
 * Chooses a groups file and reads it, in this browser.
 *
 * The office's Details sheet is read the same way. The file holds tenants'
 * names and home addresses, so it is never uploaded: it is read here, drawn
 * here, and gone when the page is. To see a newer file, choose it again.
 */
export function GroupFilePicker({
  label,
  onLoad,
  variant = 'outline',
}: {
  label: string;
  onLoad: (loaded: LoadedGroupFile) => void;
  variant?: 'outline' | 'ghost';
}) {
  const input = useRef<HTMLInputElement>(null);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    // Cleared, so choosing the same file again after replacing it on disk reads it again.
    event.target.value = '';
    if (!chosen) return;
    const read = loadGroupFile(chosen.name, await chosen.text(), 'browser', Date.now());
    if ('problem' in read) {
      toast.error(read.problem, {
        description: 'A groups file needs group, address, latitude and longitude columns, named in its first row.',
      });
      return;
    }
    const { file } = read.loaded;
    if (file.skippedRows.length)
      toast.warning(
        `${file.skippedRows.length.toLocaleString()} ${file.skippedRows.length === 1 ? 'row is' : 'rows are'} not on the map`,
        {
          description: `No group, or no latitude and longitude: row${file.skippedRows.length === 1 ? '' : 's'} ${file.skippedRows.join(', ')} of ${chosen.name}.`,
        },
      );
    onLoad(read.loaded);
  };

  return (
    <>
      <input
        accept=".csv,text/csv"
        aria-label="A groups file, as CSV"
        className="hidden"
        onChange={(event) => void choose(event)}
        ref={input}
        type="file"
      />
      <Button onClick={() => input.current?.click()} size="sm" variant={variant}>
        <FileSpreadsheetIcon />
        {label}
      </Button>
    </>
  );
}

/**
 * A groups file on the map, with its groups listed beside it.
 *
 * Keyed on the file by the page, so a newly chosen file starts with every
 * group shown and the route lines on.
 */
export function GroupFileView({
  loaded,
  onLoad,
  onClose,
}: {
  loaded: LoadedGroupFile;
  onLoad: (loaded: LoadedGroupFile) => void;
  onClose: () => void;
}) {
  const { file } = loaded;
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [display, setDisplay] = useState<MapDisplay>(DEFAULT_MAP_DISPLAY);
  const { lines, road, outlines: showOutlines, zones: showZones, legTimes: showLegTimes } = display;
  const [order, setOrder] = useState<GroupOrder>('number');
  /** Manual grouping, and the work it opened on; null for the file's own view. */
  const [manual, setManual] = useState<{
    key: number;
    state: ManualState;
    activeId: string | null;
    minutesPerProperty: number;
    autoOrder: boolean;
  } | null>(null);
  /** The start choice being offered, with any saved work to resume; false when it is not. */
  const [starting, setStarting] = useState<{ saved: SavedGrouping | null } | false>(false);
  const shown = useMemo(
    () => (picked.size ? file.groups.filter((group) => picked.has(group.key)) : file.groups),
    [file.groups, picked],
  );
  const approximate = [...file.groups.flatMap((group) => group.rows), ...file.ungrouped].filter((row) => row.approximate).length;
  const properties = useMemo(() => propertiesOf(file), [file]);
  const prints = useMemo(() => fingerprints(properties), [properties]);
  /**
   * The zones, from every property in the file whether grouped or not: a zone
   * is the tenancy's, not the group's, so it reads the same in both views.
   * Worked out only while shown -- a few hundred thousand squares.
   */
  const zones = useMemo(() => (showZones ? zoneTerritories(properties) : []), [properties, showZones]);

  /**
   * Every group's road route, for its line on the map and its drive in the
   * list -- asked for while the file's own view is showing; manual grouping
   * asks for its own groups.
   */
  const fileRoutes = useMemo<RouteRequest[]>(
    () =>
      file.groups.map((group) => ({
        id: group.key,
        coordinates: group.rows.map((row) => [row.longitude, row.latitude]),
      })),
    [file.groups],
  );
  const routeViews = useRoadRoutes(manual ? NO_REQUESTS : fileRoutes);

  /**
   * What the map frames: the groups shown, and the ungrouped properties with
   * them when nothing is picked. Keyed on the file and the ticks, so it moves
   * when the reader asks for different groups and never because anything
   * merely re-rendered.
   */
  const frame = useMemo<MapFrame>(
    () => ({
      key: `${loaded.loadedAt}:${[...picked].sort().join(',')}`,
      points: [
        ...shown.flatMap((group) => group.outline.map(([longitude, latitude]) => ({ latitude, longitude }))),
        ...(picked.size ? [] : file.ungrouped),
      ],
    }),
    [file.ungrouped, loaded.loadedAt, picked, shown],
  );

  /**
   * Back to manual grouping after a reload, when that is where it was left --
   * over this same file. Read after the first render: storage does not exist
   * during the server's, and reading it into the initial state would render
   * the page two different ways.
   */
  useEffect(() => {
    const saved = readSaved();
    if (!saved?.open || saved.fileName !== loaded.name) return;
    const restored = fromSaved(saved, prints);
    setManual({
      key: Date.now(),
      state: restored.state,
      activeId: restored.activeId,
      minutesPerProperty: restored.minutesPerProperty,
      autoOrder: restored.autoOrder,
    });
    if (restored.missing)
      toast.warning(`${restored.missing.toLocaleString()} saved stops are not in ${loaded.name}`, {
        description: 'They were left out of their groups.',
      });
  }, [loaded.name, prints]);

  const begin = (how: 'resume' | 'blank' | 'file') => {
    const saved = starting ? starting.saved : null;
    // A fresh start keeps the minutes per visit last used: it is a habit, not part of the work.
    const minutesPerProperty = saved?.minutesPerProperty ?? DEFAULT_MINUTES_PER_PROPERTY;
    const autoOrder = saved?.autoOrder ?? false;
    if (how === 'resume' && saved) {
      const restored = fromSaved(saved, prints);
      setManual({
      key: Date.now(),
      state: restored.state,
      activeId: restored.activeId,
      minutesPerProperty: restored.minutesPerProperty,
      autoOrder: restored.autoOrder,
    });
      if (restored.missing)
        toast.warning(`${restored.missing.toLocaleString()} saved stops are not in ${loaded.name}`, {
          description: 'They were left out of their groups.',
        });
    } else if (how === 'file') {
      const state = fromFile(file);
      setManual({ key: Date.now(), state, activeId: null, minutesPerProperty, autoOrder });
    } else setManual({ key: Date.now(), state: EMPTY_STATE, activeId: null, minutesPerProperty, autoOrder });
    setStarting(false);
  };

  /** Back to the file's own view. The work stays saved, to resume. */
  const leave = () => {
    setManual(null);
    const saved = readSaved();
    if (saved) writeSaved({ ...saved, open: false });
  };

  const toggle = (key: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 text-sm">
          <span className="font-medium break-all">{loaded.name}</span>
          <span className="text-muted-foreground">
            {' '}
            · {file.placed.toLocaleString()} {file.placed === 1 ? 'property' : 'properties'} in{' '}
            {file.groups.length.toLocaleString()} {file.groups.length === 1 ? 'group' : 'groups'}
            {file.ungrouped.length ? ` · ${file.ungrouped.length.toLocaleString()} in no group` : ''}
            {approximate ? ` · ${approximate.toLocaleString()} at an approximate location` : ''}
            {loaded.source === 'server'
              ? ' · from the server’s data folder'
              : ' · read in this browser and sent nowhere'}
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch
              aria-label="Manual grouping"
              checked={manual !== null}
              onCheckedChange={(on) => (on ? setStarting({ saved: readSaved() }) : leave())}
            />
            Manual grouping
          </label>
          <MapDisplaySwitches display={display} onChange={setDisplay} />
          <GroupFilePicker label="Choose another file" onLoad={onLoad} />
          <Button onClick={onClose} size="sm" variant="ghost">
            <XIcon />
            Back to the quarter&rsquo;s days
          </Button>
        </div>
      </div>

      {manual ? (
        <ManualGroupingView
          file={file}
          fileName={loaded.name}
          initial={manual}
          key={manual.key}
          lines={lines}
          road={road}
          showLegTimes={showLegTimes}
          showOutlines={showOutlines}
          zones={zones}
          prints={prints}
          properties={properties}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="h-80 lg:h-[36rem]">
            <GroupFileMap
              frame={frame}
              groups={shown}
              lines={lines}
              onPickGroup={(key) => setPicked(new Set([key]))}
              road={road}
              routeViews={routeViews}
              legTimes={showLegTimes ? picked : null}
              showOutlines={showOutlines}
              zones={zones}
              ungrouped={picked.size ? [] : file.ungrouped}
            />
          </div>
          <GroupFileLegend
            file={file}
            onOrder={setOrder}
            onShowAll={() => setPicked(new Set())}
            onToggle={toggle}
            order={order}
            picked={picked}
            routeViews={routeViews}
          />
        </div>
      )}

      <ManualStartDialog
        fileName={loaded.name}
        groups={file.groups.length}
        onChoose={begin}
        onOpenChange={(open) => !open && setStarting(false)}
        open={starting !== false}
        properties={properties.length}
        saved={starting ? starting.saved : null}
      />
    </div>
  );
}

/**
 * How manual grouping starts: from nothing, from the file's own groups, or --
 * when there is saved work -- where it was left.
 */
function ManualStartDialog({
  open,
  saved,
  fileName,
  groups,
  properties,
  onChoose,
  onOpenChange,
}: {
  open: boolean;
  saved: SavedGrouping | null;
  fileName: string;
  groups: number;
  properties: number;
  onChoose: (how: 'resume' | 'blank' | 'file') => void;
  onOpenChange: (open: boolean) => void;
}) {
  const savedStops = saved ? saved.groups.reduce((sum, group) => sum + group.stops.length, 0) : 0;
  const option = (how: 'resume' | 'blank' | 'file', title: string, detail: string) => (
    <button
      className="hover:bg-muted/60 focus-visible:ring-ring/50 grid gap-0.5 rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-[3px]"
      onClick={() => onChoose(how)}
      type="button"
    >
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </button>
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manual grouping</DialogTitle>
          <DialogDescription>
            Build route groups by clicking properties one at a time, each click the next stop. The work is saved in this
            browser as you go — as a fingerprint of each property, never its address or tenant.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {saved && saved.groups.length
            ? option(
                'resume',
                'Resume saved work',
                `${saved.groups.length.toLocaleString()} ${saved.groups.length === 1 ? 'group' : 'groups'}, ${savedStops.toLocaleString()} properties grouped, saved ${formatRelative(saved.savedAt)}${
                  saved.fileName === fileName ? '' : ` on ${saved.fileName}`
                }.`,
              )
            : null}
          {option(
            'blank',
            'Start blank',
            `All ${properties.toLocaleString()} properties ungrouped.${saved?.groups.length ? ' Replaces the saved work.' : ''}`,
          )}
          {option(
            'file',
            'Start from current file',
            `The ${groups.toLocaleString()} groups in ${fileName}, to edit.${saved?.groups.length ? ' Replaces the saved work.' : ''}`,
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
