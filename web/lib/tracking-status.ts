import type { ReportedTrackingStatus } from '@texasrenters/shared';

/**
 * What the office should know about how a technician's phone is recording.
 *
 * Only the things somebody would act on, in the words they would use to ask
 * the technician to fix it. A phone recording properly says nothing: the panel
 * is for the drive, and a line of reassurance under every healthy technician
 * would teach people to stop reading the line.
 */

export interface TrackingProblem {
  /** `warning` stops the map showing where they are; `advice` weakens it. */
  tone: 'warning' | 'advice';
  message: string;
}

/**
 * Past this many unsent positions the phone is recording and not getting them
 * out -- no signal, or a sign-in that needs the app opened -- which is worth
 * saying, because the map will jump when they arrive.
 */
const MANY_WAITING = 20;

export function trackingProblem(
  tracking: ReportedTrackingStatus | null | undefined,
): TrackingProblem | null {
  if (!tracking) return null;

  if (tracking.recording === 'OFF') {
    switch (tracking.stoppedBecause) {
      case 'PAUSED':
        return { tone: 'warning', message: 'Location sharing is paused in the app on their phone.' };
      case 'FOREGROUND_DENIED':
        return { tone: 'warning', message: 'Their phone does not allow the app to use location.' };
      case 'UNAVAILABLE':
        return { tone: 'warning', message: 'Location services are turned off on their phone.' };
      case 'UNSUPPORTED':
        return { tone: 'warning', message: 'Their version of the app cannot record location.' };
      default:
        return { tone: 'warning', message: 'Their phone is not recording location.' };
    }
  }

  if (tracking.servicesEnabled === false)
    return { tone: 'warning', message: 'Location services are turned off on their phone.' };
  if (tracking.foregroundPermission === 'DENIED')
    return { tone: 'warning', message: 'Their phone does not allow the app to use location.' };
  if (tracking.recording === 'FOREGROUND_ONLY')
    return {
      tone: 'warning',
      message: 'Their phone records only while the app is on screen, so drives are not recorded.',
    };
  if (tracking.queuedFixes >= MANY_WAITING)
    return {
      tone: 'advice',
      message: `${tracking.queuedFixes} positions are waiting on their phone to be sent.`,
    };
  if (tracking.backgroundPermission !== 'GRANTED')
    return {
      tone: 'advice',
      message:
        'Location is allowed only while using the app. Ask them to allow it all the time, so recording carries on if the phone closes the app.',
    };
  return null;
}

const PLATFORM: Record<ReportedTrackingStatus['platform'], string> = {
  ios: 'iPhone',
  android: 'Android',
  other: 'Phone',
};

/** The phone, in one line, for whoever is diagnosing it: platform, app, update. */
export function trackingSummary(tracking: ReportedTrackingStatus | null | undefined) {
  if (!tracking) return null;
  return [
    PLATFORM[tracking.platform],
    tracking.appVersion ? `app ${tracking.appVersion}` : null,
    tracking.updateId ? `update ${tracking.updateId.slice(0, 8)}` : 'embedded build',
    tracking.recording === 'BACKGROUND' ? 'records in background' : null,
    tracking.backgroundPermission === 'GRANTED' ? 'location all the time' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
