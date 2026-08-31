import {
  Building2,
  CalendarClock,
  ClipboardCheck,
  Gauge,
  KeyRound,
  MapPin,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * A second level under a nav item, for one filtered view of the same route.
 *
 * Inspections are the only thing that needs it: the five types are separate
 * bodies of work with separate histories, and reading a move-out against a
 * mixed list means filtering by hand every time. These are *not* separate
 * routes — `/inspections/move-out` would be swallowed by the
 * `/inspections/[inspectionId]` segment — so each is the same page carrying a
 * `type` search param, which the list already reads.
 */
export type AdminNavigationChild = {
  title: string;
  /** Value of the `type` search param, matching `InspectionType`. */
  type: string;
};

export type AdminNavigationItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  permission?: string;
  children?: AdminNavigationChild[];
};

export type AdminNavigationGroup = {
  title: string;
  items: AdminNavigationItem[];
};

export type AdminBreadcrumb = {
  title: string;
  href?: string;
};

/**
 * The inspection types, as sidebar sections.
 *
 * Ordered by the tenancy lifecycle — move-in, occupied, back-to-market,
 * move-out — rather than alphabetically, because that is the sequence a
 * property actually moves through. Everything scheduled independently of the
 * tenancy follows, in the order the office listed it.
 *
 * Shared by Inspections and Assignments rather than written out twice, so a
 * tenth type cannot appear in one list and be missing from the other.
 */
export const INSPECTION_TYPE_CHILDREN: readonly AdminNavigationChild[] = [
  { title: 'Move-in', type: 'MOVE_IN' },
  { title: 'Occupied', type: 'OCCUPIED' },
  { title: 'Back-to-market', type: 'BACK_TO_MARKET' },
  { title: 'Move-out', type: 'MOVE_OUT' },
  { title: 'HVAC', type: 'HVAC' },
  { title: 'Roof', type: 'ROOF' },
  { title: 'Supra + lockbox placement', type: 'SUPRA_LOCKBOX_PLACEMENT' },
  { title: 'Supra + lockbox removal', type: 'SUPRA_LOCKBOX_REMOVAL' },
  { title: 'AC filter delivery', type: 'AC_FILTER_DELIVERY' },
];

export const adminNavigation: AdminNavigationGroup[] = [
  {
    title: 'Overview',
    items: [
      {
        title: 'Dashboard',
        href: '/dashboard',
        icon: Gauge,
        permission: 'dashboard:read',
      },
    ],
  },
  {
    title: 'Property management',
    items: [
      {
        title: 'Properties',
        href: '/properties',
        icon: Building2,
        permission: 'properties:read',
      },
    ],
  },
  {
    title: 'Inspection operations',
    items: [
      {
        title: 'Inspections',
        href: '/inspections',
        icon: ClipboardCheck,
        permission: 'inspections:read',
        children: [...INSPECTION_TYPE_CHILDREN],
      },
      {
        title: 'Assignments',
        href: '/assignments',
        icon: Workflow,
        permission: 'inspections:assign',
        // "All assignments" first, and it is not decoration. An item with
        // children becomes a toggle rather than a destination, so without this
        // the combined list — the view this page exists to serve — would have
        // no route into it at all.
        children: [{ title: 'All assignments', type: '' }, ...INSPECTION_TYPE_CHILDREN],
      },
      {
        // Beside assignments rather than under People: this answers "where is
        // the work happening now", which is a dispatch question, and it is the
        // assignment list a reader jumps to from it.
        title: 'Technician map',
        href: '/map',
        icon: MapPin,
        // The map is the location surface, so it follows the location grant.
        // Someone who may see the directory but not track people should not be
        // shown a map that will refuse to load for them.
        permission: 'technicians:locate',
      },
    ],
  },
  {
    title: 'People',
    items: [
      {
        title: 'Technicians',
        href: '/technicians',
        icon: UsersRound,
        permission: 'technicians:read',
      },
    ],
  },
  {
    title: 'Access control',
    items: [
      { title: 'Users', href: '/users', icon: UserRound, permission: 'users:read' },
      { title: 'Roles', href: '/roles', icon: KeyRound, permission: 'roles:read' },
    ],
  },
  {
    // Flat items rather than a collapsible section with sub-items. The sub-item
    // mechanism exists for filtered views of one route, which is what the
    // inspection types are; these are two separate pages, and modelling them as
    // children would mean generalising `?type=` children into route children to
    // produce a menu that reads worse than Access control's does beside it.
    title: 'IT tools',
    items: [
      {
        title: 'API',
        href: '/it-tools/api',
        icon: Wrench,
        permission: 'system:manage',
      },
      {
        title: 'API clients',
        href: '/it-tools/api-clients',
        icon: KeyRound,
        permission: 'system:manage',
      },
    ],
  },
  {
    title: 'Integrations',
    items: [
      {
        title: 'Propertyware',
        href: '/integrations/propertyware',
        icon: RefreshCw,
        permission: 'integrations:read',
      },
      {
        title: 'Jobber',
        href: '/integrations/jobber',
        icon: CalendarClock,
        permission: 'integrations:read',
      },
      {
        title: 'Providers',
        href: '/integrations/providers',
        icon: ShieldCheck,
        permission: 'integrations:read',
      },
    ],
  },
];

