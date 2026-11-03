'use client';

import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The pieces of a record page in the Jobber-style shell (lib/console-shell.ts),
 * laid out as Jobber's job and client pages are: the place's card beside a
 * table of the record's details, section cards below, and a side panel that can
 * be put away. The pages decide when to draw them; nothing here reads data.
 */

export interface Fact {
  label: string;
  value: ReactNode;
  /** A quieter line under the value: where it came from, what it means. */
  detail?: ReactNode;
}

/** Jobber's details table: a label and a value a row, on hairlines. */
export function FactTable({ facts, label, className }: { facts: readonly Fact[]; label: string; className?: string }) {
  return (
    <dl aria-label={label} className={cn('divide-y', className)}>
      {facts.map((fact) => (
        <div className="grid grid-cols-[minmax(7rem,40%)_minmax(0,1fr)] gap-3 py-2.5 text-sm" key={fact.label}>
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="text-heading min-w-0 break-words">
            {fact.value}
            {fact.detail ? <span className="text-muted-foreground block text-xs">{fact.detail}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The place a record is about, as Jobber's client card shows the client: its
 * name (a link to it) with a dot for whether it is still active, then the
 * address under a label, then anything else worth a line.
 */
export function PlaceCard({
  active = true,
  address,
  href,
  lines = [],
  name,
}: {
  active?: boolean;
  address?: string | null;
  href?: string;
  lines?: readonly { label: string; value: ReactNode }[];
  name: string;
}) {
  return (
    <section aria-label={`Property ${name}`} className="bg-card flex flex-col gap-3 rounded-lg border p-4">
      <p className="flex min-w-0 items-center gap-2">
        {href ? (
          <Link className="text-heading truncate text-base font-bold hover:underline" href={href}>
            {name}
          </Link>
        ) : (
          <span className="text-heading truncate text-base font-bold">{name}</span>
        )}
        <span
          aria-label={active ? 'Active' : 'Inactive'}
          className={cn('size-2 shrink-0 rounded-full', active ? 'bg-success' : 'bg-muted-foreground')}
          role="img"
        />
      </p>
      {address ? (
        <div className="text-sm">
          <p className="text-muted-foreground text-xs">Property address</p>
          <p className="text-foreground">{address}</p>
        </div>
      ) : null}
      {lines.map((line) => (
        <div className="text-sm" key={line.label}>
          <p className="text-muted-foreground text-xs">{line.label}</p>
          <div className="text-foreground">{line.value}</div>
        </div>
      ))}
    </section>
  );
}

/** One card of the side panel, as Jobber's Overview, Tags and Notes. */
export function AsideCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-card rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-heading text-base font-bold">{title}</h2>
        {action}
      </div>
      <div className="mt-3 text-sm">{children}</div>
    </section>
  );
}

const PANEL_KEY = 'console-record-panel';

/** Remembered per browser, as Jobber remembers it. Storage can refuse; the panel then simply shows. */
function readHidden(): boolean {
  try {
    return window.localStorage.getItem(PANEL_KEY) === 'hidden';
  } catch {
    return false;
  }
}
function writeHidden(hidden: boolean) {
  try {
    window.localStorage.setItem(PANEL_KEY, hidden ? 'hidden' : 'shown');
  } catch {
    // A refused write only means it is not remembered.
  }
}

/** Whole class names, as Tailwind generates only what it can read. */
const SIDE_BY_SIDE = {
  xl: { grid: 'xl:grid-cols-[minmax(0,1fr)_19rem]', hide: 'xl:hidden', show: 'xl:flex' },
  '2xl': { grid: '2xl:grid-cols-[minmax(0,1fr)_20rem]', hide: '2xl:hidden', show: '2xl:flex' },
} as const;

/**
 * The record and its side panel. Beside it from `from` up, where the record
 * still has room; under it below that, as Jobber's narrow layout puts its
 * panel last. "Hide panel" gives the record the whole width and is remembered.
 *
 * The inspection page asks for `2xl`: its area workspace needs the width more
 * than its panel does.
 */
export function RecordLayout({
  aside,
  asideLabel,
  children,
  from = 'xl',
}: {
  aside: ReactNode;
  asideLabel: string;
  children: ReactNode;
  from?: keyof typeof SIDE_BY_SIDE;
}) {
  const [hidden, setHidden] = useState(false);
  // After mount, so the server's first paint and the browser's agree.
  useEffect(() => setHidden(readHidden()), []);
  const layout = SIDE_BY_SIDE[from];
  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
  };

  return (
    <div className={cn('grid items-start gap-6', !hidden && layout.grid)}>
      <div className="min-w-0">
        {hidden ? (
          <div className={cn('mb-3 hidden justify-end', layout.show)}>
            <Button onClick={() => toggle(false)} size="sm" variant="ghost">
              <PanelRightOpenIcon />
              Show panel
            </Button>
          </div>
        ) : null}
        {children}
      </div>
      <aside aria-label={asideLabel} className={cn('flex min-w-0 flex-col gap-4', hidden && layout.hide)}>
        <div className={cn('hidden justify-end', layout.show)}>
          <Button aria-label="Hide panel" onClick={() => toggle(true)} size="sm" variant="ghost">
            <PanelRightCloseIcon />
            Hide panel
          </Button>
        </div>
        {aside}
      </aside>
    </div>
  );
}
