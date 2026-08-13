import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { SpanSlot } from './slot';

/**
 * Stock shadcn variants plus the three status tones the app actually needs.
 *
 * Status badges are tinted rather than solid: a table with forty solid badges
 * down a column reads as a warning about the table itself. The tint comes from
 * the same token as the text, at 10–15%, so a status can never end up with a
 * surface and a foreground that disagree — which is how "Approved" and
 * "Completed" drifted apart in the old app's regex-matched badge.
 */
const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-destructive/25 bg-destructive/10 text-destructive [a&]:hover:bg-destructive/15',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        success: 'border-success/25 bg-success/10 text-success [a&]:hover:bg-success/15',
        warning: 'border-warning/25 bg-warning/10 text-warning [a&]:hover:bg-warning/15',
        info: 'border-info/25 bg-info/10 text-info [a&]:hover:bg-info/15',
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
