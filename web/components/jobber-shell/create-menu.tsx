'use client';

import {
  CirclePlusIcon,
  FanIcon,
  HouseIcon,
  LogInIcon,
  LogOutIcon,
  SignpostIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar';
import { usePermissions } from '@/lib/auth';
import { JOBBER_CREATE_PERMISSION, JOBBER_CREATE_TYPES } from '@/lib/jobber-navigation';
import { cn } from '@/lib/utils';

import { JOBBER_NAV_ROW } from './nav-row';

/**
 * Each type's mark, coloured as Jobber colours its records (a request is
 * orange, a job green, an invoice blue), so a type is told apart at a glance.
 * The categorical chart tokens, which are measured for exactly that.
 */
const TYPE_MARKS: Record<string, { icon: LucideIcon; tone: string }> = {
  MOVE_IN: { icon: LogInIcon, tone: 'text-chart-5' },
  OCCUPIED: { icon: HouseIcon, tone: 'text-chart-1' },
  BACK_TO_MARKET: { icon: SignpostIcon, tone: 'text-chart-4' },
  MOVE_OUT: { icon: LogOutIcon, tone: 'text-chart-3' },
  HVAC: { icon: FanIcon, tone: 'text-chart-2' },
};

/**
 * The sidebar's Create, as Jobber's: a row of tiles beside the sidebar, one per
 * thing you can start. Here, one per inspection type, each opening the
 * ordinary create form with the type chosen.
 *
 * The trigger is a plain `SidebarMenuButton` with no `tooltip` on purpose: a
 * tooltip makes it return a `<Tooltip>` root, which renders no element, and
 * `PopoverTrigger asChild` would clone that and drop its own wiring (see
 * NavigationSection in app-sidebar for the same trap). Its label stays in the
 * DOM on the rail, so it keeps its accessible name there.
 */
export function CreateMenu() {
  const { has } = usePermissions();
  const { isMobile, setOpenMobile } = useSidebar();
  const [open, setOpen] = useState(false);

  if (!has(JOBBER_CREATE_PERMISSION)) return null;

  const chosen = () => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <SidebarMenuButton className={JOBBER_NAV_ROW}>
          {/* Turns into a cross while the menu is open, as Jobber's does. */}
          <CirclePlusIcon aria-hidden className={cn('transition-transform duration-200', open && 'rotate-45')} />
          <span>Create</span>
        </SidebarMenuButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Create an inspection"
        className="w-auto max-w-[calc(100vw-2rem)] p-1.5"
        side={isMobile ? 'bottom' : 'right'}
        sideOffset={8}
      >
        <ul className="flex flex-wrap gap-1">
          {JOBBER_CREATE_TYPES.map((entry) => {
            const mark = TYPE_MARKS[entry.type];
            const Icon = mark?.icon ?? CirclePlusIcon;
            return (
              <li key={entry.type}>
                <Link
                  className="hover:bg-accent focus-visible:ring-ring/50 text-heading flex w-24 flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center text-xs leading-tight font-semibold outline-none focus-visible:ring-[3px]"
                  href={entry.href}
                  onClick={chosen}
                >
                  <Icon aria-hidden className={cn('size-5', mark?.tone)} />
                  {entry.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
