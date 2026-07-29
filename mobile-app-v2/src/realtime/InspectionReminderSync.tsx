import { useEffect } from 'react';

import { isDemoMode } from '../config/environment';
import { useInspections } from '../features/queries';
import { syncInspectionReminders } from './inspection-reminders';

/**
 * Headless: keeps the device's scheduled inspection reminders and app-icon badge
 * in sync with the technician's assignments. Mounted once, app-wide, so
 * reminders are (re)scheduled on launch and whenever assignments change.
 */
export function InspectionReminderSync(): null {
  const inspections = useInspections();
  const data = inspections.data;

  useEffect(() => {
    if (isDemoMode || !data) return;
    void syncInspectionReminders(data).catch(() => undefined);
  }, [data]);

  return null;
}
