import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Variants are semantic, not colour names: a caller asks for `success`, never
 * `green`. That is what lets one status keep the same appearance on every
 * screen, and lets dark-mode contrast be fixed centrally.
 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full ' +
    'px-2 py-0.5 text-[10px] font-extrabold [&>svg]:size-3 [&>svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-[var(--blue-soft)] text-[var(--blue)]',
        success: 'bg-[var(--green-soft)] text-[var(--green-dark)]',
        warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
        destructive: 'bg-[var(--danger-soft)] text-[var(--danger)]',
        muted: 'bg-muted text-muted-foreground',
        outline: 'border border-border text-foreground',
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
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
