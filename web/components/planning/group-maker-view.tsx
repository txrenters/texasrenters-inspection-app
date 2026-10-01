'use client';

import {
  applyGroupOps,
  diffGroupOps,
  mapOpStops,
  type GroupTemplateEditor,
  type GroupTemplateOp,
} from '@texasrenters/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, PlusIcon, ShapesIcon, StarIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api';
import { useAuth, usePermissions } from '@/lib/auth';
import {
  planningKeys,
  postGroupTemplateOps,
  readGroupTemplate,
  useGroupMakerProperties,
  useGroupTemplate,
  useGroupTemplateMutations,
  useGroupTemplates,
  type GroupTemplateInput,
} from '@/lib/planning-queries';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

import {
  DEFAULT_MAP_DISPLAY,
  GroupFilePicker,
  MapDisplaySwitches,
  type LoadedGroupFile,
  type MapDisplay,
} from './group-file-view';
import {
  liveGroupsOf,
  liveGroupsOfTemplate,
  makerProperties,
  missingStopLines,
  rowsToMatch,
  stateFromMatchedFile,
  stateFromTemplate,
  templateInput,
  visibleGroups,
} from './group-maker';
import { DEFAULT_MINUTES_PER_PROPERTY, type ManualState } from './manual-grouping';
import { ManualGroupingView, type ManualLiveControls } from './manual-grouping-view';
import { TemplateSync, type SyncStatus } from './template-sync';
import { useTemplateLive } from './use-template-live';
import { zoneTerritories } from './zone-territories';

/** The template open for editing. */
interface Editor {
  /** Remounts the map and its history when a different template opens. */
  key: string;
  templateId: string;
  name: string;
  initial: { state: ManualState; activeId: null; minutesPerProperty: number };
}

/** How a new template starts. */
type StartFrom = 'blank' | 'copy' | 'file';

/** How long after the last keystroke a template's new name goes out. */
const NAME_DEBOUNCE_MS = 600;

/** The server saying no -- archived, refused, not found -- rather than the network failing: said once, not retried. */
function refusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status) ? error.message : null;
}

/** "Maria Santos" as "MS", for the little badges of who else is here. */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/**
 * The TBP Property Group maker (the office, 2026-09-30): "once we create all
 * the groupings we can then save it as template for the TBP".
 *
 * The manual grouping tool, over every enrolled property the database holds
 * rather than a file, saved to the server as a group template. Live since
 * 2026-10-01 ("if someone logged in and they are working also for the same
 * template I want to see the changes real time"): every change is saved as it
 * is made and appears at once for everyone else with the template open, who
 * are shown with the group each is building. There is no Save button any more.
 */
