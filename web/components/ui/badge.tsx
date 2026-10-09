import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { SpanSlot } from './slot';

const BASE =
  // `font-sans` explicitly: a badge is a label, not a figure, and it is
  // routinely dropped into cells that set `font-mono` for their numbers.
  'inline-flex items-center justify-center rounded-md border py-0.5 font-sans text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden';

/**
 * A dot drawn before the word, in the tone's colour, unless the badge brings
 * its own icon (which then carries the tone instead). `not-has-[>svg]` keeps a
 * spinner or a tick from being doubled up with a dot. Spelled out per tone, not
 * built by a helper: Tailwind only generates classes it can read in the source.
 */
const DOT =
  "not-has-[>svg]:before:size-1.5 not-has-[>svg]:before:shrink-0 not-has-[>svg]:before:rounded-full not-has-[>svg]:before:content-['']";

/**
 * DOT, the console's default since 2026-10-09 (console-development): a status
 * is a 6px dot and a word, with no box. A table with a tinted, bordered chip in
 * every column read as a wall of colour (thirteen inspection rows carried ~39
 * chips), and the colour stopped meaning anything. Now colour is only the dot,
 * and the WORD is coloured only where somebody has to act (warning, destructive).
 * Done and informational states read in the ordinary text colours.
 */
const dotVariants = cva(`${BASE} border-transparent bg-transparent gap-1.5 px-0`, {
  variants: {
    variant: {
      default: 'text-foreground',
      secondary: 'text-muted-foreground',
      destructive: `text-destructive ${DOT} not-has-[>svg]:before:bg-destructive`,
      outline: 'text-foreground border-border px-1.5',
      success: `text-muted-foreground ${DOT} not-has-[>svg]:before:bg-success [&>svg]:text-success [a&]:hover:text-foreground`,
      warning: `text-warning ${DOT} not-has-[>svg]:before:bg-warning`,
      info: `text-foreground ${DOT} not-has-[>svg]:before:bg-info [&>svg]:text-info`,
    },
  },
  defaultVariants: { variant: 'default' },
});

/**
 * PILL, kept for the documents that leave the console -- the homeowner report
 * and the shared move-in / move-out comparison -- where a badge is printed on
 * paper and handed to somebody who never learned the console's dot language.
 *
 * Status pills are tinted rather than solid: a table with forty solid badges
 * down a column reads as a warning about the table itself. The tint comes from
 * the same token as the text, so a status can never end up with a surface and a
 * foreground that disagree, which is how "Approved" and "Completed" drifted
 * apart in the old app's regex-matched badge.
 *
 * The tint is 10% in light mode and 8% in dark, and that asymmetry is measured,
 * not stylistic. Text sits on a tint of *itself*, so a bright dark-mode token
 * lifts its own surface as it lightens; at 10% the destructive badge lands at
 * 4.16:1 and fails AA outright. Dropping to 8% pulls the surface back toward the
 * card and recovers it. `lib/theme-contrast.test.ts` asserts both alphas.
 */
const pillVariants = cva(`${BASE} gap-1 px-2`, {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
      secondary:
        'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
      destructive:
        'border-destructive/25 bg-destructive/10 dark:bg-destructive/8 text-destructive [a&]:hover:bg-destructive/15 dark:[a&]:hover:bg-destructive/12',
      outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      success:
        'border-success/25 bg-success/10 dark:bg-success/8 text-success [a&]:hover:bg-success/15 dark:[a&]:hover:bg-success/12',
      warning:
        'border-warning/25 bg-warning/10 dark:bg-warning/8 text-warning [a&]:hover:bg-warning/15 dark:[a&]:hover:bg-warning/12',
      info: 'border-info/25 bg-info/10 dark:bg-info/8 text-info [a&]:hover:bg-info/15 dark:[a&]:hover:bg-info/12',
    },
  },
  defaultVariants: { variant: 'default' },
});

/** Kept as the public name; it is the console's (dot) form. */
const badgeVariants = dotVariants;

function Badge({
  className,
  variant,
  appearance = 'dot',
  asChild = false,
  ...props
}: ComponentProps<'span'> &
  VariantProps<typeof dotVariants> & {
    /** `pill` only for documents that leave the console (report, comparison). */
    appearance?: 'dot' | 'pill';
    asChild?: boolean;
  }) {
  const Comp = asChild ? SpanSlot : 'span';
  const variants = appearance === 'pill' ? pillVariants : dotVariants;
  return (
    <Comp
      data-appearance={appearance}
      data-slot="badge"
      className={cn(variants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
