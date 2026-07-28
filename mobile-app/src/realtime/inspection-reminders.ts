import type { Inspection } from '../domain/models';
import { collectInspectionAlerts, UPCOMING_REMINDER_LEAD_MS } from '../utils/inspection-alerts';
import { loadNotifications } from './notifications';

// Tag on the notification payload so we only ever cancel/replace reminders we
// scheduled, never the immediate "new assignment" notifications.
const REMINDER_TAG = 'inspection-reminder';

/**
 * Reconciles the device's scheduled reminder notifications with the technician's
 * current assignments, and reflects the number of currently-overdue inspections
 * on the app icon badge.
 *
 * For each not-yet-started (SCHEDULED) inspection this schedules, when still in
 * the future: an "upcoming" heads-up one hour before, and an "overdue" alert at
 * the scheduled time. Already-overdue inspections are surfaced in-app and via
 * the badge (we do not fire a notification for them, to avoid alert spam on
 * every refresh). Safe to call repeatedly — it is idempotent.
 */
export async function syncInspectionReminders(inspections: Inspection[]): Promise<void> {
  const Notifications = await loadNotifications();
  if (!Notifications) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;

  // Clear our previously-scheduled reminders, leaving any other notifications
  // (e.g. immediate assignment alerts) untouched.
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((entry) => entry.content.data?.kind === REMINDER_TAG)
      .map((entry) => Notifications.cancelScheduledNotificationAsync(entry.identifier)),
  );

  const now = Date.now();
  for (const inspection of inspections) {
    if (inspection.status !== 'SCHEDULED') continue;
    const scheduledAt = new Date(inspection.scheduledAt).getTime();
    if (!Number.isFinite(scheduledAt)) continue;
    const address = inspection.property?.address ?? 'an assigned property';
    const data = { kind: REMINDER_TAG, inspectionId: inspection.id };

    const upcomingAt = scheduledAt - UPCOMING_REMINDER_LEAD_MS;
    if (upcomingAt > now) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Upcoming inspection',
          body: `Inspection at ${address} is scheduled soon. Plan to be on site.`,
          data,
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(upcomingAt),
          channelId: 'assignments',
        },
      });
    }

    if (scheduledAt > now) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Inspection now due',
          body: `Inspection at ${address} has reached its scheduled time. Start it to stay on track.`,
          data,
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(scheduledAt),
          channelId: 'assignments',
        },
      });
    }
  }

  const { overdueCount } = collectInspectionAlerts(inspections, now);
  await Notifications.setBadgeCountAsync(overdueCount).catch(() => undefined);
}
