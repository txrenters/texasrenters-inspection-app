import type { AdminDashboardOutlook } from '@texasrenters/shared';
import Link from 'next/link';

import { formatCount, formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';

import { DashCard, HATCH } from './dash-card';

/**
 * Who holds how many visits over the next five working days.
 *
 * One measure, so one colour: the bars are compared by length, busiest first.
 * Visits with nobody on them sit apart at the bottom, hatched, because they
 * are not a sixth person's load.
 */
export function TechnicianLoad({ outlook }: { outlook: AdminDashboardOutlook }) {
  const most = Math.max(1, ...outlook.technicianLoad.map((person) => person.visits));
  const first = outlook.loadDays[0];
  const last = outlook.loadDays.at(-1);
  return (
    <DashCard
      subtitle={
        first && last ? `Visits booked, ${formatDay(first)} to ${formatDay(last)}` : 'Visits booked, next 5 working days'
      }
      title="Technician load"
      titleId="dashboard-technician-load"
    >
      {outlook.technicianLoad.length ? (
        <ul>
          {outlook.technicianLoad.map((person) => {
            const nobody = person.technicianId === null;
            return (
              <li
                className={cn(
                  'grid grid-cols-[minmax(0,7.5rem)_1fr_2rem] items-center gap-2.5 py-1.5 text-[13.5px]',
                  nobody && 'mt-1.5 border-t pt-3',
                )}
                key={person.technicianId ?? 'nobody'}
              >
                {nobody ? (
                  <Link className="flex items-center gap-2 hover:underline" href="/inspections?tech=unassigned&day=all">
                    <span aria-hidden className="bg-warning size-2 shrink-0 rounded-full" />
                    Unassigned
                  </Link>
                ) : (
                  <span className="truncate" title={person.name}>
                    {person.name}
                  </span>
                )}
                <span aria-hidden className="block">
                  <span
                    className={cn('block h-3.5 min-w-[3px] rounded-r-[4px]', nobody ? HATCH : 'bg-series-1')}
                    style={{ width: `${(person.visits / most) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{formatCount(person.visits)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">Nothing is booked on these days.</p>
      )}
    </DashCard>
  );
}
