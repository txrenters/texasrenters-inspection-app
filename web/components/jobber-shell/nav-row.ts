import { cn } from '@/lib/utils';

/**
 * One row of the Jobber-style sidebar, layered over `SidebarMenuButton`.
 *
 * Measured from Jobber's own sidebar: 40px rows, 8px padding, a 16px gap to a
 * 20-24px icon, semibold labels. The page you are on is the white page colour,
 * in bold -- the frame "opens" onto the page -- and a hovered row darkens the
 * frame rather than lighting it. Icons always show, as Jobber's do; on the
 * 56px rail the row is a 40px square.
 *
 * Every `data-[active=true]` here overrides a classic one in the base button
 * (the sage tint, its inset mark, the dark-mode tint), so all four are named.
 */
export const JOBBER_NAV_ROW = cn(
  'h-10 gap-4 rounded-lg px-2 text-sm font-semibold text-sidebar-foreground [&>svg]:size-5',
  'hover:bg-sidebar-hover hover:text-sidebar-foreground active:bg-sidebar-hover active:text-sidebar-foreground',
  'data-[state=open]:bg-sidebar-hover data-[state=open]:hover:bg-sidebar-hover data-[state=open]:hover:text-sidebar-foreground',
  'data-[active=true]:bg-sidebar-accent dark:data-[active=true]:bg-sidebar-accent data-[active=true]:font-bold data-[active=true]:text-sidebar-foreground data-[active=true]:shadow-none',
  'group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-2.5!',
);
