import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A raised surface.
 *
 * ── The shadow rule for this application ─────────────────────────────────────
 * Shadows mean "floating above the page", and nothing else. Dialogs, sheets,
 * popovers, dropdowns, select menus and floor-plan markers genuinely float, and
 * they keep theirs. Anything in the document flow — this card, buttons, inputs,
 * checkboxes, switches — has none.
 *
 * The reason is that `--card` now carries its own lightness against
 * `--background` (see the surface note in globals.css), so a card already reads
 * as raised from its fill and its border alone. A shadow on top of a surface
 * that is *already* distinct is a second, softer edge doing the same job, and
 * forty of them on one screen is forty soft edges the eye has to resolve before
 * it can find the number it came for. It also means a real shadow now carries
 * information: if something is casting one, it is floating.
 *
 * Padding is 16px, not shadcn's stock 24px. This console is scanned, not read:
 * a coordinator has an inspection queue open all day, and 8px per edge per card
 * is a table row back.
 */
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-4', className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-4 [.border-t]:pt-4', className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
