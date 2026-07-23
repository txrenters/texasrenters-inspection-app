'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { AdminGuard, useAuth, usePermissions } from '@/lib/auth';
import { ThemeSelector } from '@/lib/theme';

type IconName =
  | 'dashboard'
  | 'properties'
  | 'inspections'
  | 'assignments'
  | 'technicians'
  | 'users'
  | 'roles'
  | 'sync'
  | 'providers'
  | 'settings'
  | 'profile';

// A `permission` restricts an item to users who hold it (client-side gate only;
// the backend re-checks every request).
const sections: Array<{
  label: string;
  items: Array<{ label: string; href: string; icon: IconName; permission?: string }>;
}> = [
  {
    label: 'Overview',
    items: [
      {
        label: 'Dashboard',
        href: '/dashboard',
        icon: 'dashboard',
        permission: 'dashboard:read',
      },
    ],
  },
  {
    label: 'Property management',
    items: [
      {
        label: 'Properties',
        href: '/properties',
        icon: 'properties',
        permission: 'properties:read',
      },
    ],
  },
  {
    label: 'Inspection operations',
    items: [
      {
        label: 'Inspections',
        href: '/inspections',
        icon: 'inspections',
        permission: 'inspections:read',
      },
      {
        label: 'Assignments',
        href: '/assignments',
        icon: 'assignments',
        permission: 'inspections:assign',
      },
    ],
  },
  {
    label: 'People',
    items: [
      {
        label: 'Technicians',
        href: '/technicians',
        icon: 'technicians',
        permission: 'technicians:read',
      },
    ],
  },
  {
    label: 'Access control',
    items: [
      { label: 'Users', href: '/users', icon: 'users', permission: 'users:read' },
      { label: 'Roles', href: '/roles', icon: 'roles', permission: 'roles:read' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      {
        label: 'Propertyware',
        href: '/integrations/propertyware',
        icon: 'sync',
        permission: 'integrations:read',
      },
      {
        label: 'Providers',
        href: '/integrations/providers',
        icon: 'providers',
        permission: 'integrations:read',
      },
    ],
  },
  {
    label: 'Administration',
    items: [
      {
        label: 'Settings',
        href: '/settings',
        icon: 'settings',
        permission: 'integrations:read',
      },
      { label: 'Profile', href: '/profile', icon: 'profile' },
    ],
  },
];

const SIDEBAR_STORAGE_KEY = 'texasrenters-admin-sidebar-collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const auth = useAuth();
  const { has } = usePermissions();
  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !item.permission || has(item.permission)),
    }))
    .filter((section) => section.items.length > 0);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true');
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <AdminGuard>
      <div className={`app-shell ${collapsed ? 'sidebar-is-collapsed' : ''}`}>
        <aside
          aria-label="Application navigation"
          className={`sidebar ${open ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}
        >
          <div className="sidebar-brand-row">
            <Link aria-label="TexasRenters dashboard" className="brand" href="/dashboard">
              <div className="brand-mark">★</div>
              <div className="brand-copy">
                <strong>
                  <span>Texas</span>Renters
                </strong>
                <small>Inspection Admin</small>
              </div>
            </Link>
            <button
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="sidebar-collapse"
              onClick={toggleCollapsed}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              type="button"
            >
              <svg aria-hidden viewBox="0 0 24 24">
                <path d={collapsed ? 'm9 18 6-6-6-6' : 'm15 18-6-6 6-6'} />
              </svg>
            </button>
          </div>
          <nav aria-label="Primary navigation" className="primary-navigation">
            {visibleSections.map((section) => (
              <div className="nav-section" key={section.label}>
                <p>{section.label}</p>
                {section.items.map((item) => (
                  <Link
                    aria-current={pathname.startsWith(item.href) ? 'page' : undefined}
                    className={pathname.startsWith(item.href) ? 'active' : ''}
                    href={item.href}
                    key={item.href}
                    onClick={() => setOpen(false)}
                    title={collapsed ? item.label : undefined}
                  >
                    <AppIcon name={item.icon} />
                    <span className="nav-label">{item.label}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="sidebar-footer-dot" />
            <span className="sidebar-footer-copy">Secure admin workspace</span>
          </div>
        </aside>
        {open ? (
          <button
            aria-label="Close navigation"
            className="sidebar-overlay"
            onClick={() => setOpen(false)}
          />
        ) : null}
        <div className="shell-body">
          <header className="topbar">
            <button
              aria-expanded={open}
              aria-label="Open navigation"
              className="menu-button"
              onClick={() => setOpen(true)}
              type="button"
            >
              <svg aria-hidden viewBox="0 0 24 24">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div className="topbar-context">
              <span className="workspace-mark" aria-hidden>
                <svg viewBox="0 0 24 24" role="presentation">
                  <path d="M12 3 4.5 6v5.3c0 4.7 3.1 8.2 7.5 9.7 4.4-1.5 7.5-5 7.5-9.7V6L12 3Zm-3 9 2 2 4-4" />
                </svg>
              </span>
              <div>
                <span className="topbar-eyebrow">Administration console</span>
                <div className="topbar-status">
                  <span className="status-dot" />
                  Secure workspace
                </div>
              </div>
            </div>
            <div className="user-menu">
              <ThemeSelector />
              <div className="user-account">
                <div className="avatar">{auth.profile?.displayName.slice(0, 2).toUpperCase()}</div>
                <div className="user-identity">
                  <strong>{auth.profile?.displayName}</strong>
                  <small>
                    {auth.profile?.memberships.some(({ role }) => role === 'SYSTEM_ADMIN')
                      ? 'SYSTEM ADMIN'
                      : 'CUSTOM ACCESS'}
                  </small>
                </div>
              </div>
              <button
                aria-label="Sign out of administrator workspace"
                className="topbar-signout"
                onClick={() => void auth.signOut().then(() => router.replace('/login'))}
              >
                Sign out
              </button>
            </div>
          </header>
          <main className="main-content">{children}</main>
        </div>
      </div>
    </AdminGuard>
  );
}

function AppIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    dashboard: 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z',
    properties: 'M4 21V6l8-3 8 3v15M8 9h2m4 0h2M8 13h2m4 0h2M8 17h2m4 0h2',
    inspections: 'M9 5h6m-7-2h8v4H8V3ZM6 5H4v16h16V5h-2M8 12l2 2 5-5',
    assignments: 'M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3',
    technicians:
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m0-11.26a4 4 0 0 1 0 7.75',
    users:
      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    roles: 'M12 3 4 6v5c0 4.5 3 8 8 9 5-1 8-4.5 8-9V6l-8-3Zm-2 9 1.5 1.5L15 9',
    sync: 'M20 7h-5V2M4 17h5v5m10.5-9A8 8 0 0 0 6 6L4 7m.5 4A8 8 0 0 0 18 18l2-1',
    providers: 'm12 3 9 9-9 9-9-9 9-9Zm0 5v8m-4-4h8',
    settings:
      'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5 1.6 1.2-2 3.5-2-.8a8 8 0 0 1-2 1.2l-.3 2.1h-4l-.3-2.1a8 8 0 0 1-2-1.2l-2 .8-2-3.5L5.6 12A8 8 0 0 1 5.6 9L4 7.8l2-3.5 2 .8a8 8 0 0 1 2-1.2l.3-2.1h4l.3 2.1a8 8 0 0 1 2 1.2l2-.8 2 3.5L19.4 9a8 8 0 0 1 0 3Z',
    profile: 'M20 21a8 8 0 0 0-16 0m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  };
  return (
    <svg aria-hidden className="nav-icon" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
}
