import type { ReportedTrackingStatus } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { trackingProblem, trackingSummary } from './tracking-status';

/**
 * Why a technician's marker is not moving, when their phone can say.
 *
 * Before this, a marker that sat still through a drive came with no reason at
 * all, and the office could not tell a paused recording from a refused
 * permission from a phone on an old update.
 */

const healthy: ReportedTrackingStatus = {
  recording: 'BACKGROUND',
  stoppedBecause: null,
  foregroundPermission: 'GRANTED',
  backgroundPermission: 'GRANTED',
  servicesEnabled: true,
  platform: 'ios',
  appVersion: '1.1.0',
  updateId: '06a0287f-24cd-4036-b229-04835f823f55',
  appState: 'background',
  lastFixAt: '2026-09-16T15:39:02.000Z',
  queuedFixes: 0,
  reportedAt: '2026-09-16T15:40:00.000Z',
};

describe('what is worth telling the office', () => {
  it('says nothing about a phone recording properly', () => {
    expect(trackingProblem(healthy)).toBeNull();
    expect(trackingProblem(null)).toBeNull();
  });

  it.each([
    ['PAUSED', /paused in the app/],
    ['FOREGROUND_DENIED', /does not allow the app to use location/],
    ['UNAVAILABLE', /services are turned off/],
    ['UNSUPPORTED', /cannot record location/],
  ] as const)('names why recording is off: %s', (reason, message) => {
    const problem = trackingProblem({ ...healthy, recording: 'OFF', stoppedBecause: reason });
    expect(problem?.tone).toBe('warning');
    expect(problem?.message).toMatch(message);
  });

  it('warns that drives are lost when the phone records only on screen', () => {
    expect(trackingProblem({ ...healthy, recording: 'FOREGROUND_ONLY' })).toMatchObject({
      tone: 'warning',
      message: expect.stringMatching(/drives are not recorded/),
    });
  });

  it('advises "all the time" when only "while using" is allowed', () => {
    expect(
      trackingProblem({ ...healthy, backgroundPermission: 'DENIED' }),
    ).toMatchObject({ tone: 'advice', message: expect.stringMatching(/all the time/) });
  });

  it('says so when positions are piling up on the phone', () => {
    expect(trackingProblem({ ...healthy, queuedFixes: 57 })?.message).toMatch(/57 positions/);
  });
});

describe('the phone in one line', () => {
  it('names the platform, app and update', () => {
    expect(trackingSummary(healthy)).toBe(
      'iPhone · app 1.1.0 · update 06a0287f · records in background · location all the time',
    );
  });

  it('says when the app is running the build it shipped with', () => {
    expect(trackingSummary({ ...healthy, platform: 'android', updateId: null })).toMatch(
      /^Android · app 1.1.0 · embedded build/,
    );
  });
});
