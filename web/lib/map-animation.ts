'use client';

import { useEffect, useRef, useState } from 'react';

import { distanceMeters } from '@/lib/technician-motion';

/**
 * Movement on the map that reads as movement.
 *
 * A moving handset reports every ten to fifteen seconds, which at city speed is
 * a couple of hundred metres between fixes. Placed directly, the marker
 * teleports; slid there over a second, it reads as a van driving -- which is
 * what it is. Nothing is invented: the slide ends exactly on the reported fix,
 * and never extrapolates past it.
 */

/** How long a marker takes to reach a new fix. */
export const GLIDE_MS = 1_000;

/**
 * Further than this is a jump, not a drive: a handset back from a dead zone, a
 * technician who opened the app across town. Sliding across a city in a second
 * would draw a journey nobody made.
 */
export const GLIDE_UP_TO_M = 2_000;

const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

function prefersReducedMotion() {
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** A position that slides to each new value rather than jumping. */
export function useGlide(latitude: number, longitude: number) {
  const [shown, setShown] = useState({ lat: latitude, lng: longitude });
  const current = useRef(shown);

  useEffect(() => {
    const from = current.current;
    const to = { lat: latitude, lng: longitude };
    if (from.lat === to.lat && from.lng === to.lng) return;

    const far =
      distanceMeters(
        { latitude: from.lat, longitude: from.lng },
        { latitude, longitude },
      ) > GLIDE_UP_TO_M;
    if (far || prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      current.current = to;
      setShown(to);
      return;
    }

    const started = performance.now();
    let frame = requestAnimationFrame(function step(time) {
      const progress = easeOut(Math.min(1, Math.max(0, (time - started) / GLIDE_MS)));
      // From wherever it was drawn when this fix arrived, which is mid-slide if
      // the last one had not finished -- so a quick run of fixes never snaps.
      const next = {
        lat: from.lat + (to.lat - from.lat) * progress,
        lng: from.lng + (to.lng - from.lng) * progress,
      };
      current.current = next;
      setShown(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [latitude, longitude]);

  return shown;
}

/**
 * The rotation to draw for a heading, continuing from the last one drawn.
 *
 * A CSS transition from 350° to 10° turns the long way round, 340° backwards,
 * and an arrow spinning a full circle to make a slight right turn reads as a
 * U-turn. Adding the shortest signed difference to the previous rotation
 * instead gives 370°, which is the same direction reached the short way.
 */
export function continueRotation(previous: number, heading: number) {
  const difference = ((((heading - previous) % 360) + 540) % 360) - 180;
  return previous + difference;
}

export function useContinuousRotation(heading: number) {
  const rotation = useRef(heading);
  // Recomputed from the ref on every render. Idempotent: rendering twice with
  // the same heading adds nothing the second time.
  rotation.current = continueRotation(rotation.current, heading);
  return rotation.current;
}
