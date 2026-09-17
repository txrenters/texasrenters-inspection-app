import { FolderOpenIcon } from 'lucide-react-native';
import { useMemo } from 'react';
import { Text, View } from 'react-native';

import { Card } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import type { JobFile, JobLastVisit } from '@/src/domain/models';
import { jobFileRows, lastVisitNotes } from '@/src/utils/job-file';

registerIcons(FolderOpenIcon);

/**
 * What the office already knows about this address.
 *
 * Beside the visit's own Details rather than inside them, because the two make
 * different claims: the Details are what a coordinator wrote for this visit,
 * this is the file the office keeps — the plan, the filters it believes are
 * fitted, and what the last visit asked somebody to look at. A technician had
 * none of it at the door until the office asked for it (2026-09-18).
 *
 * Renders nothing at all when the office holds nothing certain: the tenant
 * report records a building rather than a unit, so a duplex often resolves to
 * no file, and an empty card reads as a fault in the app.
 */
export function JobFileCard({
  file,
  lastVisit,
  className = '',
}: {
  file?: JobFile;
  lastVisit?: JobLastVisit;
  className?: string;
}) {
  const rows = useMemo(() => jobFileRows(file), [file]);
  const previous = useMemo(() => lastVisitNotes(lastVisit), [lastVisit]);
  if (!rows.length && !previous) return null;

  return (
    <Card className={`gap-4 ${className}`}>
      <View className="flex-row items-center gap-2">
        <FolderOpenIcon size={16} className="text-muted-foreground" />
        <Text className="text-base font-semibold text-foreground">From the office</Text>
      </View>

      {rows.length ? (
        <View className="gap-2">
          {rows.map((row) => (
            // Label and value on one row, the value allowed to wrap: a lease's
            // two tenants and a filter location are both longer than they look
            // on a handset held in one hand.
            <View className="flex-row items-start gap-3" key={row.label}>
              <Text className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                {row.label}
              </Text>
              <Text className="flex-1 text-sm leading-relaxed text-foreground">{row.value}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {previous ? (
        // Marked rather than listed with the rest: this is something the last
        // technician asked to be looked at, not a fact about the tenancy.
        <View className="gap-2 rounded-xl border border-chart-4/30 bg-chart-4/10 p-3">
          <Text className="text-xs font-semibold uppercase tracking-wide text-chart-4">
            Last visit · {previous.when}
          </Text>
          {previous.notes.map((note) => (
            <View className="gap-0.5" key={note.label}>
              <Text className="text-xs uppercase tracking-wide text-muted-foreground">
                {note.label}
              </Text>
              <Text className="text-sm leading-relaxed text-foreground">{note.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
