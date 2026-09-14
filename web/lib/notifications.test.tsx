import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsProvider, useNotifications, type AppNotification } from './notifications';

/**
 * The bell, as each console account keeps it.
 *
 * Two accounts signed in on one browser shared one stored list, and a
 * notification reached only the consoles connected when it happened. Each
 * account now keeps its own list and folds in the organization's stored one.
 */

const auth = vi.hoisted(() => ({
  session: { authUserId: 'account-a' } as { authUserId: string } | null,
}));
vi.mock('./auth', () => ({ useAuth: () => auth }));

const chime = vi.fn(() => Promise.resolve());

class FakeAudio {
  currentTime = 0;
  play = chime;
}

const notification = (id: string, occurredAt: string): Omit<AppNotification, 'read'> => ({
  id,
  kind: 'INSPECTION_SUBMITTED',
  title: 'Inspection submitted',
  body: `Property ${id} · Submitted by Moses`,
  inspectionId: `inspection-${id}`,
  occurredAt,
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <NotificationsProvider>{children}</NotificationsProvider>
);

beforeEach(() => {
  window.localStorage.clear();
  auth.session = { authUserId: 'account-a' };
  chime.mockClear();
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the notification bell', () => {
  it("keeps each account's list apart on a shared browser", () => {
    const { result, rerender } = renderHook(() => useNotifications(), { wrapper });
    act(() => result.current?.push(notification('n-1', '2026-09-15T15:00:00.000Z')));
    expect(result.current?.notifications).toHaveLength(1);

    auth.session = { authUserId: 'account-b' };
    rerender();
    expect(result.current?.notifications).toEqual([]);
    expect(window.localStorage.getItem('texasrenters.notifications:account-b')).toBe('[]');

    auth.session = { authUserId: 'account-a' };
    rerender();
    expect(result.current?.notifications.map((item) => item.id)).toEqual(['n-1']);
  });

  it('folds in the stored list quietly, without repeating what it already has', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper });
    act(() => result.current?.push(notification('n-1', '2026-09-15T15:00:00.000Z')));
    expect(chime).toHaveBeenCalledTimes(1);

    act(() =>
      result.current?.merge([
        notification('n-3', '2026-09-15T16:00:00.000Z'),
        notification('n-1', '2026-09-15T15:00:00.000Z'),
        notification('n-2', '2026-09-15T14:00:00.000Z'),
      ]),
    );

    expect(result.current?.notifications.map((item) => item.id)).toEqual(['n-3', 'n-1', 'n-2']);
    expect(result.current?.unreadCount).toBe(3);
    // History arriving is not news: no chime for any of it.
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it('does not bring back what the account removed or cleared when the stored list loads again', () => {
    const { result, unmount } = renderHook(() => useNotifications(), { wrapper });
    act(() => {
      result.current?.push(notification('n-1', '2026-09-15T15:00:00.000Z'));
      result.current?.push(notification('n-2', '2026-09-15T15:10:00.000Z'));
    });
    act(() => result.current?.remove('n-1'));
    act(() => result.current?.clear());

    const stored = [
      notification('n-1', '2026-09-15T15:00:00.000Z'),
      notification('n-2', '2026-09-15T15:10:00.000Z'),
      notification('n-3', '2026-09-15T15:20:00.000Z'),
    ];
    act(() => result.current?.merge(stored));
    expect(result.current?.notifications.map((item) => item.id)).toEqual(['n-3']);

    // And after a reload, when every console loads the list again.
    unmount();
    const reloaded = renderHook(() => useNotifications(), { wrapper });
    act(() => reloaded.result.current?.merge(stored));
    expect(reloaded.result.current?.notifications.map((item) => item.id)).toEqual(['n-3']);
  });

  it('adopts the one list kept before accounts were separated', () => {
    window.localStorage.setItem(
      'texasrenters.notifications',
      JSON.stringify([{ ...notification('old', '2026-09-14T15:00:00.000Z'), read: true }]),
    );

    const { result } = renderHook(() => useNotifications(), { wrapper });

    expect(result.current?.notifications.map((item) => item.id)).toEqual(['old']);
    expect(window.localStorage.getItem('texasrenters.notifications')).toBeNull();
  });
});
