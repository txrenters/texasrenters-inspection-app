import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm has-[>svg]:pl-11 [&>svg]:absolute [&>svg]:top-3.5 [&>svg]:left-4 [&>svg]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        // Mapped from the legacy `.alert-danger`.
        destructive: 'border-destructive/40 bg-destructive/5 text-destructive [&>svg]:text-current',
        warning: 'border-warning/40 bg-warning/5 text-warning-foreground [&>svg]:text-current',
        success: 'border-success/40 bg-success/5 text-success-foreground [&>svg]:text-current',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('mb-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

export { alertVariants };
