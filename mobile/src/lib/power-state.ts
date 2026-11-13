import { useSyncExternalStore } from 'react';
import * as Battery from 'expo-battery';

import { batteryPercentOf } from '../location/battery';

/**
 * Whether the phone is saving power, whether it is plugged in, and how much
 * charge it has.
 *
 * Read by the work that can afford to wait when the battery cannot (the office,
 * 2026-10-06): location slows to a fix every half minute in Low Power Mode, and
 * a video waits for Wi-Fi or a charger. iOS's Low Power Mode and Android's
 * Battery Saver both answer here -- expo-battery reports either as
 * `lowPowerMode`.
 *
 * `expo-battery` is in every binary since 1.3.0 (it stamps the charge on each
 * location fix), so this needs no new build. A phone that will not answer reads
 * as neither saving power nor charging, which is how the app behaved before.
 */

export interface PowerState {
  lowPower: boolean;
  charging: boolean;
  /**
   * The charge as a whole percentage; null when the phone will not say. Read
   * with the rest, and announced by iOS at most once a minute -- but by
   * Android only around its low-battery warning, so it is as fresh as the
   * last `readPowerState`, which the upload queue asks for every minute.
   */
  batteryPercent: number | null;
}

const UNKNOWN: PowerState = { lowPower: false, charging: false, batteryPercent: null };

let state: PowerState = UNKNOWN;
let readAt = 0;
let reading: Promise<PowerState> | null = null;
const listeners = new Set<() => void>();

function set(next: PowerState) {
  if (
    next.lowPower === state.lowPower &&
    next.charging === state.charging &&
    next.batteryPercent === state.batteryPercent
  )
    return;
  state = next;
  listeners.forEach((listener) => listener());
}

const isCharging = (batteryState: Battery.BatteryState) =>
  batteryState === Battery.BatteryState.CHARGING || batteryState === Battery.BatteryState.FULL;

/** The last state read, without asking the phone again. */
export function currentPowerState(): PowerState {
  return state;
}

/**
 * The state, asked of the phone at most once per `maxAgeMs`. The location task
 * calls this on every batch it is given, which on iOS is once a second while
 * moving; the answer cannot have changed between two of them.
 */
export function readPowerState(maxAgeMs = 60_000, now = Date.now()): Promise<PowerState> {
  if (now - readAt < maxAgeMs) return Promise.resolve(state);
  reading ??= (async () => {
    try {
      const { lowPowerMode, batteryState, batteryLevel } = await Battery.getPowerStateAsync();
      set({
        lowPower: Boolean(lowPowerMode),
        charging: isCharging(batteryState),
        batteryPercent: batteryPercentOf(batteryLevel),
      });
    } catch {
      // Unanswerable: keep what was known. Never the reason a caller fails.
    } finally {
      readAt = Date.now();
      reading = null;
    }
    return state;
  })();
  return reading;
}

/**
 * Follows the phone's own announcements, so turning Low Power Mode on or
 * plugging in is noticed at once rather than at the next read. Returns the
 * unsubscribe.
 */
export function followPowerState(): () => void {
  void readPowerState(0);
  const subscriptions: { remove(): void }[] = [];
  try {
    subscriptions.push(
      Battery.addLowPowerModeListener(({ lowPowerMode }) => set({ ...state, lowPower: Boolean(lowPowerMode) })),
      Battery.addBatteryStateListener(({ batteryState }) => set({ ...state, charging: isCharging(batteryState) })),
      Battery.addBatteryLevelListener(({ batteryLevel }) =>
        set({ ...state, batteryPercent: batteryPercentOf(batteryLevel) }),
      ),
    );
  } catch {
    // A platform with no battery events still has `readPowerState`.
  }
  return () => subscriptions.forEach((subscription) => subscription.remove());
}

export function subscribeToPowerState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The power state, re-rendering when it changes. */
export function usePowerState(): PowerState {
  return useSyncExternalStore(subscribeToPowerState, currentPowerState, currentPowerState);
}
