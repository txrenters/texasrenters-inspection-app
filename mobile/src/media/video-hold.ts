import { useSyncExternalStore } from 'react';

import type { Connectivity, UploadGate } from '../lib/connectivity';
import { currentPowerState, subscribeToPowerState, type PowerState } from '../lib/power-state';
import { useNetworkStore } from '../stores/network.store';

/**
 * Below this charge, in Low Power Mode on mobile data, videos wait.
 *
 * From 2026-10-06 they waited in Low Power Mode at any charge, and the office
 * said (2026-11-13) that slow video uploads were holding up its work: a
 * move-in or move-out cannot be submitted until its videos arrive, and Low
 * Power Mode is on for much of a technician's day. Now they go, unless the
 * battery is nearly flat.
 */
export const VIDEO_HOLD_BELOW_PERCENT = 20;

/**
 * Videos wait for Wi-Fi or a charger in Low Power Mode with the battery below
 * 20% (the office, 2026-10-06 and 2026-11-14), unless the technician says send
 * them now.
 *
 * A walkthrough is tens of megabytes over cellular, on a phone whose owner has
 * told it the battery matters most. Photographs are not held: they are small,
 * and an area waits on them. A charge the phone will not report holds nothing,
 * as before the hold existed. "Send now" is one tap, for as long as Low Power
 * Mode stays on.
 *
 * Every video, whatever the job: the queue does not know a recording's job
 * type, and the videos it holds are move-in and move-out walkthroughs (an
 * occupied visit films only when the technician chooses to, HVAC never).
 */
export function evaluateVideoGate(input: {
  power: PowerState;
  connectivity: Pick<Connectivity, 'isMetered'>;
  sendNow: boolean;
}): UploadGate {
  const { power, connectivity, sendNow } = input;
  if (sendNow || !power.lowPower || power.charging || !connectivity.isMetered) return { allowed: true };
  if (power.batteryPercent === null || power.batteryPercent >= VIDEO_HOLD_BELOW_PERCENT) return { allowed: true };
  return {
    allowed: false,
    reason: `Low Power Mode is on and the battery is under ${VIDEO_HOLD_BELOW_PERCENT}%, so videos wait for Wi-Fi or a charger. Send them now to use mobile data.`,
  };
}

let sendNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** The technician's "Send now": videos go over mobile data until Low Power Mode ends. */
export function sendVideosNow(): void {
  if (sendNow) return;
  sendNow = true;
  notify();
}

// Asked once, not for good: the next time Low Power Mode is turned on, the
// videos wait again unless asked again.
subscribeToPowerState(() => {
  if (sendNow && !currentPowerState().lowPower) {
    sendNow = false;
    notify();
  }
});

/** Whether a video may go up now. Read by the upload queue before every video. */
export function videoGate(): UploadGate {
  return evaluateVideoGate({
    power: currentPowerState(),
    connectivity: useNetworkStore.getState(),
    sendNow,
  });
}

/** Called whenever anything the gate reads changes. Returns the unsubscribe. */
export function subscribeToVideoGate(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribePower = subscribeToPowerState(listener);
  const unsubscribeNetwork = useNetworkStore.subscribe(listener);
  return () => {
    listeners.delete(listener);
    unsubscribePower();
    unsubscribeNetwork();
  };
}

/** The gate, re-rendering when it opens or closes. */
export function useVideoGate(): UploadGate {
  const allowed = useSyncExternalStore(subscribeToVideoGate, () => videoGate().allowed);
  // Rebuilt from the boolean, so the snapshot is stable between renders.
  return allowed ? { allowed: true } : videoGate();
}
