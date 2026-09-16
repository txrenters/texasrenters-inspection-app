import type { TechnicianTrackingStatus } from '@texasrenters/shared';
import Constants from 'expo-constants';
import * as Location from 'expo-location';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';

import { requestJson } from '../repositories/api/repositories';
import { maySessionRenewNow } from './location-sender';
import { readLastFixAt, readLocationQueue } from './location-storage';
import { currentShiftMode, type ShiftStartResult } from './shift-tracking';

/**
 * Telling the office how this phone is recording, so nobody has to guess.
 *
 * Twice now a technician's marker sat still through a drive and the only
 * evidence was the marker itself: was the recording off, the permission
 * refused, the app on an old update, or the fixes stuck on the handset? None
 * of it ever left the device. This sends it, and the console shows it beside
 * the technician.
 *
 * Best effort in every way. A server that does not know the route yet answers
 * 404, a phone with no signal answers nothing; neither is worth a retry, since
 * the next report is minutes away.
 */

export type ShiftOutcome = ShiftStartResult | { started: false; reason: 'PAUSED' };

/** No more often than this, unless something in the report changed. */
const REPORT_EVERY_MS = 5 * 60_000;

let lastReport: { key: string; at: number } | null = null;

function permissionOf(
  response: { granted: boolean; status: string } | null,
): TechnicianTrackingStatus['foregroundPermission'] {
  if (!response) return 'UNKNOWN';
  if (response.granted) return 'GRANTED';
  return response.status === 'undetermined' ? 'UNDETERMINED' : 'DENIED';
}

export async function describeTracking(outcome: ShiftOutcome | null): Promise<TechnicianTrackingStatus> {
  const [foreground, background, servicesEnabled, mode, lastFixAt, queue] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => null),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    Location.hasServicesEnabledAsync().catch(() => null),
    currentShiftMode().catch(() => null),
    readLastFixAt(),
    readLocationQueue(),
  ]);

  return {
    recording: mode ?? 'OFF',
    stoppedBecause: outcome && !outcome.started ? outcome.reason : null,
    foregroundPermission: permissionOf(foreground),
    backgroundPermission: permissionOf(background),
    servicesEnabled,
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other',
    appVersion: Constants.expoConfig?.version ?? null,
    updateId: Updates.updateId ?? null,
    appState: AppState.currentState ?? null,
    lastFixAt: lastFixAt === null ? null : new Date(lastFixAt).toISOString(),
    queuedFixes: queue.length,
  };
}

/** Sends the report. Never throws. */
export async function reportTracking(outcome: ShiftOutcome | null, now = Date.now()) {
  try {
    const status = await describeTracking(outcome);
    // What would change the office's reading of it -- not the clock fields,
    // which change every time.
    const key = JSON.stringify({ ...status, lastFixAt: null, queuedFixes: null, appState: null });
    if (lastReport && lastReport.key === key && now - lastReport.at < REPORT_EVERY_MS) return;
    await requestJson(
      '/api/v1/technician/location-status',
      { method: 'PUT', body: JSON.stringify(status) },
      // The two-minute check also fires with the app in the background on an
      // iPhone, where a renewal could not be saved.
      { renewSession: maySessionRenewNow() },
    );
    lastReport = { key, at: now };
  } catch {
    // See the module note: the next report is minutes away.
  }
}

/** Test seam. */
export function resetTrackingReports() {
  lastReport = null;
}
