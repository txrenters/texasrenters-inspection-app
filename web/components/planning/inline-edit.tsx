'use client';

import { CheckIcon, PencilIcon } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { fromDateValue, toDateValue } from '@/lib/date-range';
import { cn } from '@/lib/utils';

/**
 * Values that are changed where they are shown.
 *
 * The office asked to edit a draft visit by clicking what its window says --
 * the date, the technician, the Details -- with no Edit button in between
 * (2026-09-16). So each value is its own control: a click opens its editor in
 * place, and the change is saved as it is made. Text saves on Enter or on
 * leaving the field, and Escape puts it back. A refusal is shown under the
 * field with what was typed kept, so no words are lost to a message.
 */

/** Saves a new value; rejects with the reason it was refused. */
export type Save<T> = (value: T) => Promise<unknown>;

const refusal = (error: unknown) => (error instanceof Error && error.message ? error.message : 'This change could not be saved.');

/** Every editable value looks and behaves alike: plain until pointed at, then plainly a control. */
const VALUE =
  'group/value hover:bg-accent/70 focus-visible:ring-ring/50 -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-0.5 text-left outline-none focus-visible:ring-[3px] disabled:cursor-default';

function Affordance({ saving }: { saving: boolean }) {
  return saving ? (
    <Spinner className="mt-0.5 size-3.5 shrink-0" />
  ) : (
    <PencilIcon
      aria-hidden
      className="text-muted-foreground mt-0.5 size-3.5 shrink-0 opacity-0 transition-opacity group-hover/value:opacity-100 group-focus-visible/value:opacity-100"
    />
  );
}

function Refusal({ id, message }: { id: string; message: string | null }) {
  return message ? (
    <p className="text-destructive mt-1 text-xs text-pretty" id={id} role="alert">
      {message}
    </p>
  ) : null;
}

/** The value as a button: its own words, named for what a click changes. */
function ValueButton({
  label,
  saving,
  children,
  className,
  ...props
}: { label: string; saving: boolean; children: ReactNode; className?: string } & React.ComponentProps<'button'>) {
  return (
    <button className={cn(VALUE, className)} disabled={saving} type="button" {...props}>
      <span className="sr-only">Change {label}: </span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <Affordance saving={saving} />
    </button>
  );
}

/** Text, on one line or several. */
export function EditableText({
  label,
  value,
  display,
  onSave,
  multiline = false,
  inputMode,
  hint,
  className,
}: {
  /** What the value is, as a click changes it: "the title", "the Details". */
  label: string;
  value: string;
  /** How the value reads when it is not being edited; the value itself otherwise. */
  display?: ReactNode;
  onSave: Save<string>;
  multiline?: boolean;
  inputMode?: 'numeric' | 'text';
  /** A word under the field while it is edited: what to write, how to save. */
  hint?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Set once Enter, Escape or a button has settled the edit, so the blur that
  // follows does not save a second time.
  const settled = useRef(false);
  const problemId = useId();

  const open = () => {
    setDraft(value);
    setProblem(null);
    settled.current = false;
    setEditing(true);
  };
  const cancel = () => {
    settled.current = true;
    setProblem(null);
    setEditing(false);
  };
  const commit = async () => {
    if (settled.current || saving) return;
    if (draft.trim() === value.trim()) {
      cancel();
      return;
    }
    settled.current = true;
    setSaving(true);
    try {
      await onSave(draft);
      setProblem(null);
      setEditing(false);
    } catch (error) {
      setProblem(refusal(error));
      settled.current = false;
    } finally {
      setSaving(false);
    }
  };

  if (!editing)
    return (
      <div className={className}>
        <ValueButton label={label} onClick={open} saving={saving}>
          {display ?? value}
        </ValueButton>
      </div>
    );

  const field = {
    'aria-describedby': problem ? problemId : undefined,
    'aria-invalid': problem ? true : undefined,
    'aria-label': label.replace(/^the /, ''),
    autoFocus: true,
    disabled: saving,
    onBlur: () => void commit(),
    value: draft,
  };
  // Nothing in these buttons may take focus from the field: the blur would save first.
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return (
    <div className={cn('grid gap-1.5', className)} data-inline-editing="">
      {multiline ? (
        <Textarea
          {...field}
          className="min-h-40 text-sm leading-relaxed"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void commit();
            }
          }}
        />
      ) : (
        <Input
          {...field}
          className="h-8"
          inputMode={inputMode}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') cancel();
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            }
          }}
        />
      )}
      <Refusal id={problemId} message={problem} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {hint ?? (multiline ? 'Ctrl+Enter or click away to save · Esc to undo' : 'Enter or click away to save · Esc to undo')}
        </span>
        {multiline ? (
          <span className="flex gap-1.5">
            <Button onClick={cancel} onMouseDown={keepFocus} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void commit()} onMouseDown={keepFocus} size="sm" type="button">
              {saving ? <Spinner /> : null}
              Save
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface PickOption {
  value: string;
  label: string;
  /** A second, quieter line of the option: an address, "no home on file". */
  hint?: string;
  /** Options are listed under their group, in the order the groups first appear. */
  group?: string;
}

/** One of a list: a technician, a unit, a kind of visit. */
export function EditablePick({
  label,
  value,
  display,
  options,
  onSave,
  searchable = false,
  className,
}: {
  label: string;
  value: string | null;
  display: ReactNode;
  options: readonly PickOption[];
  onSave: Save<string>;
  searchable?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const groups = [...new Set(options.map((option) => option.group ?? ''))];

  const choose = async (next: string) => {
    setOpen(false);
    if (next === value) return;
    setSaving(true);
    setProblem(null);
    try {
      await onSave(next);
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <ValueButton aria-describedby={problem ? problemId : undefined} label={label} saving={saving}>
            {display}
          </ValueButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <Command>
            {searchable ? <CommandInput placeholder="Search…" /> : null}
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup heading={group || undefined} key={group || 'options'}>
                  {options
                    .filter((option) => (option.group ?? '') === group)
                    .map((option) => (
                      <CommandItem
                        key={option.value}
                        onSelect={() => void choose(option.value)}
                        value={`${option.label} ${option.hint ?? ''} ${option.value}`}
                      >
                        <CheckIcon className={cn('size-4 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate">{option.label}</span>
                          {option.hint ? <span className="text-muted-foreground truncate text-xs">{option.hint}</span> : null}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Refusal id={problemId} message={problem} />
    </div>
  );
}

/** A calendar day, `YYYY-MM-DD`, between two days. */
export function EditableDate({
  label,
  value,
  display,
  min,
  max,
  onSave,
  className,
}: {
  label: string;
  value: string | null;
  display: ReactNode;
  /** `YYYY-MM-DD`: days outside are greyed out. */
  min: string;
  max: string;
  onSave: Save<string>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();

  const choose = async (next: string) => {
    setOpen(false);
    if (next === value) return;
    setSaving(true);
    setProblem(null);
    try {
      await onSave(next);
    } catch (error) {
      setProblem(refusal(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <ValueButton aria-describedby={problem ? problemId : undefined} label={label} saving={saving}>
            {display}
          </ValueButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            autoFocus
            defaultMonth={fromDateValue(value ?? min)}
            // Two matchers, not one `{ before, after }`: that shape disables the days between.
            disabled={[{ before: fromDateValue(min)! }, { after: fromDateValue(max)! }]}
            mode="single"
            onSelect={(date) => {
              if (date) void choose(toDateValue(date));
            }}
            selected={fromDateValue(value ?? undefined)}
          />
        </PopoverContent>
      </Popover>
      <Refusal id={problemId} message={problem} />
    </div>
  );
}
