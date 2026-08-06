import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Variants deliberately mirror the legacy `.button`, `.button-primary`,
 * `.button-secondary`, `.button-danger` and `.button-small` classes so a screen
 * can be migrated by swapping the element, without redesigning it mid-move.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold ' +
    'transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-55 ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--blue)] ' +
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The brand green, reached for directly rather than through `primary`.
        // That token is also the link colour across the app, and green text on
        // the card measures 2.0:1 — the colour only works as a surface, under
        // the near-black foreground it is paired with here.
        primary:
          'bg-[var(--brand)] text-[var(--brand-contrast)] hover:bg-[var(--brand-dark)]',
        secondary: 'border border-border bg-card text-foreground hover:bg-[var(--surface-hover)]',
        // Destructive reads as destructive on intent, not at rest — four solid
        // red buttons down a list dominate everything around them.
        danger:
          'border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-transparent ' +
          'text-[var(--danger)] hover:bg-[var(--danger-soft)] hover:border-[var(--danger)]',
        ghost: 'bg-transparent text-foreground hover:bg-[var(--surface-hover)]',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-[13px]',
        small: 'h-8 px-2.5 text-xs',
        large: 'h-10 px-5 text-sm',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
