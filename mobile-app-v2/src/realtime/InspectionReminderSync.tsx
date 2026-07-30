import { useEffect } from 'react';

import { isDemoMode } from '../config/environment';
import { useInspections } from '../features/queries';
import { usePreferencesStore } from '../stores/preferences.store';
import { syncInspectionReminders } from './inspection-reminders';

/**
 * Headless: keeps the device's scheduled inspection reminders and app-icon badge
 * in sync with the technician's assignments. Mounted once, app-wide, so
 * reminders are (re)scheduled on launch and whenever assignments change.
 */
export function InspectionReminderSync(): null {
  const inspections = useInspections();
  const data = inspections.data;
  // Depending on the preference matters: toggling notifications off has to
  // re-run the sync so it can cancel reminders already sitting on the device,
  // rather than waiting for the next assignment change.
  const notificationsEnabled = usePreferencesStore((state) => state.notificationsEnabled);

  useEffect(() => {
    if (isDemoMode || !data) return;
    void syncInspectionReminders(data).catch(() => undefined);
  }, [data, notificationsEnabled]);

  return null;
}
