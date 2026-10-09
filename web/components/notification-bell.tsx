'use client';

import Link from 'next/link';
import { BellIcon, BellOffIcon, CheckCheckIcon, XIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useNotifications } from '@/lib/notifications';

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
        // Marked read when the popover CLOSES (console-development). Marking on
        // open cleared every unread dot in the list the instant it appeared,
        // so nobody could see which ones were new, and "Mark all read" never
        // showed. Closing it is the moment they have been looked at.
        if (!open && unreadCount) markAllRead();
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
            // A dot, since console-development: a filled 9+ badge was the
            // loudest thing in the header all day. How many is still one look
            // away, in the button's name and beside the popover's title, where
            // "one came in" and "eleven did" can still be told apart.
            <span
              aria-hidden
              className="bg-warning ring-background absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2"
            />
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-88 max-w-[calc(100vw-1rem)] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">Notifications</span>
            {notifications.length ? (
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {notifications.length}
              </span>
            ) : null}
          </span>
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
                          <span aria-hidden className="bg-highlight size-1.5 shrink-0 rounded-full" />
                        ) : null}
                        <span className="truncate text-sm font-medium">{notification.title}</span>
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs">
                        {notification.body}
                      </span>
                      {/* The console's relative time, with the Texas moment on
                          hover (console-development). */}
                      <span
                        className="text-muted-foreground/70 mt-0.5 block text-[11px]"
                        title={formatDateTime(notification.occurredAt)}
                      >
                        {formatRelative(notification.occurredAt)}
                      </span>
                    </Link>
                    <Button
                      aria-label={`Dismiss: ${notification.title}`}
                      // 32px: a 24px target beside a link was easy to miss
                      // and open the inspection instead (console-development).
                      className="size-8 shrink-0"
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
