'use client';

import { UserRoundXIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/auth';
import { formatScheduledDate } from '@/lib/format';
import { typeTitle, typeTone } from '@/lib/inspection-type-tone';
import { useInspections, useUnassignedCount } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** How many the drawer lists; the rest are on the Inspections list it links to. */
const LISTED = 50;

/**
 * Jobber's "Unscheduled" drawer, in the console's terms: the upcoming
 * inspections nobody is on yet, oldest first. In Jobber they are dragged onto
 * the calendar; here each opens its inspection, where it is assigned behind
 * the existing assignment dialog -- and with it whatever goes to Jobber.
 *
 * The count is the sidebar's own query (one counted row), so the two cannot
 * disagree; the list is read only while the drawer is open.
 */
export function UnassignedDrawer() {
  const { has } = usePermissions();
  const allowed = has('inspections:read');
  const [open, setOpen] = useState(false);
  const count = useUnassignedCount(allowed).data;

  if (!allowed) return null;

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          <UserRoundXIcon />
          Unassigned
          {count ? (
            <span className="bg-warning/10 text-warning rounded-full px-1.5 font-mono text-[11px] leading-5">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md" side="right">
        <SheetHeader>
          <SheetTitle>
            Unassigned{count ? <span className="text-muted-foreground font-normal"> · {count}</span> : null}
          </SheetTitle>
          <SheetDescription>Upcoming inspections nobody is on yet, oldest first. Assign one on its inspection.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {/* Mounted only while the drawer is open, so the list is only read then. */}
          <UnassignedList onOpen={() => setOpen(false)} />
        </SheetBody>
        <SheetFooter>
          <Button asChild variant="outline">
            <Link href="/inspections?tech=unassigned&day=all" onClick={() => setOpen(false)}>
              All of them on Inspections
            </Link>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function UnassignedList({ onOpen }: { onOpen: () => void }) {
  const list = useInspections({ unassignedOnly: true, page: 1, pageSize: LISTED, scheduledOrder: 'asc' });

  if (list.isError) return <ErrorState className="border-0" error={list.error} retry={() => void list.refetch()} />;
  if (list.isLoading)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton className="h-14 rounded-lg" key={index} />
        ))}
      </div>
    );

  const items = list.data?.items ?? [];
  if (!items.length) return <p className="text-muted-foreground py-6 text-sm">Every upcoming inspection has somebody on it.</p>;

  return (
    <ul className="flex flex-col gap-1.5 pb-2">
      {items.map((inspection) => {
        const tone = typeTone(inspection.inspectionType);
        return (
          <li key={inspection.id}>
            <Link
              className={cn(
                'focus-visible:ring-ring/50 flex flex-col gap-0.5 rounded-md border-l-[3px] px-3 py-2 outline-none focus-visible:ring-[3px]',
                tone.bar,
                tone.tint,
              )}
              href={`/inspections/${inspection.id}`}
              onClick={onOpen}
            >
              <span className="text-heading truncate text-sm font-medium">
                {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
                {inspection.propertywareUnit?.name ? ` · ${inspection.propertywareUnit.name}` : ''}
              </span>
              <span className="text-muted-foreground text-xs">
                {typeTitle(inspection.inspectionType)} · {formatScheduledDate(inspection.scheduledAt)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
