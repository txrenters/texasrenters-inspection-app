import { useEffect, useState } from 'react';
import { AlertTriangleIcon, ClockIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { Inspection } from '../domain/models';
import { registerIcons } from '../lib/icons';
import { inspectionUrgency } from '../utils/inspection-alerts';

registerIcons(AlertTriangleIcon, ClockIcon);

/**
 * Re-renders on the minute so a row flips to "Overdue" when it actually is.
 *
 * Without this the badge is only correct as of the last refetch: an inspection
 * scheduled for 9:00 would keep reading "Due soon" at 9:30 simply because
 * nothing re-rendered, which is precisely when the warning matters most.
 */
function useMinuteTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Aligned to the minute boundary rather than a fixed 60s from mount, so
    // every badge on the screen flips together.
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timeout = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    schedule();
    return () => clearTimeout(timeout);
  }, []);
  return now;
}

/** How late, in words a technician can act on. */
export function formatOverdueFor(scheduledAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(scheduledAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m late`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h late`;
  return `${Math.floor(hours / 24)}d late`;
}

/** Minutes until start, for the two-hour due-soon window. */
export function formatDueIn(scheduledAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((new Date(scheduledAt).getTime() - now) / 60_000));
  if (minutes < 60) return `Due in ${minutes}m`;
  return `Due in ${Math.floor(minutes / 60)}h ${minutes % 60}m`.replace(' 0m', '');
}

/**
 * Urgency plus the words for it, ticking on the minute.
 *
 * Exposed as a hook because both list screens put an `accessibilityLabel` on
 * the row and hide its descendants — a badge rendered inside is invisible to a
 * screen reader unless the row's own label carries it. Sharing the hook keeps
 * the spoken text and the visible badge from disagreeing.
 */
export function useInspectionUrgency(inspection: Pick<Inspection, 'status' | 'scheduledAt'>) {
  const now = useMinuteTick();
  const urgency = inspectionUrgency(inspection, now);
  if (urgency !== 'overdue' && urgency !== 'due_soon') return null;
  const overdue = urgency === 'overdue';
  const detail = overdue
    ? formatOverdueFor(inspection.scheduledAt, now)
    : formatDueIn(inspection.scheduledAt, now);
  return {
    overdue,
    detail,
    /** For the row's accessibilityLabel. */
    spoken: overdue ? `Overdue, ${detail}` : detail,
  };
}

/**
 * Overdue / due-soon indicator for an assigned inspection.
 *
 * Renders nothing once work has started or the window is far off, so the badge
 * only ever appears when it is asking for something.
 */
export function InspectionUrgencyBadge({
  inspection,
}: {
  inspection: Pick<Inspection, 'status' | 'scheduledAt'>;
}) {
  const state = useInspectionUrgency(inspection);
  if (!state) return null;
  const { overdue, detail: label } = state;

  return (
    <View
      accessible
      // Says "Overdue" in words, not only in red — the state has to survive
      // both a screen reader and a colour-blind technician.
      accessibilityLabel={overdue ? `Overdue, ${label}` : label}
      className={`flex-row items-center gap-1 rounded-full px-2 py-0.5 ${
        overdue ? 'bg-destructive/15' : 'bg-chart-4/15'
      }`}
    >
      {overdue ? (
        <AlertTriangleIcon size={11} className="text-destructive" />
      ) : (
        <ClockIcon size={11} className="text-chart-4" />
      )}
      <Text
        className={`text-xs font-semibold ${overdue ? 'text-destructive' : 'text-chart-4'}`}
      >
        {overdue ? `Overdue · ${label}` : label}
      </Text>
    </View>
  );
}
