'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

/**
 * A selectable option with a title and a line of explanation.
 *
 * Used for roles and for the permission catalog. The whole card is the label, so
 * the click target is the option rather than a 16px box beside it — the old
 * `.permission-option` block only associated the checkbox with its `<strong>`,
 * which on a list of two dozen permissions is a lot of small targets.
 */
export function CheckboxCard({
  checked,
  onCheckedChange,
  title,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: string;
  description?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'hover:bg-accent/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <Checkbox
        checked={checked}
        className="mt-0.5"
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="grid gap-0.5">
        <span className="text-sm leading-none font-medium">{title}</span>
        {description ? (
          <span className="text-muted-foreground text-xs leading-snug">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
