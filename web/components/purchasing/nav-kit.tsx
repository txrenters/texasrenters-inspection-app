'use client';

import { ChevronDownIcon, ChevronUpIcon, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

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
    <div className="flex min-h-20 flex-col justify-between border-r px-2.5 pt-1.5 pb-1 last:border-r-0">
      <div className="flex flex-wrap items-start gap-1">{children}</div>
      <div className="text-muted-foreground mt-1 text-center text-[11px]">{caption}</div>
    </div>
  );
}

/** A large ribbon button with its icon above the words, or a small one of words alone. */
export function RibbonButton({ icon: Icon, label, onClick, disabled, busy, tone }: { icon?: LucideIcon; label: string; onClick: () => void; disabled?: boolean; busy?: boolean; tone?: 'danger' }) {
  return (
    <button
      className={cn(
        'focus-visible:ring-ring/50 rounded-sm text-xs font-medium outline-none focus-visible:ring-[3px] disabled:cursor-default disabled:opacity-40',
        Icon ? 'flex min-h-11 min-w-16 flex-col items-center gap-0.5 px-1.5 py-1 text-center' : 'block min-h-6 px-1 py-0.5 text-left',
        tone === 'danger' ? 'text-destructive' : 'text-heading',
        'enabled:hover:bg-accent',
      )}
      disabled={disabled || busy}
      onClick={onClick}
      type="button"
    >
      {Icon ? <Icon aria-hidden="true" className="size-5" /> : null}
      {label}
    </button>
  );
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
export function FieldRow({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 py-1">
      {htmlFor ? (
        <label className="text-sm" htmlFor={htmlFor}>
          {label}:
        </label>
      ) : (
        <span className="text-sm">{label}:</span>
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

/** A FactBox down the right of the page: a few facts about the record or the line the cursor is on. */
export function FactBox({ title, facts, children }: { title: string; facts?: readonly { label: string; value: ReactNode }[]; children?: ReactNode }) {
  return (
    <section aria-label={title} className="bg-card rounded-sm border">
      <h2 className="bg-muted/60 text-heading border-b px-3 py-1.5 text-sm font-medium">{title}</h2>
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
    </section>
  );
}
