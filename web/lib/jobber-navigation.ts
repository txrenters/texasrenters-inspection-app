import {
  getVisibleAdminNavigation,
  INSPECTION_TYPE_CHILDREN,
  type AdminNavigationItem,
} from '@/lib/admin-navigation';

/**
 * The console's pages, arranged the way Jobber arranges its own
 * (components/jobber-shell).
 *
 * Jobber's sidebar is the day first (Home, Schedule), then the records the
 * office works through (Clients, Requests, Quotes, Jobs, Invoices), then the
 * tools around them (Timesheets, Insights, Apps). Its administration is not in
 * the sidebar at all: it sits behind the gear in the top bar.
 *
 * These are the classic sidebar's pages, permissions and icons, read from
 * `adminNavigation` rather than restated. Only the order and the grouping move,
 * and every page is placed exactly once -- jobber-navigation.test.ts fails if a
 * page is added to the console without being placed here, so the Jobber shell
 * can never quietly lose one.
 */
export const JOBBER_SIDEBAR_SECTIONS: readonly (readonly string[])[] = [
  ['/dashboard', '/schedule'],
  // Jobber's Clients, Requests, Jobs, Invoices and Payments: the properties and
  // the people in them, the visits asked to be booked again, the inspections
  // themselves, and what they were billed and paid.
  ['/properties', '/tenants', '/reschedules', '/inspections', '/invoices', '/payments', '/lease-schedule'],
  // Jobber's tools beside the work: the quarter's plan and its groups, where
  // everybody is, and the hours it came to.
  ['/planning', '/group-maker', '/map', '/timesheet'],
];

/** What Jobber keeps behind the gear: the team, the connected apps, the plumbing. */
export const JOBBER_SETTINGS_SECTIONS: readonly { title: string; hrefs: readonly string[] }[] = [
  { title: 'Team', hrefs: ['/technicians', '/users', '/roles'] },
  {
    title: 'Integrations',
    hrefs: ['/integrations/propertyware', '/integrations/jobber', '/integrations/providers'],
  },
  { title: 'IT tools', hrefs: ['/it-tools/api', '/it-tools/api-clients', '/it-tools/logs'] },
];

/**
 * Jobber's word for a page, where the office already uses it. Only the
 * dashboard: everything else is ours by name (an inspection is not a "job").
 */
const JOBBER_TITLES: Record<string, string> = { '/dashboard': 'Home' };

export type JobberNavigation = {
  sidebar: AdminNavigationItem[][];
  settings: { title: string; items: AdminNavigationItem[] }[];
};

/** The arrangement above, cut down to what this account may open. */
export function getJobberNavigation(hasPermission: (permission: string) => boolean): JobberNavigation {
  const visible = new Map(
    getVisibleAdminNavigation(hasPermission)
      .flatMap((group) => group.items)
      .map((item) => [item.href, item]),
  );
  const pick = (hrefs: readonly string[]) =>
    hrefs.flatMap((href) => {
      const item = visible.get(href);
      return item ? [{ ...item, title: JOBBER_TITLES[href] ?? item.title }] : [];
    });

  return {
    sidebar: JOBBER_SIDEBAR_SECTIONS.map(pick).filter((section) => section.length > 0),
    settings: JOBBER_SETTINGS_SECTIONS.map((section) => ({
      title: section.title,
      items: pick(section.hrefs),
    })).filter((section) => section.items.length > 0),
  };
}

/**
 * The sidebar's Create menu: one tile per inspection type, as Jobber's offers
 * Client, Request, Quote, Job and Invoice. Each opens the ordinary create form
 * with the type already chosen (it reads `?type=`), so this adds a shortcut,
 * not a second way of creating anything.
 */
export const JOBBER_CREATE_TYPES = INSPECTION_TYPE_CHILDREN.map((child) => ({
  ...child,
  href: `/inspections/new?type=${encodeURIComponent(child.type)}`,
}));

/** Who may see the Create menu: the same grant as the lists' Create buttons. */
export const JOBBER_CREATE_PERMISSION = 'inspections:manage';
