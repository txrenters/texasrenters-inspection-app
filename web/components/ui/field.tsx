import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { Label } from './label';
import { DivSlot } from './slot';

/** shadcn Field: Field > FieldLabel + control + FieldDescription/FieldError. */
function Field({
  className,
  asChild = false,
  ...props
}: ComponentProps<'div'> & { asChild?: boolean }) {
  // Some fields wrap their control in a <label> so the whole block is clickable.
  // Rendering those as a <div> would break that association.
  const Comp = asChild ? DivSlot : 'div';
  return (
    <Comp data-slot="field" className={cn('grid min-w-0 content-start gap-2', className)} {...props} />
  );
}

function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="field-group" className={cn('grid gap-4', className)} {...props} />;
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn('text-sm', className)} {...props} />;
}

function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-muted-foreground text-xs leading-snug', className)}
      {...props}
    />
  );
}

/**
 * Renders nothing when there is no message, so callers can mount it
 * unconditionally without reserving space or emitting an empty alert.
 */
function FieldError({ className, children, ...props }: ComponentProps<'p'>) {
  if (!children) return null;
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn('text-destructive text-xs font-medium', className)}
      {...props}
    >
      {children}
    </p>
  );
}

export { Field, FieldGroup, FieldLabel, FieldDescription, FieldError };
