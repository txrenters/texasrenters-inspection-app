'use client';

import Link from 'next/link';
import { BellIcon, BellOffIcon, CheckCheckIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNotifications } from '@/lib/notifications';

/** "3m ago" — precise enough for something that just happened. */
function relativeTime(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * The office's one place to notice that something happened in the field.
 *
 * Before this the console learned about a submitted inspection by being
 * reloaded. The socket existed and carried exactly one event, `area:added`,
 * straight to a toast — which is gone the moment it fades, so anyone away from
 * their desk missed it entirely.
 *
 * Renders nothing without the provider, so the header stays mountable in the
 * public report route and in tests that do not wrap the admin providers.
 */
export function NotificationBell() {
  const store = useNotifications();
  if (!store) return null;

  const { notifications, unreadCount, markAllRead, remove, clear, permission, requestPermission } =
    store;

  return (
    <Popover
      onOpenChange={(open) => {
        // Marked read on open, not on close: the badge should stop nagging as
        // soon as they have been looked at.
        if (open && unreadCount) markAllRead();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={
            unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications, none unread'
          }
          className="relative"
          size="icon"
          variant="ghost"
        >
          <BellIcon className="size-4" />
          {unreadCount ? (
            // Count, not a dot: "one inspection came in" and "eleven did" are
            // different mornings. Capped so a long absence cannot stretch the
            // header.
            <span
              aria-hidden
              className="bg-destructive text-destructive-foreground absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-88 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {notifications.length ? (
            <Button className="h-7 text-xs" onClick={clear} size="sm" variant="ghost">
              Clear all
            </Button>
          ) : null}
        </div>

        {/* Asked for here rather than on load. A permission prompt that appears
            unprompted, with nothing on screen explaining it, is the kind people
            dismiss once and never see again — and the browser remembers. */}
        {permission !== 'granted' && permission !== null ? (
          <button
            className="hover:bg-accent/50 flex w-full items-center gap-2 border-b px-3 py-2 text-left"
            onClick={requestPermission}
            type="button"
          >
            <BellOffIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="text-muted-foreground text-xs">
              {permission === 'denied'
                ? 'Desktop alerts are blocked in your browser settings.'
                : 'Enable desktop alerts for when this tab is in the background.'}
            </span>
          </button>
        ) : null}

        <div className="max-h-96 overflow-y-auto">
          {notifications.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">
              Nothing yet. Field activity will appear here.
            </p>
          ) : (
            <ul>
              {notifications.map((notification) => (
                <li className="border-b last:border-b-0" key={notification.id}>
                  <div className="hover:bg-accent/50 flex items-start gap-2 px-3 py-2.5">
                    <Link
                      className="min-w-0 flex-1"
                      href={`/inspections/${notification.inspectionId}`}
                    >
                      <span className="flex items-center gap-2">
                        {!notification.read ? (
                          <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" />
                        ) : null}
                        <span className="truncate text-sm font-medium">{notification.title}</span>
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        {notification.body}
                      </span>
                      <span className="text-muted-foreground/70 mt-0.5 block text-[11px]">
                        {relativeTime(notification.occurredAt)}
                      </span>
                    </Link>
                    <Button
                      aria-label={`Dismiss: ${notification.title}`}
                      className="size-6 shrink-0"
                      onClick={() => remove(notification.id)}
                      size="icon"
                      variant="ghost"
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unreadCount ? (
          <div className="border-t p-1">
            <Button className="w-full justify-center text-xs" onClick={markAllRead} size="sm" variant="ghost">
              <CheckCheckIcon className="size-3.5" />
              Mark all read
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
