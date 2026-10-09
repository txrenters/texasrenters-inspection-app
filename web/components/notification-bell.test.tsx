import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationBell } from './notification-bell';

/**
 * Opening the bell used to mark everything read, so the unread dots vanished
 * the moment the list appeared and "Mark all read" could never be seen
 * (console-development). It now marks them read when the popover closes.
 */
const store = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/lib/notifications', () => ({ useNotifications: () => store.value }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const markAllRead = vi.fn();

beforeEach(() => {
  markAllRead.mockReset();
  store.value = {
    notifications: [
      {
        id: 'n-1',
        kind: 'INSPECTION_SUBMITTED',
        title: 'Move-out submitted',
        body: 'Unit A was submitted.',
        inspectionId: 'inspection-1',
        occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        read: false,
      },
    ],
    unreadCount: 1,
    markAllRead,
    remove: vi.fn(),
    clear: vi.fn(),
    permission: 'granted',
    requestPermission: vi.fn(),
  };
});

describe('the notification bell', () => {
  it('leaves the list unread while it is being looked at', () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));

    expect(screen.getByText('Move-out submitted')).toBeInTheDocument();
    expect(markAllRead).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Mark all read' })).toBeInTheDocument();
  });

  it('marks everything read when the popover closes', () => {
    render(<NotificationBell />);
    const bell = screen.getByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(bell);
    fireEvent.click(bell);

    expect(markAllRead).toHaveBeenCalledTimes(1);
  });

  it('says how long ago in the console’s words', () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
  });
});
