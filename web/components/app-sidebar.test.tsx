import { fireEvent, render, screen, within } from '@testing-library/react';
import { ClipboardCheck } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { NavigationSection } from './app-sidebar';
import { SidebarMenu, SidebarMenuItem, SidebarProvider } from './ui/sidebar';
import { adminNavigation, type AdminNavigationItem } from '@/lib/admin-navigation';

const inspections: AdminNavigationItem = {
  title: 'Inspections',
  href: '/inspections',
  icon: ClipboardCheck,
  children: [
    { title: 'Move-in', type: 'MOVE_IN' },
    { title: 'Move-out', type: 'MOVE_OUT' },
  ],
};

function renderSection(props: Partial<Parameters<typeof NavigationSection>[0]> = {}) {
  return render(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarMenuItem>
          <NavigationSection
            activeChild={undefined}
            isActive={false}
            item={inspections}
            onNavigate={() => {}}
            {...props}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>,
  );
}

const header = () => screen.getByRole('button', { name: /inspections/i });

describe('NavigationSection', () => {
  it('is a toggle, not a destination', () => {
    renderSection();

    // The whole point of the split: the types below are where you go. A header
    // that also navigated would land you on the combined list.
    expect(header().tagName).toBe('BUTTON');
    expect(header()).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'Inspections' })).toBeNull();
  });

  it('collapses and expands the types, and says which state it is in', () => {
    renderSection();

    // Closed by default when you are not already inside the section.
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Move-out' })).toBeNull();

    fireEvent.click(header());
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Move-out' })).toBeVisible();

    fireEvent.click(header());
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Move-out' })).toBeNull();
  });

  it('points the toggle at the list it controls', () => {
    renderSection();
    fireEvent.click(header());

    // Without this pairing the button is a control with nothing attached to it
    // as far as a screen reader is concerned.
    const listId = header().getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    expect(document.getElementById(listId!)).toContainElement(
      screen.getByRole('link', { name: 'Move-in' }),
    );
  });

  it('opens already expanded when you are inside the section', () => {
    // Landing on a move-out list with its own navigation collapsed would hide
    // where you are.
    renderSection({ isActive: true, activeChild: { title: 'Move-out', type: 'MOVE_OUT' } });

    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Move-out' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Move-in' })).not.toHaveAttribute('aria-current');
  });

  it('links each type to the list carrying it, not to a nested route', () => {
    const onNavigate = vi.fn();
    renderSection({ onNavigate });
    fireEvent.click(header());

    // `/inspections/move-out` would be captured by the `[inspectionId]` segment.
    const list = document.getElementById(header().getAttribute('aria-controls')!)!;
    expect(within(list).getByRole('link', { name: 'Move-in' })).toHaveAttribute(
      'href',
      '/inspections?type=MOVE_IN',
    );

    // Closes the drawer on mobile; a no-op on desktop. The default action is
    // suppressed because jsdom implements no navigation and logs a bare
    // "Not implemented" against an otherwise passing run.
    const swallowNavigation = (event: Event) => event.preventDefault();
    document.addEventListener('click', swallowNavigation);
    fireEvent.click(within(list).getByRole('link', { name: 'Move-in' }));
    document.removeEventListener('click', swallowNavigation);
    expect(onNavigate).toHaveBeenCalled();
  });

  /**
   * Every section the navigation declares is reachable.
   *
   * The list grew from five to nine when the office added its off-cycle work,
   * and the row that carried the longest label wrapped inside a fixed-height
   * box and spilled over its neighbours. Layout is not something jsdom can
   * judge, but "the section exists and points somewhere" is — and a section
   * quietly missing from the sidebar is the failure that would go unnoticed
   * longest, because nothing else links to these lists.
   */
  it.each(
    adminNavigation
      .flatMap((group) => group.items)
      .filter((item) => item.children?.length)
      .map((item) => [item.title, item] as const),
  )('offers every declared %s section', (_title, declared) => {
    // The real navigation rather than this file's two-child fixture: the thing
    // worth asserting is that the config and the component agree, and a
    // fixture cannot disagree with itself.
    //
    // Every sectioned item, not the first one found — written that way, this
    // silently only ever covered Inspections, and Assignments could have
    // shipped with no sub-items at all and still gone green.
    renderSection({ item: declared });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(declared.title, 'i') }));
    const list = document.getElementById(
      screen
        .getByRole('button', { name: new RegExp(declared.title, 'i') })
        .getAttribute('aria-controls')!,
    )!;

    expect(declared.children!.length).toBeGreaterThan(5);
    for (const child of declared.children!) {
      expect(within(list).getByRole('link', { name: child.title })).toHaveAttribute(
        'href',
        child.type ? `${declared.href}?type=${child.type}` : declared.href,
      );
    }
  });
});
