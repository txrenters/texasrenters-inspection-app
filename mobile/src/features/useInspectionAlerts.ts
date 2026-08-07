import { useEffect, useMemo, useState } from 'react';

import { collectInspectionAlerts, type InspectionAlerts } from '../utils/inspection-alerts';
import { useActiveInspections } from './queries';

/**
 * Derives overdue / due-soon assignment counts for the signed-in technician.
 * Re-evaluated every minute so an inspection crosses into "overdue" on time even
 * without a refetch. Read-only — scheduling notifications lives elsewhere.
 */
export function useInspectionAlerts(): InspectionAlerts {
  // Only SCHEDULED and IN_PROGRESS can be late, which is exactly what this
  // asks the server for — see WARNABLE_STATUSES in utils/inspection-alerts.
  const inspections = useActiveInspections();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return useMemo(
    () => collectInspectionAlerts(inspections.data ?? [], now),
    [inspections.data, now],
  );
}
