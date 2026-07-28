import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';

import { AppSidebar } from './app-sidebar';

const replace = vi.fn();
const signOut = vi.fn(async () => undefined);
let pathname = '/inspections/inspection-1';
let isMobile = false;

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    profile: {
      displayName: 'TexasRenters Super Admin',
      memberships: [{ role: 'SYSTEM_ADMIN' }],
    },
    signOut,
  }),
  usePermissions: () => ({
    has: (permission: string) =>
      [
        'dashboard:read',
        'properties:read',
        'inspections:read',
        'inspections:assign',
        'technicians:read',
        'users:read',
        'roles:read',
        'integrations:read',
      ].includes(permission),
  }),
}));

function renderSidebar(defaultOpen = true) {
  return render(
    <SidebarProvider defaultOpen={defaultOpen}>
      <AppSidebar />
      <SidebarTrigger aria-label="Test sidebar toggle" />
    </SidebarProvider>,
  );
}

describe('AppSidebar', () => {
  beforeEach(() => {
    pathname = '/inspections/inspection-1';
    isMobile = false;
    replace.mockReset();
    signOut.mockClear();
    document.cookie = 'sidebar_state=; path=/; max-age=0';
  });

  it('marks the owning section active on a nested route', () => {
    renderSidebar();

    expect(screen.getByRole('link', { name: 'Inspections' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Assignments' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('uses the flush sidebar variant and shows a brand-only header', () => {
    const { container } = renderSidebar();
    const sidebar = container.querySelector('[data-slot="sidebar"][data-state]');
    const sidebarContainer = container.querySelector('[data-slot="sidebar-container"]');
    const sidebarGap = container.querySelector('[data-slot="sidebar-gap"]');
    const sidebarContent = container.querySelector('[data-slot="sidebar-content"]');

    expect(sidebar).toHaveAttribute('data-variant', 'sidebar');
    expect(container.querySelectorAll('[data-slot="sidebar"][data-state]')).toHaveLength(1);
    expect(sidebarContainer).not.toHaveClass('p-2');
    expect(sidebarGap).toHaveClass('bg-transparent');
    expect(sidebarContent).toHaveClass(
      '[-ms-overflow-style:none]',
      '[scrollbar-width:none]',
      '[&::-webkit-scrollbar]:hidden',
    );

    // The header is brand-only now: its former menu offered just the dashboard
    // and settings, both already reachable from the nav tree and account menu.
    expect(screen.queryByRole('button', { name: 'Open workspace menu' })).toBeNull();
    const brand = screen.getByRole('link', {
      name: 'TexasRenters Inspection Admin — go to dashboard',
    });
    expect(brand).toHaveAttribute('href', '/dashboard');
    expect(within(brand).getByRole('img', { name: 'TexasRenters' })).toBeVisible();
  });

  it('collapses with the trigger, exposes icon tooltips, persists preference, and supports Ctrl+B', async () => {
    const { container } = renderSidebar();
    const sidebar = container.querySelector('[data-slot="sidebar"][data-state]');

    expect(sidebar).toHaveAttribute('data-state', 'expanded');
    fireEvent.click(screen.getByRole('button', { name: 'Test sidebar toggle' }));
    expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    expect(document.cookie).toContain('sidebar_state=false');
    fireEvent.focus(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Dashboard');

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(sidebar).toHaveAttribute('data-state', 'expanded');
  });

  it('toggles icon collapse from the official sidebar rail', () => {
    const { container } = renderSidebar();
    const sidebar = container.querySelector('[data-slot="sidebar"][data-state]');
    const rail = screen.getByRole('button', { name: 'Toggle Sidebar' });

    expect(rail).toHaveClass('border-0', 'bg-transparent');
    fireEvent.click(rail);
    expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  });

  it('moves account actions into the footer dropdown and signs out safely', async () => {
    renderSidebar();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Open account menu' }));
    const signOutItem = await screen.findByRole('menuitem', { name: /sign out/i });
    fireEvent.click(signOutItem);

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('uses the responsive sheet and closes it after mobile navigation', async () => {
    isMobile = true;
    pathname = '/dashboard';
    renderSidebar();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test sidebar toggle' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    const propertiesLink = screen.getByRole('link', { name: 'Properties' });
    propertiesLink.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(propertiesLink);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
