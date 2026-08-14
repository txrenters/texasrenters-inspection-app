import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { SpanSlot } from './slot';

/**
 * Stock shadcn variants plus the three status tones the app actually needs.
 *
 * Status badges are tinted rather than solid: a table with forty solid badges
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
const badgeVariants = cva(
  // `font-sans` explicitly: a badge is a label, not a figure, and it is
  // routinely dropped into cells that set `font-mono` for their numbers.
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 font-sans text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden',
  {
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
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? SpanSlot : 'span';
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
