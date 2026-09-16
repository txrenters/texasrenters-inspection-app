/**
 * Recording where a technician is, the whole time they are signed in.
 *
 * Three field reports shaped this file:
 *
 * - `startShiftTracking` threw from a Settings switch and took the app to its
 *   error screen, so it must never throw.
 * - The office map showed technicians only while the app was open at a
 *   property. Recording in the background had been made to depend on "Allow
 *   all the time", which almost no phone had, so every drive fell back to a
 *   watcher that stops when the app leaves the screen.
 * - A recording the OS killed stayed "started" -- neither platform can tell a
 *   registered task from a delivering one -- so nothing restarted it.
 */
import * as TaskManager from 'expo-task-manager';

import {
  BACKGROUND_UPDATES,
  ensureShiftTracking,
  isShiftTrackingActive,
  STALLED_AFTER_MS,
  startShiftTracking,
  stopShiftTracking,
} from '../src/location/shift-tracking';

const mockHasServices = jest.fn();
const mockRequestForeground = jest.fn();
const mockRequestBackground = jest.fn();
const mockStartUpdates = jest.fn();
// Defaults at declaration, not only in `beforeEach`: that hook calls
// `stopShiftTracking()` on its first line, before any of the assignments
// below have run, so a mock with no implementation returns undefined and the
// `.catch` on it throws before a single test starts.
const mockStopUpdates = jest.fn().mockResolvedValue(undefined);
const mockIsRegistered = jest.fn().mockResolvedValue(false);
const mockTaskOptions = jest.fn().mockResolvedValue(null);
const mockWatchPosition = jest.fn();
const mockAppendFixes = jest.fn();
const mockReadLastFixAt = jest.fn().mockResolvedValue(null);
const mockSendRecorded = jest.fn();
const mockAppState = { currentState: 'active' };

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: () => mockHasServices(),
  requestForegroundPermissionsAsync: () => mockRequestForeground(),
  requestBackgroundPermissionsAsync: () => mockRequestBackground(),
  startLocationUpdatesAsync: (...args: unknown[]) => mockStartUpdates(...args),
  watchPositionAsync: (...args: unknown[]) => mockWatchPosition(...args),
  stopLocationUpdatesAsync: (...args: unknown[]) => mockStopUpdates(...args),
  Accuracy: { Balanced: 3, High: 4 },
  ActivityType: { Other: 1 },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: (...args: unknown[]) => mockIsRegistered(...args),
  getTaskOptionsAsync: (...args: unknown[]) => mockTaskOptions(...args),
}));

// A getter, not the object itself: the factory runs when the module under test
// is imported, before `mockAppState` has been initialised.
jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mockAppState.currentState;
    },
  },
}));

jest.mock('../src/location/location-storage', () => ({
  appendLocationFixes: (...args: unknown[]) => mockAppendFixes(...args),
  readLastFixAt: () => mockReadLastFixAt(),
}));

jest.mock('../src/location/location-sender', () => ({
  sendRecordedFixes: (...args: unknown[]) => mockSendRecorded(...args),
}));

/**
 * The task the module defines at load, captured before any `clearAllMocks`
 * forgets the call that registered it.
 */
const recordLocationsTask = (TaskManager.defineTask as unknown as jest.Mock).mock.calls[0][1] as (
  body: { data?: unknown; error?: unknown },
) => Promise<void>;

const TASK = 'texasrenters-shift-location';

/** The options an earlier build registered the task with. */
const earlierBuild = {
  accuracy: 3,
  timeInterval: 15_000,
  distanceInterval: 10,
  foregroundService: {
    notificationTitle: 'Recording your location',
    notificationBody: 'TexasRenters Inspect is on. Close the app to stop.',
    killServiceOnDestroy: true,
  },
};

