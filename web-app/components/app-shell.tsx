'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { AdminGuard, useAuth } from '@/lib/auth';

const sections = [
  { label: 'Overview', items: [['Dashboard', '/dashboard', '⌂']] },
  { label: 'Property management', items: [['Properties', '/properties', '▦']] },
  {
    label: 'Inspection operations',
    items: [
      ['Inspections', '/inspections', '✓'],
      ['Assignments', '/assignments', '⇄'],
    ],
  },
  { label: 'People', items: [['Technicians', '/technicians', '◎']] },
  {
    label: 'Integrations',
    items: [
      ['Propertyware', '/integrations/propertyware', '↻'],
      ['Providers', '/integrations/providers', '◇'],
    ],
  },
  {
    label: 'Administration',
    items: [
      ['Settings', '/settings', '⚙'],
      ['Profile', '/profile', '○'],
    ],
  },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const auth = useAuth();
  return (
    <AdminGuard>
      <div className="app-shell">
        <aside className={`sidebar ${open ? 'sidebar-open' : ''}`}>
          <div className="brand">
            <div className="brand-mark">★</div>
            <div>
              <strong>
                <span>Texas</span>Renters
              </strong>
              <small>Inspection Admin</small>
            </div>
          </div>
          <nav aria-label="Primary navigation">
            {sections.map((section) => (
              <div className="nav-section" key={section.label}>
                <p>{section.label}</p>
                {section.items.map(([label, href, icon]) => (
                  <Link
                    className={pathname.startsWith(href) ? 'active' : ''}
                    href={href}
                    key={href}
                    onClick={() => setOpen(false)}
                  >
                    <span aria-hidden>{icon}</span>
                    {label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
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
              className="menu-button"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              ☰
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
              <div className="user-account">
                <div className="avatar">{auth.profile?.displayName.slice(0, 2).toUpperCase()}</div>
                <div className="user-identity">
                  <strong>{auth.profile?.displayName}</strong>
                  <small>{auth.profile?.memberships[0]?.role.replaceAll('_', ' ')}</small>
                </div>
              </div>
              <button
                className="topbar-signout"
                aria-label="Sign out of administrator workspace"
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
