'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Small toggle buttons for a choice from a short list. */
export function Choices<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
}: {
  label: string;
  choices: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div aria-label={label} className="flex flex-wrap gap-1" role="group">
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <Button
            aria-pressed={selected}
            className={cn('h-7 px-2 text-xs', !selected && 'text-muted-foreground')}
            disabled={disabled}
            key={choice.value}
            onClick={() => onChange(choice.value)}
            size="sm"
            type="button"
            variant={selected ? 'default' : 'outline'}
          >
            {choice.label}
          </Button>
        );
      })}
    </div>
  );
}
