import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarProvider } from '@/components/ui/sidebar';

import { CreateMenu } from './create-menu';
import { JobberShell } from './jobber-shell';
import { JobberSidebar } from './jobber-sidebar';
import { JobberSettingsMenu } from './settings-menu';

/**
 * The Jobber-style shell (lib/console-shell.ts): Jobber's frame around the same
 * console. What these hold it to is that nothing was lost in the move -- every
 * page is still reachable, behind the same permissions -- and that the pieces
 * borrowed from Jobber do what Jobber's do.
 */

const granted = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    signOut: vi.fn(async () => {}),
    profile: { displayName: 'Ada Office', email: 'ada@example.test', memberships: [] },
  }),
  usePermissions: () => ({ has: (key: string) => granted.keys.has(key) }),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
const location = vi.hoisted(() => ({ pathname: '/inspections' }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/queries', () => ({ useUnassignedCount: () => ({ data: 4 }) }));
// The top bar's search, bell and clocks need the whole app around them; the
// frame test is about the frame.
vi.mock('./jobber-top-bar', () => ({ JobberTopBar: () => <header>top bar</header> }));

const EVERYTHING = [
  'dashboard:read',
  'inspections:read',
  'inspections:manage',
  'planning:read',
  'planning:publish',
  'properties:read',
  'technicians:read',
  'technicians:locate',
  'users:read',
  'roles:read',
  'system:manage',
  'integrations:read',
];

const openMenu = (button: HTMLElement) =>
  fireEvent.pointerDown(button, { button: 0, pointerId: 1, pointerType: 'mouse' });

beforeEach(() => {
  granted.keys = new Set(EVERYTHING);
  location.pathname = '/inspections';
  router.refresh.mockReset();
  document.cookie = 'console_shell=; max-age=0; path=/';
});

describe('the Create menu', () => {
  it('offers each inspection type, opening the ordinary create form', () => {
    render(
      <SidebarProvider>
        <CreateMenu />
      </SidebarProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const menu = screen.getByRole('dialog', { name: 'Create an inspection' });
    const links = within(menu).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Move-in', '/inspections/new?type=MOVE_IN'],
      ['Occupied', '/inspections/new?type=OCCUPIED'],
      ['Back-to-market', '/inspections/new?type=BACK_TO_MARKET'],
      ['Move-out', '/inspections/new?type=MOVE_OUT'],
      ['HVAC', '/inspections/new?type=HVAC'],
    ]);
  });

  it('is not offered to an account that may not create inspections', () => {
    granted.keys = new Set(['inspections:read']);
    render(
      <SidebarProvider>
        <CreateMenu />
      </SidebarProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });
});

describe('the sidebar', () => {
  const links = () =>
    screen.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);

  it('lists the day, the records and the tools, in Jobber order', () => {
    render(
      <SidebarProvider>
        <JobberSidebar />
      </SidebarProvider>,
    );

    expect(links()).toEqual([
      ['Home', '/dashboard'],
      ['Schedule', '/schedule'],
      ['Properties', '/properties'],
      ['Tenants', '/tenants'],
      ['Reschedules', '/reschedules'],
      // Inspections is a section header (a toggle), open because we are in it.
      ['All inspections', '/inspections'],
      ['Move-in', '/inspections?type=MOVE_IN'],
      ['Occupied', '/inspections?type=OCCUPIED'],
      ['Back-to-market', '/inspections?type=BACK_TO_MARKET'],
      ['Move-out', '/inspections?type=MOVE_OUT'],
      ['HVAC', '/inspections?type=HVAC'],
      ['Move-ins & move-outs', '/lease-schedule'],
      ['Benefit package plan', '/planning'],
      ['TBP group maker', '/group-maker'],
      ['Technician map', '/map'],
      ['Timesheet', '/timesheet'],
    ]);
    // The work waiting for a technician, beside Inspections, as in classic.
    expect(screen.getByRole('button', { name: /Inspections\s*4 waiting for a technician/ })).toBeVisible();
  });

  it('marks the page you are on', () => {
    location.pathname = '/schedule';
    render(
      <SidebarProvider>
        <JobberSidebar />
      </SidebarProvider>,
    );
    expect(screen.getByRole('link', { name: 'Schedule' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('shows only what the account may open', () => {
    granted.keys = new Set(['inspections:read']);
    render(
      <SidebarProvider>
        <JobberSidebar />
      </SidebarProvider>,
    );
    expect(links().map(([, href]) => href)).not.toContain('/dashboard');
    expect(links().map(([, href]) => href)).not.toContain('/properties');
    expect(screen.getByRole('link', { name: 'Timesheet' })).toBeVisible();
  });
});

describe('the gear', () => {
  it('holds the administration pages, grouped as the classic sidebar groups them', () => {
    render(<JobberSettingsMenu />);
    openMenu(screen.getByRole('button', { name: 'Settings and account' }));

    const team = screen.getByRole('group', { name: 'Team' });
    expect(within(team).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Technicians',
      'Users',
      'Roles',
    ]);
    expect(screen.getByRole('group', { name: 'Integrations' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'IT tools' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile');
  });

  it('lists nothing an account may not open', () => {
    granted.keys = new Set(['inspections:read']);
    render(<JobberSettingsMenu />);
    openMenu(screen.getByRole('button', { name: 'Settings and account' }));

    expect(screen.queryByRole('group', { name: 'Team' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
  });

  it('switches back to the classic layout', () => {
    render(<JobberSettingsMenu />);
    openMenu(screen.getByRole('button', { name: 'Settings and account' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Classic layout' }));

    expect(document.cookie).toContain('console_shell=classic');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the frame', () => {
  /**
   * Dialogs, menus and toasts portal to <body>, outside the frame, so the
   * palette has to reach <html> too -- and must leave with the shell, or the
   * classic console would come back wearing Jobber's colours.
   */
  it('puts the Jobber palette on the page while it is showing, and takes it away after', () => {
    const { container, unmount } = render(<JobberShell>page</JobberShell>);

    expect(container.querySelector('[data-shell="jobber"]')).not.toBeNull();
    expect(document.documentElement.dataset.shell).toBe('jobber');

    unmount();
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
