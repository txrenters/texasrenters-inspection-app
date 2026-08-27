'use client';

import type { TechnicianAssignments, TechnicianPosition } from '@texasrenters/shared';

import { formatRelative } from '@/lib/format';

/**
 * Who is out, where they were last, and how much work is theirs.
 *
 * Beside the map rather than on it. The map answers "where is everybody"; this
 * answers "who is everybody, and what are they doing" — and the two questions
 * want different shapes. A dispatcher scanning a list reads names and counts
 * far faster than they read a scatter of pins.
 *
 * Selecting a person is the join between the two: the map dims everything that
 * is not theirs, which is the only way to see one round when five hundred and
 * forty-six properties are drawn.
 */

/** Past this, a position is history rather than an answer to "where are they". */
const STALE_AFTER_MS = 30 * 60_000;

export interface RosterEntry {
  technicianId: string;
  displayName: string;
  stops: number;
  position: TechnicianPosition | null;
}

/**
 * Everyone worth showing, from the two sources the page already holds.
 *
 * Union rather than intersection, deliberately. Somebody with work and no
 * position has not started or has no signal; somebody with a position and no
 * work is out with nothing booked. Both are things a dispatcher needs to see,
 * and an inner join would hide exactly the two cases worth asking about.
 */
export function buildRoster(
  positions: readonly TechnicianPosition[],
  assignments: readonly TechnicianAssignments[],
): RosterEntry[] {
  const entries = new Map<string, RosterEntry>();

  for (const assignment of assignments)
    entries.set(assignment.technicianId, {
      technicianId: assignment.technicianId,
      displayName: assignment.displayName,
      stops: assignment.buildingIds.length,
      position: null,
    });

  for (const position of positions) {
    const existing = entries.get(position.technicianId);
    if (existing) existing.position = position;
    else
      entries.set(position.technicianId, {
        technicianId: position.technicianId,
        displayName: position.technician?.displayName ?? 'Unknown technician',
        stops: 0,
        position,
      });
  }

  // Working people first, then by name. Somebody with stops is the reason this
  // panel exists; somebody idle is context.
  return [...entries.values()].sort(
    (left, right) =>
      right.stops - left.stops || left.displayName.localeCompare(right.displayName),
  );
}

function Dot({ position }: { position: TechnicianPosition | null }) {
  if (!position)
    return (
      <span
        aria-hidden="true"
        className="border-muted-foreground/50 block size-2.5 shrink-0 rounded-full border"
      />
    );

  const stale = Date.now() - Date.parse(position.recordedAt) > STALE_AFTER_MS;
  return (
    <span
      aria-hidden="true"
      className={`block size-2.5 shrink-0 rounded-full ${
        stale ? 'bg-map-technician-stale' : 'bg-map-technician'
      }`}
    />
  );
}

export function TechnicianRoster({
  entries,
  onSelect,
  selectedId,
}: {
  entries: RosterEntry[];
  onSelect: (technicianId: string | null) => void;
  selectedId: string | null;
}) {
  if (!entries.length)
    return (
      <p className="text-muted-foreground p-4 text-sm">
        Nobody has work scheduled today and no handset has reported a position.
      </p>
    );

  return (
    <ul className="divide-border divide-y">
      {entries.map((entry) => {
        const selected = entry.technicianId === selectedId;
        return (
          <li key={entry.technicianId}>
            <button
              aria-pressed={selected}
              className={`hover:bg-muted/60 focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 ${
                selected ? 'bg-muted' : ''
              }`}
              // Clicking the selected row clears it, so the way out is the same
              // control as the way in rather than a separate "show all".
              onClick={() => onSelect(selected ? null : entry.technicianId)}
              type="button"
            >
              <Dot position={entry.position} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{entry.displayName}</span>
                <span className="text-muted-foreground block truncate text-xs">
                  {entry.position
                    ? formatRelative(entry.position.recordedAt)
                    : 'No position reported'}
                </span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {entry.stops === 0 ? '—' : `${entry.stops} ${entry.stops === 1 ? 'stop' : 'stops'}`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
