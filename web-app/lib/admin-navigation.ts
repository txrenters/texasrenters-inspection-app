import {
  Building2,
  ClipboardCheck,
  Gauge,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
  Workflow,
  type LucideIcon,
} from 'lucide-react';

export type AdminNavigationItem = {
  title: string;
  href: string;
  icon: LucideIcon;
  permission?: string;
};

export type AdminNavigationGroup = {
  title: string;
  items: AdminNavigationItem[];
};

export type AdminBreadcrumb = {
  title: string;
  href?: string;
};

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
      },
      {
        title: 'Assignments',
        href: '/assignments',
        icon: Workflow,
        permission: 'inspections:assign',
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
    title: 'Integrations',
    items: [
      {
        title: 'Propertyware',
        href: '/integrations/propertyware',
        icon: RefreshCw,
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
    Assignments: 'Assignment detail',
    Inspections: 'Inspection detail',
    Properties: 'Property detail',
    Technicians: 'Technician detail',
    Users: 'User detail',
  };
  return singular[item.title] ?? 'Detail';
}

export function getAdminBreadcrumbs(pathname: string): AdminBreadcrumb[] {
  const normalized = normalizePathname(pathname);
  const item = adminNavigation
    .flatMap((group) => group.items)
    .filter((candidate) => isAdminNavigationItemActive(normalized, candidate.href))
    .sort((left, right) => right.href.length - left.href.length)[0];

  if (!item) return [{ title: 'Administration' }];
  if (normalized === normalizePathname(item.href)) return [{ title: item.title }];

  const remainder = normalized.slice(normalizePathname(item.href).length).split('/').filter(Boolean);
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
