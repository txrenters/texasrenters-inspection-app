import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { ButtonSlot } from './slot';

/**
 * Stock shadcn variants, unmodified — `default` is the brand blue, and there is
 * no `primary` or `danger` alias. The old app renamed these to mirror its
 * legacy CSS classes, which meant `<Button>` with no variant rendered a
 * *secondary* button and every call site had to say `variant="primary"` to get
 * the obvious thing.
 *
 * `brand` is the one addition: the TexasRenters green, under the near-black
 * foreground it must be paired with. It is a surface colour only.
 *
 * Two changes from stock. The `shadow-xs` is gone, for the same reason it is
 * gone from Card: this palette carries elevation in the surface itself, and a
 * shadow under a button that already has a fill and a border is a soft edge for
 * nothing. In its place, `active:translate-y-px` — a real press. A control that
 * only changes colour on click reads as a link; one that moves reads as a
 * button, and this console is a tool people click all day.
 *
 * `destructive` uses `--destructive-foreground` rather than a hardcoded white.
 * In dark mode the destructive token is a light red, and white text on it
 * measures 2.4:1; the near-black foreground is the pairing that survives both
 * modes, and `lib/theme-contrast.test.ts` holds it there.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,translate] active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:active:translate-y-0 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-card hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline active:translate-y-0',
        brand: 'bg-brand text-brand-foreground hover:bg-brand/90',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? ButtonSlot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
