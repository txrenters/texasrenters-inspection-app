import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Stock shadcn Alert plus the status tones.
 *
 * Since console-development (2026-10-09) a status alert is a plain panel with
 * a 2px edge and an icon in the tone, and its words in the ordinary text
 * colours -- the same mark the Schedule and the plan calendar use for "this
 * needs a look". The tinted, tone-coloured box above a table was the loudest
 * thing on the inspections list, for a one-line note.
 */
const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive: 'bg-card text-card-foreground border-l-destructive border-l-2 [&>svg]:text-destructive',
        warning: 'bg-card text-card-foreground border-l-warning border-l-2 [&>svg]:text-warning',
        success: 'bg-card text-card-foreground border-l-success border-l-2 [&>svg]:text-success',
        info: 'bg-card text-card-foreground border-l-info border-l-2 [&>svg]:text-info',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed opacity-90',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