beforeEach(async () => {
  // The foreground watcher is module state, which `clearAllMocks` does not
  // touch -- without this, the first test to start one leaves it set and every
  // later test skips watching because it thinks a shift is already running.
  await stopShiftTracking();
  jest.clearAllMocks();
  mockHasServices.mockResolvedValue(true);
  mockRequestForeground.mockResolvedValue({ granted: true });
  mockRequestBackground.mockResolvedValue({ granted: true });
  mockStartUpdates.mockResolvedValue(undefined);
  mockWatchPosition.mockResolvedValue({ remove: jest.fn() });
  mockStopUpdates.mockResolvedValue(undefined);
  mockIsRegistered.mockResolvedValue(false);
  mockTaskOptions.mockResolvedValue(null);
  mockAppendFixes.mockResolvedValue(undefined);
  mockReadLastFixAt.mockResolvedValue(null);
  mockSendRecorded.mockResolvedValue(undefined);
  mockAppState.currentState = 'active';
});

describe('starting a shift', () => {
  it('reports UNSUPPORTED instead of throwing when the binary has no location keys', async () => {
    // The reported crash. A build made before expo-location was added has no
    // `NSLocation*UsageDescription`, and the permission request throws rather
    // than reporting denial.
    mockRequestForeground.mockRejectedValue(
      new Error(
        'One of the `NSLocation*UsageDescription` keys must be present in Info.plist to be able to use geolocation.',
      ),
    );

    await expect(startShiftTracking()).resolves.toEqual({
      started: false,
      reason: 'UNSUPPORTED',
    });
  });

  it('still reports switched-off services separately from an unsupported build', async () => {
    // These are fixed in different places, so collapsing them would send
    // somebody to the wrong settings screen.
    mockHasServices.mockResolvedValue(false);

    await expect(startShiftTracking()).resolves.toEqual({
      started: false,
      reason: 'UNAVAILABLE',
    });
  });

  it('reports a refused location permission as denial, and records nothing', async () => {
    mockRequestForeground.mockResolvedValue({ granted: false });

    await expect(startShiftTracking()).resolves.toEqual({
      started: false,
      reason: 'FOREGROUND_DENIED',
    });
    expect(mockStartUpdates).not.toHaveBeenCalled();
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('records in the background with location allowed only while using the app', async () => {
    // The bug. "All the time" was required, almost no phone had it, and every
    // drive fell back to a watcher that stops when the app leaves the screen.
    mockRequestBackground.mockResolvedValue({ granted: false });

    await expect(startShiftTracking()).resolves.toEqual({ started: true, mode: 'BACKGROUND' });
    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, BACKGROUND_UPDATES);
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('still asks for "all the time", which lets the phone restart a recording it closed', async () => {
    await startShiftTracking();

    expect(mockRequestBackground).toHaveBeenCalled();
  });

  it('does not let a failing "all the time" request stop the shift', async () => {
    mockRequestBackground.mockRejectedValue(new Error('activity result lost'));

    await expect(startShiftTracking()).resolves.toEqual({ started: true, mode: 'BACKGROUND' });
  });

  it('watches in the foreground only when the task cannot start at all', async () => {
    // Expo Go, or a binary with no background mode.
    mockStartUpdates.mockRejectedValue(new Error('Background location has not been configured'));

    await expect(startShiftTracking()).resolves.toEqual({
      started: true,
      mode: 'FOREGROUND_ONLY',
    });
    expect(mockWatchPosition).toHaveBeenCalled();
  });

  it('records from satellites, which is what carries speed and heading', async () => {
    await startShiftTracking();

    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, expect.objectContaining({ accuracy: 4 }));
  });

  it('keeps recording when the app is swiped away, with its notification up', async () => {
    // Technicians clear their recent apps between visits; every swipe used to
    // end the recording mid-day.
    await startShiftTracking();

    expect(mockStartUpdates).toHaveBeenCalledWith(
      TASK,
      expect.objectContaining({
        foregroundService: expect.objectContaining({ killServiceOnDestroy: false }),
      }),
    );
  });

  it('never rejects, whatever the platform does', async () => {
    // Settings wraps this in try/finally with no catch, so a rejection reaches
    // nobody.
    for (const boom of [
      mockHasServices,
      mockRequestForeground,
      mockRequestBackground,
      mockStartUpdates,
      mockWatchPosition,
      mockIsRegistered,
    ]) {
      jest.clearAllMocks();
      mockHasServices.mockResolvedValue(true);
      mockRequestForeground.mockResolvedValue({ granted: true });
      mockRequestBackground.mockResolvedValue({ granted: true });
      mockStartUpdates.mockResolvedValue(undefined);
      mockWatchPosition.mockResolvedValue({ remove: jest.fn() });
      mockStopUpdates.mockResolvedValue(undefined);
      mockIsRegistered.mockResolvedValue(false);
      boom.mockRejectedValue(new Error('native failure'));

      await expect(startShiftTracking()).resolves.toBeDefined();
    }
  });
});

describe('a fix, as it is recorded', () => {
  const fix = {
    coords: { latitude: 29.5516, longitude: -95.1449, accuracy: 6, heading: 42, speed: 16.4 },
    timestamp: Date.parse('2026-09-16T15:52:00.000Z'),
  };

  it('is queued and then sent from the location task itself', async () => {
    const order: string[] = [];
    mockAppendFixes.mockImplementation(async () => {
      order.push('queued');
    });
    mockSendRecorded.mockImplementation(async () => {
      order.push('sent');
    });

    await recordLocationsTask({ data: { locations: [fix] } });

    expect(mockAppendFixes).toHaveBeenCalledWith([
      expect.objectContaining({ headingDegrees: 42, speedMetersPerSecond: 16.4 }),
    ]);
    // Queued first, so a send that fails -- or never finishes -- loses nothing.
    expect(order).toEqual(['queued', 'sent']);
  });

  it('is nothing to send when the OS delivered nothing', async () => {
    await recordLocationsTask({ data: { locations: [] } });
    await recordLocationsTask({ error: new Error('location unavailable') });

    expect(mockAppendFixes).not.toHaveBeenCalled();
    expect(mockSendRecorded).not.toHaveBeenCalled();
  });

  it('reaches the same queue from the foreground watcher, and is sent', async () => {
    mockStartUpdates.mockRejectedValue(new Error('no background mode'));
    await startShiftTracking();

    const onFix = mockWatchPosition.mock.calls[0][1] as (location: unknown) => void;
    onFix(fix);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockAppendFixes).toHaveBeenCalledWith([
      expect.objectContaining({ latitude: 29.5516, longitude: -95.1449, accuracyMeters: 6 }),
    ]);
    expect(mockSendRecorded).toHaveBeenCalled();
  });
});

/**
 * A recording the OS stopped, which neither platform will admit to.
 *
 * `hasStartedLocationUpdatesAsync` asks whether the task has a location
 * consumer -- true for a task killed an hour ago. The last recorded fix is the
 * evidence that can be trusted.
 */
describe('a registered recording', () => {
  beforeEach(() => {
    mockIsRegistered.mockResolvedValue(true);
    mockTaskOptions.mockResolvedValue(BACKGROUND_UPDATES);
  });

  it('is restarted when nothing has been recorded for a while', async () => {
    mockReadLastFixAt.mockResolvedValue(Date.now() - STALLED_AFTER_MS - 1_000);

    await expect(ensureShiftTracking()).resolves.toBeNull();

    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, BACKGROUND_UPDATES);
    // In place: the Android service and its notification stay as they are.
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('is left alone while it is delivering', async () => {
    mockReadLastFixAt.mockResolvedValue(Date.now() - 20_000);

    await ensureShiftTracking();

    expect(mockStartUpdates).not.toHaveBeenCalled();
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('is given this build’s options, updated in place when only the updates changed', async () => {
    mockReadLastFixAt.mockResolvedValue(Date.now() - 20_000);
    mockTaskOptions.mockResolvedValue({ ...BACKGROUND_UPDATES, accuracy: 3 });

    await expect(startShiftTracking()).resolves.toEqual({ started: true, mode: 'BACKGROUND' });

    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, BACKGROUND_UPDATES);
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('is stopped and started again when the service itself changed', async () => {
    // Whether the service survives a swipe is read by Android when the service
    // starts, so only a new service picks it up.
    mockReadLastFixAt.mockResolvedValue(Date.now() - 20_000);
    mockTaskOptions.mockResolvedValue(earlierBuild);

    await startShiftTracking();

    expect(mockStopUpdates).toHaveBeenCalledWith(TASK);
    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, BACKGROUND_UPDATES);
    expect(mockStopUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartUpdates.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('is not stopped over options it could not read, only restarted if quiet', async () => {
    mockTaskOptions.mockResolvedValue(null);
    mockReadLastFixAt.mockResolvedValue(Date.now() - 20_000);

    await ensureShiftTracking();
    expect(mockStartUpdates).not.toHaveBeenCalled();

    mockReadLastFixAt.mockResolvedValue(Date.now() - STALLED_AFTER_MS - 1_000);
    await ensureShiftTracking();
    expect(mockStartUpdates).toHaveBeenCalledWith(TASK, BACKGROUND_UPDATES);
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('is not touched from the background, where Android refuses to start a service', async () => {
    mockAppState.currentState = 'background';
    mockTaskOptions.mockResolvedValue(earlierBuild);

    await ensureShiftTracking();

    expect(mockStartUpdates).not.toHaveBeenCalled();
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('keeps recording in the background when a restart is refused', async () => {
    // Falling back to the foreground watcher here would stop the drive being
    // recorded at all -- the opposite of the point.
    mockTaskOptions.mockResolvedValue(earlierBuild);
    mockStartUpdates.mockRejectedValue(new Error('ForegroundServiceStartNotAllowedException'));

    await expect(startShiftTracking()).resolves.toEqual({ started: true, mode: 'BACKGROUND' });
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('counts as a running shift', async () => {
    expect(await isShiftTrackingActive()).toBe(true);
  });
});

describe('a shift that is not running', () => {
  it('is started by the foreground check', async () => {
    await expect(ensureShiftTracking()).resolves.toEqual({ started: true, mode: 'BACKGROUND' });
    expect(mockStartUpdates).toHaveBeenCalled();
  });

  it('is not reported as running', async () => {
    expect(await isShiftTrackingActive()).toBe(false);
  });

  it('never throws from the check, whatever the OS says', async () => {
    // It is called from a timer and an AppState listener, neither of which has
    // anywhere to put an error.
    mockIsRegistered.mockRejectedValue(new Error('no location services'));
    mockRequestForeground.mockRejectedValue(new Error('no Info.plist keys'));

    await expect(ensureShiftTracking()).resolves.toBeDefined();
  });
});

/**
 * Only one recorder at a time.
 *
 * Production held two genuinely different fixes -- three to twenty-two metres
 * apart -- stamped with the same millisecond and uploaded in one batch, which
 * drew two markers for one technician.
 */
describe('the two recorders', () => {
  it('stops a registered task before watching in the foreground', async () => {
    // The task refuses to start, and one from an earlier session is registered.
    mockIsRegistered.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockStartUpdates.mockRejectedValue(new Error('no background mode'));

    await expect(startShiftTracking()).resolves.toEqual({
      started: true,
      mode: 'FOREGROUND_ONLY',
    });

    expect(mockStopUpdates).toHaveBeenCalledWith(TASK);
    expect(mockWatchPosition).toHaveBeenCalled();
  });

  it('drops a foreground watch before starting the background task', async () => {
    const remove = jest.fn();
    mockWatchPosition.mockResolvedValue({ remove });
    mockStartUpdates.mockRejectedValueOnce(new Error('no background mode'));
    await startShiftTracking();

    await startShiftTracking();

    expect(remove).toHaveBeenCalled();
  });

  it('leaves nothing running after a stop', async () => {
    mockIsRegistered.mockResolvedValue(true);
    await stopShiftTracking();

    expect(mockStopUpdates).toHaveBeenCalled();
  });
});
