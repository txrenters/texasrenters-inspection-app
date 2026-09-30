'use client';

import { ArchiveIcon, PlusIcon, SaveIcon, ShapesIcon, StarIcon, Undo2Icon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import {
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
  makerProperties,
  rowsToMatch,
  sameTemplate,
  stateFromMatchedFile,
  stateFromTemplate,
  templateInput,
} from './group-maker';
import { DEFAULT_MINUTES_PER_PROPERTY, type ManualState } from './manual-grouping';
import { ManualGroupingView } from './manual-grouping-view';
import { zoneTerritories } from './zone-territories';

/** The template open for editing, as it was when opened or last saved. */
interface Editor {
  /** Remounts the map and its history when a different template opens. */
  key: string;
  templateId: string;
  /** The revision the edit started from: a save over a newer one is refused. */
  revision: number;
  name: string;
  initial: { state: ManualState; activeId: null; minutesPerProperty: number };
  /** What the server holds, to tell an unsaved change. */
  baseline: GroupTemplateInput;
}

/** How a new template starts. */
type StartFrom = 'blank' | 'copy' | 'file';

/**
 * The TBP Property Group maker (the office, 2026-09-30): "once we create all
 * the groupings we can then save it as template for the TBP".
 *
 * The manual grouping tool, over every enrolled property the database holds
 * rather than a file, and saved to the server as a group template. The
 * quarterly plan's Build and Rebuild offer the templates, and the daily
 * planner builds a new quarter from the active one.
 */
export function GroupMakerView() {
  const { has } = usePermissions();
  const canChange = has('planning:publish');
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
  const [current, setCurrent] = useState<{ state: ManualState; minutesPerProperty: number } | null>(null);

  /**
   * Opened when a different template arrives -- never again for the same one,
   * so a save (which brings a new revision back) does not throw away the map's
   * place and the undo history.
   */
  useEffect(() => {
    const template = detail.data;
    if (!template || !made || template.id !== openId) return;
    if (editor?.templateId === template.id) return;
    const { state, missing } = stateFromTemplate(template, made.rowOf);
    setEditor({
      key: `${template.id}:${Date.now()}`,
      templateId: template.id,
      revision: template.revision,
      name: template.name,
      initial: { state, activeId: null, minutesPerProperty: template.minutesPerProperty },
      baseline: templateInput(state, made.buildingOf, template.name, template.minutesPerProperty),
    });
    setCurrent({ state, minutesPerProperty: template.minutesPerProperty });
    if (missing)
      toast.warning(`${missing.toLocaleString()} ${missing === 1 ? 'property' : 'properties'} in ${template.name} left the package`, {
        description: 'Or lost their position. They were left out of their groups, and saving drops them from the template.',
      });
  }, [detail.data, editor, made, openId]);

  const input = useMemo(
    () => (editor && current && made ? templateInput(current.state, made.buildingOf, editor.name, current.minutesPerProperty) : null),
    [current, editor, made],
  );
  const dirty = Boolean(editor && input && !sameTemplate(input, editor.baseline));

  // Leaving with unsaved groups asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** Something that would lose unsaved groups, waiting for the office to say so. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const guarded = (action: () => void) => (dirty ? setPendingLeave(() => action) : action());

  const openTemplate = (id: string) =>
    guarded(() => {
      setEditor(null);
      setUrl({ template: id });
    });

  const save = () => {
    if (!editor || !input) return;
    if (!input.name) {
      toast.error('Give the template a name first');
      return;
    }
    const sent = input;
    mutations.save.mutate(
      { id: editor.templateId, input: { ...sent, revision: editor.revision } },
      {
        onSuccess: (saved) => {
          setEditor((was) => (was ? { ...was, revision: saved.revision, name: saved.name, baseline: sent } : was));
          toast.success(`${saved.name} saved`, {
            description: `${sent.groups.length.toLocaleString()} groups, ${sent.groups
              .reduce((total, group) => total + group.buildingIds.length, 0)
              .toLocaleString()} properties. A quarter built from it uses these groups from now on.`,
          });
        },
        onError: (error) => toast.error('The template was not saved', { description: error.message }),
      },
    );
  };

  /**
   * Back to what is saved: the template opened again from the server's copy,
   * read again first -- after somebody else's save, the copy held here is theirs
   * less.
   */
  const discard = () => void detail.refetch().then(() => setEditor(null));

  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const create = async (name: string, from: StartFrom, loaded: LoadedGroupFile | null) => {
    if (!made) return;
    let groups: GroupTemplateInput['groups'] = [];
    let minutesPerProperty = current?.minutesPerProperty ?? DEFAULT_MINUTES_PER_PROPERTY;
    if (from === 'copy' && input) {
      groups = input.groups;
      minutesPerProperty = input.minutesPerProperty ?? minutesPerProperty;
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
    }
    mutations.create.mutate(
      { name, minutesPerProperty, groups },
      {
        onSuccess: (created) => {
          setCreating(false);
          setEditor(null);
          setUrl({ template: created.id });
          toast.success(`${created.name} created`, {
            description: 'Click properties into groups on the map, then Save.',
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
            <Button onClick={() => guarded(() => setCreating(true))} size="sm" variant="outline">
              <PlusIcon />
              New template
            </Button>
          ) : null}
        </>
      }
      description="Group the benefit-package properties into days by clicking them on the map, then save the grouping as a template the quarterly plan is built from."
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

  return (
    <div className="grid gap-3">
      {header}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {editor ? (
          <div className="flex min-w-0 items-center gap-2">
            <Label className="sr-only" htmlFor="template-name">
              Template name
            </Label>
            <Input
              className="h-8 w-56"
              disabled={!canChange}
              id="template-name"
              maxLength={80}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              value={editor.name}
            />
            {open?.isActive ? (
              <Badge title="The daily planner builds each new quarter from this template" variant="success">
                Active
              </Badge>
            ) : null}
            <span className={cn('text-xs', dirty ? 'text-warning font-medium' : 'text-muted-foreground')}>
              {dirty ? 'Unsaved changes' : open ? `Saved ${formatRelative(open.updatedAt)}` : null}
            </span>
          </div>
        ) : null}
        {canChange && editor ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={!dirty || mutations.save.isPending} onClick={save} size="sm">
              {mutations.save.isPending ? <Spinner /> : <SaveIcon />}
              Save
            </Button>
            {dirty ? (
              <Button onClick={discard} size="sm" variant="ghost">
                <Undo2Icon />
                Discard changes
              </Button>
            ) : null}
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
            <Button onClick={() => setArchiving(true)} size="sm" variant="ghost">
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
          onChange={setCurrent}
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
              built from it keeps its days; rebuilding that quarter asks for another grouping.
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

      <AlertDialog onOpenChange={(next) => !next && setPendingLeave(null)} open={pendingLeave !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {editor?.name} has changes that are not saved. They are lost if you go on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingLeave;
                setPendingLeave(null);
                action?.();
              }}
            >
              Leave without saving
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
