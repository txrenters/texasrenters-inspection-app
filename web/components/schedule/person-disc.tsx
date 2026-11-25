import { UserRoundXIcon } from 'lucide-react';

import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A person's initials on a dark disc, as Jobber marks who is on a visit. A
 * dashed ring with a struck-out figure for nobody, so "Unassigned" is never
 * just a missing disc.
 */
export function PersonDisc({ name, className }: { name: string | null; className?: string }) {
  if (!name)
    return (
      <span
        aria-hidden
        className={cn(
          'text-muted-foreground inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed',
          className,
        )}
      >
        <UserRoundXIcon className="size-3" />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(
        'bg-heading text-background inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-bold',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