function normalizePathname(pathname: string) {
  const path = pathname.split(/[?#]/u, 1)[0]?.replace(/\/+$/u, '') ?? '';
  return path || '/';
}

export function isAdminNavigationItemActive(pathname: string, href: string) {
  const current = normalizePathname(pathname);
  const target = normalizePathname(href);
  return current === target || current.startsWith(`${target}/`);
}

export function getVisibleAdminNavigation(hasPermission: (permission: string) => boolean) {
  return adminNavigation
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => item.permission === undefined || hasPermission(item.permission),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function detailTitle(item: AdminNavigationItem) {
  const singular: Record<string, string> = {
    'API clients': 'Client detail',
    Assignments: 'Assignment detail',
    Inspections: 'Inspection detail',
    Properties: 'Property detail',
    Technicians: 'Technician detail',
    Users: 'User detail',
  };
  return singular[item.title] ?? 'Detail';
}

/**
 * The child view currently open, if any.
 *
 * Keyed off the search param rather than the path, so it is only ever active on
 * the list itself — opening one inspection leaves the parent highlighted and no
 * child, which is correct: a detail page belongs to no single type filter.
 */
export function activeNavigationChild(
  item: AdminNavigationItem,
  pathname: string,
  type: string | null,
) {
  if (!item.children) return undefined;
  if (normalizePathname(pathname) !== normalizePathname(item.href)) return undefined;
  // No type means the unfiltered list, which is a child in its own right where
  // one is declared. Falling through to `undefined` would leave the section
  // open with nothing in it highlighted.
  return item.children.find((child) => child.type === (type ?? ''));
}

/** `/inspections?type=MOVE_OUT` for a child, `/inspections` for the parent. */
export function navigationChildHref(item: AdminNavigationItem, child: AdminNavigationChild) {
  // An empty type is the unfiltered list, and `?type=` is not that — it is a
  // blank filter the page would forward to an API that rejects it.
  if (!child.type) return item.href;
  return `${item.href}?type=${encodeURIComponent(child.type)}`;
}

/**
 * @param type - Value of the `type` search param, so a child view reads as
 *   `Inspections / Move-out` rather than as an unlabelled filter on the list.
 */
export function getAdminBreadcrumbs(pathname: string, type?: string | null): AdminBreadcrumb[] {
  const normalized = normalizePathname(pathname);
  const item = adminNavigation
    .flatMap((group) => group.items)
    .filter((candidate) => isAdminNavigationItemActive(normalized, candidate.href))
    .sort((left, right) => right.href.length - left.href.length)[0];

  if (!item) return [{ title: 'Administration' }];
  if (normalized === normalizePathname(item.href)) {
    const child = activeNavigationChild(item, normalized, type ?? null);
    return child
      ? [{ title: item.title, href: item.href }, { title: child.title }]
      : [{ title: item.title }];
  }

  const remainder = normalized
    .slice(normalizePathname(item.href).length)
    .split('/')
    .filter(Boolean);
  const breadcrumbs: AdminBreadcrumb[] = [{ title: item.title, href: item.href }];

  if (remainder[0] === 'new') return [...breadcrumbs, { title: 'Create' }];

  breadcrumbs.push({
    title: detailTitle(item),
    href: remainder.length > 1 ? `${item.href}/${remainder[0]}` : undefined,
  });

  if (remainder.length > 1) {
    const finalTitle: Record<string, string> = {
      'charge-report': 'Charge report',
      'floor-plan': 'Floor plan',
    };
    breadcrumbs.push({ title: finalTitle[remainder.at(-1) ?? ''] ?? 'Detail' });
  }

  return breadcrumbs;
}
