'use client';

import type { TechnicianPosition } from '@texasrenters/shared';
import { useMemo, useRef } from 'react';

import { appendSample, sampleFrom, type MotionSample } from '@/lib/technician-motion';

/**
 * The last few minutes of each technician's fixes, as this console saw them.
 *
 * The positions list holds only each technician's newest fix, and replaces it
 * as the next arrives over the socket. Motion needs the one before as well --
 * how far they went, and which way -- so every fix that arrives is kept here,
 * per technician, for `TRACK_WINDOW_MS`.
 *
 * A technician the presence filter hides keeps their trail, so showing them
 * again does not start from nothing.
 */
export function useMotionTracks(positions: readonly TechnicianPosition[]) {
  const tracks = useRef(new Map<string, readonly MotionSample[]>());

  return useMemo(() => {
    const next = new Map(tracks.current);
    for (const position of positions) {
      const track = next.get(position.technicianId) ?? [];
      // `appendSample` hands back the same array for a fix it already holds,
      // which the refetch and every other socket frame mostly are -- so running
      // this twice for one render adds nothing twice.
      next.set(position.technicianId, appendSample(track, sampleFrom(position)));
    }
    tracks.current = next;
    return next as ReadonlyMap<string, readonly MotionSample[]>;
  }, [positions]);
}
