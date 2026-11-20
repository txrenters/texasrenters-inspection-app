'use client';

import { ChevronDownIcon, ChevronUpIcon, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * The pieces of a record page laid out as classic NAV is (2026-11-20, the
 * requisition the office approved): a ribbon of grouped actions, FastTabs
 * that fold, "Label:" beside each field in two columns, and FactBoxes down
 * the right. Built from the console's own colours, so it reads in light and
 * dark like every other page.
 */

export function Ribbon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-label={label} className="bg-card flex flex-wrap rounded-md border" role="toolbar">
      {children}
    </div>
  );
}

/** One group of the ribbon, named under its buttons as NAV names them. */
export function RibbonGroup({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-h-20 flex-col justify-between border-r px-1.5 pt-1.5 pb-1 last:border-r-0">
      <div className="flex flex-wrap items-start gap-1">{children}</div>
      <div className="text-muted-foreground mt-1 text-center text-[11px]">{caption}</div>
    </div>
  );
}

/**
 * A large ribbon button with its icon above the words, or a small one of words
 * alone. `hint` says what it does, or why it cannot be pressed now; `pressed`
 * marks a toggle that is on (Notes, Links, Comments).
 *
 * Greyed with a reason, it still opens when pressed, to say why (2026-11-21):
 * the office took greyed buttons for ones not built yet.
 */
export function RibbonButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  busy,
  tone,
  hint,
  pressed,
}: {
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'danger';
  hint?: string;
  pressed?: boolean;
}) {
  const blocked = Boolean(disabled && hint && !busy);
  const [why, setWhy] = useState(false);
  // One element whether greyed or not, so a button that greys keeps its place and focus.
  const button = (
    <button
      aria-disabled={blocked || undefined}
      aria-pressed={pressed}
      className={cn(
        'focus-visible:ring-ring/50 rounded-sm text-xs font-medium outline-none focus-visible:ring-[3px] disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40',
        // A large button's words wrap under its icon, two lines at most, as NAV's do; a small one's stay on one line.
        Icon ? 'flex min-h-11 max-w-24 min-w-14 flex-col items-center gap-0.5 px-1 py-1 text-center leading-tight' : 'block min-h-6 px-1 py-0.5 text-left whitespace-nowrap',
        tone === 'danger' ? 'text-destructive' : 'text-heading',
        pressed ? 'bg-accent' : '',
        blocked ? '' : 'enabled:hover:bg-accent',
      )}
      disabled={blocked ? undefined : disabled || busy}
      onClick={blocked ? () => setWhy(true) : onClick}
      title={hint}
      type="button"
    >
      {Icon ? <Icon aria-hidden="true" className="size-5" /> : null}
      {label}
    </button>
  );
  return (
    <Popover onOpenChange={setWhy} open={blocked && why}>
      <PopoverAnchor asChild>{button}</PopoverAnchor>
      {blocked ? (
        <PopoverContent aria-label={`Why ${label} cannot be pressed`} className="w-72 p-3 text-sm">
          <p className="text-heading font-medium">{label}</p>
          <p className="text-muted-foreground mt-1">{hint}</p>
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** Small ribbon buttons one above another, as NAV stacks them. */
export function RibbonStack({ children }: { children: ReactNode }) {
  return <div className="grid content-start">{children}</div>;
}

/** The record's own name under the ribbon, "PR-00042", as NAV heads a card page. */
export function DocumentTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-info text-2xl leading-tight font-normal tracking-wide">{children}</h1>;
}

/** A section that folds, with its name in a strip across the top. */
export function FastTab({ title, action, defaultOpen = true, children, className }: { title: string; action?: ReactNode; defaultOpen?: boolean; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className={cn('bg-card rounded-sm border', className)}>
      <div className="bg-muted/60 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 className="text-heading text-base font-medium" id={`${id}-title`}>
          {title}
        </h2>
        <div className="flex items-center gap-2">
          {action}
          <button aria-controls={`${id}-body`} aria-expanded={open} aria-label={`${open ? 'Fold' : 'Open'} ${title}`} className="text-muted-foreground hover:text-foreground rounded-sm p-1" onClick={() => setOpen(!open)} type="button">
            {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
          </button>
        </div>
      </div>
      <div className={cn('@container p-3', open ? '' : 'hidden')} id={`${id}-body`}>
        {children}
      </div>
    </section>
  );
}

/** "Label:" with its field beside it, as NAV lays a FastTab out. */
/** NAV's red star on a field that must be filled in before a document is sent (Purchasing Setup, 2026-11-21). */
export function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="text-destructive ml-0.5">
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

export function FieldRow({ label, htmlFor, children, hint, required }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode; required?: boolean }) {
  const mark = required ? <RequiredMark /> : null;
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 py-1">
      {htmlFor ? (
        <label className="text-sm" htmlFor={htmlFor}>
          {label}
          {mark}:
        </label>
      ) : (
        <span className="text-sm">
          {label}
          {mark}:
        </span>
      )}
      <div className="min-w-0">{children}</div>
      {hint ? <div className="text-muted-foreground col-start-2 text-xs">{hint}</div> : null}
    </div>
  );
}

/** A value shown where a field would be, for what cannot be changed. */
export function FieldValue({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <div className="bg-muted/50 text-heading min-h-8 rounded-sm px-2 py-1.5 text-sm" id={id}>
      {children}
    </div>
  );
}

/**
 * A FactBox down the right of the page: a few facts about the record or the
 * line the cursor is on. It folds to its name with ▲, as NAV's do; `id` lets
 * a ribbon button bring it into view.
 */
export function FactBox({ title, facts, children, id }: { title: string; facts?: readonly { label: string; value: ReactNode }[]; children?: ReactNode; id?: string }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section aria-label={title} className="bg-card scroll-mt-20 rounded-sm border" id={id}>
      <div className={cn('bg-muted/60 flex items-center justify-between gap-2 px-3 py-1.5', open ? 'border-b' : '')}>
        <h2 className="text-heading text-sm font-medium">{title}</h2>
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          aria-label={`${open ? 'Fold' : 'Open'} ${title}`}
          className="text-muted-foreground hover:text-foreground rounded-sm p-0.5"
          onClick={() => setOpen(!open)}
          type="button"
        >
          {open ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
        </button>
      </div>
      <div className={open ? '' : 'hidden'} id={bodyId}>
        {facts ? (
          <dl className="px-3 py-1.5">
            {facts.map((fact) => (
              <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm" key={fact.label}>
                <dt>{fact.label}:</dt>
                <dd className="text-info text-right tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {children ? <div className="px-3 py-2 text-sm">{children}</div> : null}
      </div>
    </section>
  );
}