export function GroupMakerView() {
  const { has } = usePermissions();
  const { profile } = useAuth();
  const canChange = has('planning:publish');
  const client = useQueryClient();
  const [url, setUrl] = useUrlState({ template: '' });
  const properties = useGroupMakerProperties();
  const templates = useGroupTemplates();
  const mutations = useGroupTemplateMutations();

  const made = useMemo(() => (properties.data ? makerProperties(properties.data.properties) : null), [properties.data]);
  const listed = templates.data;
  const usable = useMemo(() => (listed ?? []).filter((template) => !template.archivedAt), [listed]);
  /** The one in the address, else the active one, else the newest. */
  const openId =
    url.template && (!listed || usable.some((template) => template.id === url.template))
      ? url.template
      : (usable.find((template) => template.isActive) ?? usable[0])?.id ?? null;
  const open = usable.find((template) => template.id === openId) ?? null;
  const detail = useGroupTemplate(openId);

  const [display, setDisplay] = useState<MapDisplay>(DEFAULT_MAP_DISPLAY);
  const zones = useMemo(() => (display.zones && made ? zoneTerritories(made.rows) : []), [display.zones, made]);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [status, setStatus] = useState<SyncStatus>({ kind: 'saved' });
  const [editors, setEditors] = useState<GroupTemplateEditor[]>([]);

  /** The live copy: what goes out, what comes in, and what this browser last showed. */
  const engine = useRef<TemplateSync | null>(null);
  const controls = useRef<ManualLiveControls | null>(null);
  /** The groups as the view last reported or was given them, in its row numbers. */
  const lastKnown = useRef<ManualState>({ groups: [] });
  const minutes = useRef(DEFAULT_MINUTES_PER_PROPERTY);
  /** Whether the view has reported once: before it has, changes wait for it. */
  const viewReady = useRef(false);
  const waiting = useRef<GroupTemplateOp<string>[][]>([]);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Somebody else's batch, or the one that catches this copy up, made to what this person sees. */
  const applyToView = useCallback(
    (ops: GroupTemplateOp<string>[]) => {
      if (!made) return;
      if (!viewReady.current || !controls.current) {
        waiting.current.push(ops);
        return;
      }
      for (const op of ops) {
        if (op.type !== 'template.update') continue;
        if (op.name !== undefined) setEditor((was) => (was ? { ...was, name: op.name! } : was));
        if (op.minutesPerProperty !== undefined) {
          minutes.current = op.minutesPerProperty;
          controls.current.setMinutes(op.minutesPerProperty);
        }
      }
      const rows = mapOpStops(
        ops.filter((op) => op.type !== 'template.update'),
        (building) => made.rowOf.get(building),
      );
      if (!rows.length) return;
      lastKnown.current = { groups: applyGroupOps(lastKnown.current, rows).groups };
      controls.current.rebase((state) => ({ groups: applyGroupOps(state, rows).groups }));
    },
    [made],
  );

  /**
   * Opened when a different template arrives -- never again for the same one:
   * from then on it is kept up to date live.
   */
  useEffect(() => {
    const template = detail.data;
    if (!template || !made || template.id !== openId) return;
    if (editor?.templateId === template.id) return;
    const { state, missing } = stateFromTemplate(template, made.rowOf);
    engine.current?.close();
    viewReady.current = false;
    waiting.current = [];
    lastKnown.current = state;
    minutes.current = template.minutesPerProperty;
    engine.current = new TemplateSync({
      base: liveGroupsOfTemplate(template),
      revision: template.revision,
      post: (batchId, ops) => postGroupTemplateOps(template.id, batchId, ops),
      fetch: async () => {
        const fresh = await readGroupTemplate(template.id);
        client.setQueryData(planningKeys.groupTemplate(fresh.id), fresh);
        setEditor((was) => (was && was.templateId === fresh.id ? { ...was, name: fresh.name } : was));
        if (fresh.minutesPerProperty !== minutes.current) {
          minutes.current = fresh.minutesPerProperty;
          controls.current?.setMinutes(fresh.minutesPerProperty);
        }
        return { groups: liveGroupsOfTemplate(fresh), revision: fresh.revision };
      },
      view: () => liveGroupsOf(lastKnown.current, made.buildingOf),
      applyToView,
      visible: (groups) => visibleGroups(groups, made.rowOf),
      onStatus: (next) => {
        setStatus(next);
        if (next.kind === 'refused') toast.warning('A change was not saved', { description: `${next.message} The template was read again.` });
      },
      newId: () => crypto.randomUUID(),
      refused: refusal,
    });
    setStatus({ kind: 'saved' });
    setEditor({
      key: `${template.id}:${Date.now()}`,
      templateId: template.id,
      name: template.name,
      initial: { state, activeId: null, minutesPerProperty: template.minutesPerProperty },
    });
    if (missing.length) {
      const one = missing.length === 1;
      toast.warning(`${missing.length.toLocaleString()} ${one ? 'property' : 'properties'} in ${template.name} left the package`, {
        description: (
          <div className="grid gap-1.5">
            <ul className="grid gap-0.5">
              {missingStopLines(missing).map((line) => (
                <li key={line} className="font-medium text-foreground">
                  {line}
                </li>
              ))}
            </ul>
            <span>
              {one ? 'Or it lost its position. It is' : 'Or they lost their position. They are'} not on the map; the
              template keeps {one ? 'it' : 'them'} until {one ? 'its' : 'their'} group is changed.
            </span>
          </div>
        ),
        // Long enough to read the addresses, and to go and find them.
        duration: 20_000,
        closeButton: true,
      });
    }
  }, [applyToView, client, detail.data, editor, made, openId]);

  useEffect(() => () => engine.current?.close(), []);

  /** What this person did, worked out from the groups before and after it, and sent. */
  const onViewChange = useCallback(
    (snapshot: { state: ManualState; minutesPerProperty: number }) => {
      if (!made) return;
      if (!viewReady.current) {
        viewReady.current = true;
        lastKnown.current = snapshot.state;
        minutes.current = snapshot.minutesPerProperty;
        for (const ops of waiting.current.splice(0)) applyToView(ops);
        return;
      }
      const ops: GroupTemplateOp<string>[] = [];
      if (snapshot.minutesPerProperty !== minutes.current) {
        minutes.current = snapshot.minutesPerProperty;
        if (snapshot.minutesPerProperty >= 5 && snapshot.minutesPerProperty <= 240)
          ops.push({ type: 'template.update', minutesPerProperty: snapshot.minutesPerProperty });
      }
      ops.push(...diffGroupOps(liveGroupsOf(lastKnown.current, made.buildingOf), liveGroupsOf(snapshot.state, made.buildingOf)));
      lastKnown.current = snapshot.state;
      if (canChange && ops.length) engine.current?.local(ops);
    },
    [applyToView, canChange, made],
  );

  const live = useTemplateLive(editor?.templateId ?? null, {
    onOps: (event) => engine.current?.received(event),
    onPresence: setEditors,
    onJoined: (revision) => engine.current?.resyncFrom(revision),
    onReplaced: (event) => {
      void client.invalidateQueries({ queryKey: planningKeys.groupTemplates });
      if (event.reason === 'ARCHIVED') {
        toast.info(`${event.by.name} archived this template`, { description: 'It is no longer offered when a quarter is built.' });
        engine.current?.close();
        setEditor(null);
        setUrl({ template: '' });
      } else if (event.reason === 'SAVED') engine.current?.resyncFrom();
    },
  });

  /** Who else is building which group, by group id: not this person. */
  const others = useMemo(() => editors.filter((entry) => entry.userId !== profile?.id), [editors, profile?.id]);
  const editingBy = useMemo(() => {
    const byGroup = new Map<string, string[]>();
    for (const entry of others) if (entry.groupId) byGroup.set(entry.groupId, [...(byGroup.get(entry.groupId) ?? []), entry.name]);
    return byGroup;
  }, [others]);
  const liveView = useMemo(
    () => ({ controls, editingBy, onActiveChange: live.focus }),
    [editingBy, live.focus],
  );

  // Leaving while a change is still on its way asks first.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (engine.current?.pending) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  /** Something that would drop a change still on its way waits for it. */
  const whenSaved = (action: () => void) => {
    if (engine.current?.pending) {
      toast.info('Still saving your last change', { description: 'Try again in a moment.' });
      return;
    }
    action();
  };

  const openTemplate = (id: string) =>
    whenSaved(() => {
      engine.current?.close();
      setEditor(null);
      setUrl({ template: id });
    });

  const rename = (name: string) => {
    if (!editor) return;
    setEditor({ ...editor, name });
    clearTimeout(nameTimer.current);
    const trimmed = name.trim();
    if (!canChange || !trimmed || trimmed.length > 80) return;
    nameTimer.current = setTimeout(() => engine.current?.local([{ type: 'template.update', name: trimmed }]), NAME_DEBOUNCE_MS);
  };

  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const create = async (name: string, from: StartFrom, loaded: LoadedGroupFile | null) => {
    if (!made) return;
    let groups: GroupTemplateInput['groups'] = [];
    let minutesPerProperty = minutes.current;
    if (from === 'copy') {
      groups = templateInput(lastKnown.current, made.buildingOf, name, minutesPerProperty).groups;
    } else if (from === 'file' && loaded) {
      try {
        const { matches } = await mutations.match.mutateAsync(rowsToMatch(loaded.file));
        const matched = stateFromMatchedFile(loaded.file, matches, made.rowOf);
        groups = templateInput(matched.state, made.buildingOf, name, minutesPerProperty).groups;
        const missed = matched.unmatched + matched.ambiguous;
        toast.info(`${matched.matched.toLocaleString()} properties placed from ${loaded.name}`, {
          description: `${
            missed
              ? `${missed.toLocaleString()} ${missed === 1 ? 'row' : 'rows'} matched no single enrolled property by address and ${missed === 1 ? 'is' : 'are'} left in no group. `
              : ''
          }${matched.repeated ? `${matched.repeated.toLocaleString()} more were other units of a building already placed.` : ''}`,
        });
      } catch (error) {
        toast.error('The file could not be matched to the properties', {
          description: error instanceof Error ? error.message : undefined,
        });
        return;
      }
    } else minutesPerProperty = DEFAULT_MINUTES_PER_PROPERTY;
    mutations.create.mutate(
      { name, minutesPerProperty, groups },
      {
        onSuccess: (created) => {
          setCreating(false);
          engine.current?.close();
          setEditor(null);
          setUrl({ template: created.id });
          toast.success(`${created.name} created`, {
            description: 'Click properties into groups on the map. Every change is saved as you make it.',
          });
        },
        onError: (error) => toast.error('The template was not created', { description: error.message }),
      },
    );
  };

  const archive = () => {
    if (!editor) return;
    mutations.archive.mutate(editor.templateId, {
      onSuccess: (archived) => {
        setArchiving(false);
        engine.current?.close();
        setEditor(null);
        setUrl({ template: '' });
        toast.success(`${archived.name} archived`, {
          description: 'Quarters built from it keep their days; it is no longer offered for a new build.',
        });
      },
      onError: (error) => toast.error('The template was not archived', { description: error.message }),
    });
  };

  const setActive = (active: boolean) => {
    if (!open) return;
    mutations.setActive.mutate(
      { id: open.id, active },
      {
        onSuccess: (template) =>
          toast.success(active ? `${template.name} is the active template` : `${template.name} is no longer active`, {
            description: active
              ? 'The daily planner builds each new quarter from it. A quarter already built keeps its own grouping.'
              : 'The daily planner builds new quarters with its own grouping.',
          }),
        onError: (error) => toast.error('Not changed', { description: error.message }),
      },
    );
  };

  if (properties.isLoading || templates.isLoading) return <PageSkeleton />;
  if (properties.error) return <ErrorState error={properties.error} retry={() => void properties.refetch()} />;
  if (templates.error) return <ErrorState error={templates.error} retry={() => void templates.refetch()} />;

  const header = (
    <PageHeader
      actions={
        <>
          {usable.length ? (
            <Select onValueChange={openTemplate} value={openId ?? undefined}>
              <SelectTrigger aria-label="Template" className="w-56" size="sm">
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                {usable.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                    {template.isActive ? ' · active' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {canChange ? (
            <Button onClick={() => whenSaved(() => setCreating(true))} size="sm" variant="outline">
              <PlusIcon />
              New template
            </Button>
          ) : null}
        </>
      }
      description="Group the benefit-package properties into days by clicking them on the map. Every change is saved as you make it, and anyone else with the template open sees it at once."
      title="TBP group maker"
    />
  );

  const newDialog = (
    <NewTemplateDialog
      canCopy={Boolean(editor)}
      copyName={editor?.name ?? null}
      onCreate={(name, from, loaded) => void create(name, from, loaded)}
      onOpenChange={setCreating}
      open={creating}
      pending={mutations.create.isPending || mutations.match.isPending}
    />
  );

  if (!usable.length)
    return (
      <div className="grid gap-4">
        {header}
        <EmptyState
          description={`${(made?.rows.length ?? 0).toLocaleString()} enrolled properties are ready to group. Start blank, or from a groups file the office already made.`}
          icon={ShapesIcon}
          title="No groupings yet"
        >
          {canChange ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              New template
            </Button>
          ) : null}
        </EmptyState>
        {newDialog}
      </div>
    );

  const saying: Record<SyncStatus['kind'], string> = {
    saved: 'All changes saved',
    saving: 'Saving…',
    offline: 'Offline — your changes go out when the connection is back',
    refused: 'A change was not saved; the template was read again',
  };

  return (
    <div className="grid gap-3">
      {header}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {editor ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Label className="sr-only" htmlFor="template-name">
              Template name
            </Label>
            <Input
              className="h-8 w-56"
              disabled={!canChange}
              id="template-name"
              maxLength={80}
              onChange={(event) => rename(event.target.value)}
              value={editor.name}
            />
            {open?.isActive ? (
              <Badge title="The daily planner builds each new quarter from this template" variant="success">
                Active
              </Badge>
            ) : null}
            {canChange ? (
              <span
                className={cn(
                  'text-xs',
                  status.kind === 'offline' || status.kind === 'refused' ? 'text-warning font-medium' : 'text-muted-foreground',
                )}
                role="status"
              >
                {saying[status.kind]}
              </span>
            ) : (
              <Badge title="Changes need the planning:publish permission" variant="warning">
                View only &mdash; your changes are not saved
              </Badge>
            )}
            <span
              className={cn('flex items-center gap-1 text-xs', live.connected ? 'text-success' : 'text-muted-foreground')}
              title={live.connected ? 'Changes by others appear as they are made' : 'Connecting to live editing'}
            >
              <span aria-hidden className={cn('size-2 rounded-full', live.connected ? 'bg-success' : 'bg-muted-foreground/50')} />
              {live.connected ? 'Live' : 'Connecting…'}
            </span>
            {others.length ? (
              <span className="flex items-center gap-1.5" title={others.map((entry) => entry.name).join(', ')}>
                <span className="text-muted-foreground text-xs">Also here:</span>
                {others.map((entry) => (
                  <span
                    className="bg-info/15 text-info flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium"
                    key={entry.userId}
                  >
                    <span aria-hidden>{initialsOf(entry.name)}</span>
                    <span className="max-w-28 truncate">{entry.name}</span>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
        {canChange && editor ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={mutations.setActive.isPending}
              onClick={() => setActive(!open?.isActive)}
              size="sm"
              title="The daily planner builds each new quarter from the active template. A quarter already built keeps its own grouping."
              variant="outline"
            >
              <StarIcon />
              {open?.isActive ? 'Stop using for new quarters' : 'Use for new quarters'}
            </Button>
            <Button onClick={() => whenSaved(() => setArchiving(true))} size="sm" variant="ghost">
              <ArchiveIcon />
              Archive
            </Button>
          </div>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <MapDisplaySwitches display={display} onChange={setDisplay} />
        </div>
      </div>

      {properties.data?.withoutPosition ? (
        <p className="text-muted-foreground text-xs">
          {properties.data.withoutPosition.toLocaleString()} enrolled{' '}
          {properties.data.withoutPosition === 1 ? 'property has' : 'properties have'} no position yet and cannot be
          grouped until geocoded; a quarter still visits them.
        </p>
      ) : null}

      {editor && made ? (
        <ManualGroupingView
          file={made.file}
          fileName={editor.name}
          initial={editor.initial}
          key={editor.key}
          lines={display.lines}
          live={liveView}
          onChange={onViewChange}
          persist={false}
          prints={EMPTY_PRINTS}
          properties={made.rows}
          road={display.road}
          showLegTimes={display.legTimes}
          showOutlines={display.outlines}
          zones={zones}
        />
      ) : (
        <PageSkeleton cards={1} />
      )}

      {newDialog}

      <AlertDialog onOpenChange={setArchiving} open={archiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {editor?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is no longer offered when a quarter is built, and stops being the active template. A quarter already
              built from it keeps its days; rebuilding that quarter asks for another grouping. Anyone else with it
              open is told.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={mutations.archive.isPending} onClick={archive}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The maker saves to the server, so there is nothing to fingerprint for the browser's autosave. */
const EMPTY_PRINTS: ReadonlyMap<number, string> = new Map();

/** A new template: a name, and what it starts from. */
function NewTemplateDialog({
  open,
  onOpenChange,
  canCopy,
  copyName,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCopy: boolean;
  copyName: string | null;
  pending: boolean;
  onCreate: (name: string, from: StartFrom, loaded: LoadedGroupFile | null) => void;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState<StartFrom>('blank');
  const [loaded, setLoaded] = useState<LoadedGroupFile | null>(null);
  const reset = (next: boolean) => {
    if (!next) {
      setName('');
      setFrom('blank');
      setLoaded(null);
    }
    onOpenChange(next);
  };
  const option = (value: StartFrom, title: string, detail: string, disabled = false) => (
    <label
      className={cn(
        'hover:bg-accent/60 grid cursor-pointer gap-0.5 rounded-lg border px-3 py-2',
        from === value && 'border-ring bg-accent',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <span className="flex items-center gap-2">
        <input
          checked={from === value}
          className="accent-primary"
          disabled={disabled}
          name="new-template-start"
          onChange={() => setFrom(value)}
          type="radio"
          value={value}
        />
        <span className="text-sm font-medium">{title}</span>
      </span>
      <span className="text-muted-foreground text-xs">{detail}</span>
    </label>
  );
  const ready = name.trim().length > 0 && (from !== 'file' || loaded !== null);

  return (
    <Dialog onOpenChange={reset} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            A grouping of every enrolled property into days. It is used only once it is chosen for a quarter&rsquo;s
            build, or made the one new quarters are built from.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="new-template-name">Name</Label>
          <Input
            id="new-template-name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Outside in, Q1 2027"
            value={name}
          />
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Start from</legend>
          {option('blank', 'Nothing', 'Every property in no group, to click into groups.')}
          {option(
            'copy',
            copyName ? `A copy of ${copyName}` : 'A copy of the open template',
            'Its groups as they are now, saved or not, to change without touching it.',
            !canCopy,
          )}
          {option('file', 'A groups file', 'A CSV the office made. Each row is matched to its property by address.')}
          {from === 'file' ? (
            <div className="flex items-center gap-2 pl-6">
              <GroupFilePicker label={loaded ? 'Choose another file' : 'Choose a file'} onLoad={setLoaded} />
              {loaded ? (
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {loaded.name} &middot; {loaded.file.groups.length.toLocaleString()} groups
                </span>
              ) : null}
            </div>
          ) : null}
        </fieldset>
        <DialogFooter>
          <Button onClick={() => reset(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={!ready || pending} onClick={() => onCreate(name.trim(), from, loaded)} type="button">
            {pending ? <Spinner /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
