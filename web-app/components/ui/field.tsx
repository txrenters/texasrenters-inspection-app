import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

import { Label } from './label';

/**
 * One form system, replacing the legacy `.field` / `.field-error` / `.field-help`
 * CSS block. Composition mirrors shadcn's Field: Field > FieldLabel + control +
 * FieldDescription/FieldError.
 */
export function Field({
  className,
  asChild = false,
  ...props
}: ComponentProps<'div'> & { asChild?: boolean }) {
  // Some fields wrap their control in a <label> so the whole block is clickable.
  // Rendering those as a <div> would break that association.
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-slot="field"
      className={cn('grid min-w-0 content-start gap-1.5', className)}
      {...props}
    />
  );
}

export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="field-group" className={cn('grid gap-4', className)} {...props} />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn('text-[13px] font-semibold text-muted-foreground', className)}
      {...props}
    />
  );
}

export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-[12px] leading-snug text-muted-foreground', className)}
      {...props}
    />
  );
}

/**
 * Renders nothing when there is no message, so callers can mount it
 * unconditionally without reserving space or emitting an empty alert.
 */
export function FieldError({
  className,
  children,
  ...props
}: ComponentProps<'p'>) {
  if (!children) return null;
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn('text-[12px] font-medium text-destructive', className)}
      {...props}
    >
      {children}
    </p>
  );
}
