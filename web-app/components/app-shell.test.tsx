import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from './app-shell';

vi.mock('@/components/app-header', () => ({
  AppHeader: () => <header data-testid="app-header" />,
}));

vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/lib/auth', () => ({
  AdminGuard: ({ children }: { children: React.ReactNode }) => children,
}));

describe('AppShell', () => {
  it('renders one provider with the sidebar directly adjacent to the main inset', () => {
    const { container } = render(
      <AppShell>
        <div data-testid="page-content">Page content</div>
      </AppShell>,
    );

    const wrapper = container.querySelector('[data-slot="sidebar-wrapper"]');
    const inset = container.querySelector('[data-slot="sidebar-inset"]');

    expect(wrapper).toBeInTheDocument();
    expect(wrapper?.children).toHaveLength(2);
    expect(screen.getAllByTestId('app-sidebar')).toHaveLength(1);
    expect(inset).toHaveClass('min-w-0', 'bg-background');
    expect(inset).not.toHaveClass('m-2');
    expect(inset).not.toHaveClass('ml-2');
    expect(inset).not.toHaveClass('gap-2');
    expect(screen.getByTestId('app-header')).toBeInTheDocument();
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });
});
