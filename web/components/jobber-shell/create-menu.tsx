'use client';

import { isJobInspectionType } from '@texasrenters/shared';
import {
  BriefcaseIcon,
  CirclePlusIcon,
  FanIcon,
  HouseIcon,
  LogInIcon,
  LogOutIcon,
  SignpostIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { useNewJob } from '@/components/jobs/new-job-context';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar';
import { usePermissions } from '@/lib/auth';
import { typeTone } from '@/lib/inspection-type-tone';
import { JOBBER_CREATE_PERMISSION, JOBBER_CREATE_TYPES } from '@/lib/jobber-navigation';
import { cn } from '@/lib/utils';

import { JOBBER_NAV_ROW } from './nav-row';

/**
 * Each type's mark, in its type's colour (lib/inspection-type-tone), the same
 * one the Schedule's visits wear.
 */
const TYPE_ICONS: Record<string, LucideIcon> = {
  MOVE_IN: LogInIcon,
  OCCUPIED: HouseIcon,
  BACK_TO_MARKET: SignpostIcon,
  MOVE_OUT: LogOutIcon,
  HVAC: FanIcon,
};

/**
 * The sidebar's Create, as Jobber's: a row of tiles beside the sidebar, one per
 * thing you can start. Here, a blank job, then one per inspection type, each
 * opening the New job panel with that inspection ticked (2026-11-20).
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
  const openNewJob = useNewJob();

  if (!has(JOBBER_CREATE_PERMISSION)) return null;

  /** Every tile opens the New job panel (2026-11-20): a blank job, or one with that inspection ticked. */
  const chosen = (type?: string) => {
    setOpen(false);
    if (isMobile) setOpenMobile(false);
    openNewJob({ inspectionTypes: type && isJobInspectionType(type) ? [type] : [] });
  };
  const tile =
    'hover:bg-accent focus-visible:ring-ring/50 text-heading flex w-24 flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center text-xs leading-tight font-semibold outline-none focus-visible:ring-[3px]';

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
        aria-label="Create a job"
        className="w-auto max-w-[calc(100vw-2rem)] p-1.5"
        side={isMobile ? 'bottom' : 'right'}
        sideOffset={8}
      >
        <ul className="flex flex-wrap gap-1">
          <li>
            <button className={tile} onClick={() => chosen()} type="button">
              <BriefcaseIcon aria-hidden className="text-primary size-5" />
              Job
            </button>
          </li>
          {JOBBER_CREATE_TYPES.map((entry) => {
            const Icon = TYPE_ICONS[entry.type] ?? CirclePlusIcon;
            return (
              <li key={entry.type}>
                <button className={tile} onClick={() => chosen(entry.type)} type="button">
                  <Icon aria-hidden className={cn('size-5', typeTone(entry.type).text)} />
                  {entry.title}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
