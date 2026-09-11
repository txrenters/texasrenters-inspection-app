/**
 * `startShiftTracking` must never throw.
 *
 * The caller is a switch in Settings. A throw there is not a handled failure —
 * it surfaced as the app's own error screen from tapping a toggle:
 *
 *   Uncaught (in promise) Error: One of the `NSLocation*UsageDescription` keys
 *   must be present in Info.plist to be able to use geolocation.
 */
import {
  ensureShiftTracking,
  isShiftTrackingActive,
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
const mockHasStarted = jest.fn().mockResolvedValue(false);
const mockStopUpdates = jest.fn().mockResolvedValue(undefined);
const mockIsRegistered = jest.fn().mockResolvedValue(false);
const mockWatchPosition = jest.fn();
const mockAppendFixes = jest.fn();

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: () => mockHasServices(),
  requestForegroundPermissionsAsync: () => mockRequestForeground(),
  requestBackgroundPermissionsAsync: () => mockRequestBackground(),
  startLocationUpdatesAsync: (...args: unknown[]) => mockStartUpdates(...args),
  watchPositionAsync: (...args: unknown[]) => mockWatchPosition(...args),
  stopLocationUpdatesAsync: (...args: unknown[]) => mockStopUpdates(...args),
  // The question that distinguishes a task which is *delivering* from one that
  // is merely registered. Its absence here is what the bug looked like.
  hasStartedLocationUpdatesAsync: (...args: unknown[]) => mockHasStarted(...args),
  Accuracy: { Balanced: 3 },
  ActivityType: { Other: 1 },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: (...args: unknown[]) => mockIsRegistered(...args),
}));

jest.mock('../src/location/location-storage', () => ({
  appendLocationFixes: (...args: unknown[]) => mockAppendFixes(...args),
}));


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
  mockHasStarted.mockResolvedValue(false);
  mockStopUpdates.mockResolvedValue(undefined);
  mockIsRegistered.mockResolvedValue(false);
  mockAppendFixes.mockResolvedValue(undefined);
});

describe('startShiftTracking', () => {
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

  it('does not throw when the native module is missing entirely', async () => {
    mockHasServices.mockImplementation(() => {
      throw new Error("Cannot find native module 'ExpoLocation'");
    });

    await expect(startShiftTracking()).resolves.toMatchObject({ started: false });
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

  it('reports a refused foreground permission as denial, not as a failure', async () => {
    mockRequestForeground.mockResolvedValue({ granted: false });

    await expect(startShiftTracking()).resolves.toEqual({
      started: false,
      reason: 'FOREGROUND_DENIED',
    });
    expect(mockStartUpdates).not.toHaveBeenCalled();
  });

  it('starts a foreground shift when background permission is refused', async () => {
    // This used to refuse the shift outright, which meant a technician who
    // granted "while using" got nothing at all -- and Expo Go, which cannot do
    // background location under any circumstances, could never start one.
    mockRequestBackground.mockResolvedValue({ granted: false });

    await expect(startShiftTracking()).resolves.toEqual({
      started: true,
      mode: 'FOREGROUND_ONLY',
    });
    expect(mockWatchPosition).toHaveBeenCalled();
    expect(mockStartUpdates).not.toHaveBeenCalled();
  });

  it('falls back to the foreground when the background task will not start', async () => {
    // Permission held, but the task is refused -- Expo Go, or a binary with no
    // background mode. Still a usable shift.
    mockStartUpdates.mockRejectedValue(new Error('Background location has not been configured'));

    await expect(startShiftTracking()).resolves.toEqual({
      started: true,
      mode: 'FOREGROUND_ONLY',
    });
    expect(mockWatchPosition).toHaveBeenCalled();
  });

  it('queues a fix the foreground watcher delivers', async () => {
    // The whole point of the fallback: fixes have to reach the same queue the
    // background task writes to, or a foreground shift records nothing.
    mockRequestBackground.mockResolvedValue({ granted: false });
    await startShiftTracking();

    const onFix = mockWatchPosition.mock.calls[0][1] as (l: unknown) => void;
    onFix({
      coords: { latitude: 29.8665, longitude: -95.204, accuracy: 8.4 },
      timestamp: Date.parse('2026-08-28T10:00:00.000Z'),
    });

    expect(mockAppendFixes).toHaveBeenCalledWith([
      expect.objectContaining({
        latitude: 29.8665,
        longitude: -95.204,
        accuracyMeters: 8,
        recordedAt: '2026-08-28T10:00:00.000Z',
      }),
    ]);
  });

  it('uses the background task when it is available', async () => {
    await expect(startShiftTracking()).resolves.toEqual({
      started: true,
      mode: 'BACKGROUND',
    });
    expect(mockStartUpdates).toHaveBeenCalled();
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('never rejects, whatever the platform does', async () => {
    // The guarantee the caller depends on: Settings wraps this in
    // try/finally with no catch, so a rejection reaches nobody.
    for (const boom of [
      mockHasServices,
      mockRequestForeground,
      mockRequestBackground,
      mockStartUpdates,
      mockWatchPosition,
    ]) {
      jest.clearAllMocks();
      mockHasServices.mockResolvedValue(true);
      mockRequestForeground.mockResolvedValue({ granted: true });
      mockRequestBackground.mockResolvedValue({ granted: true });
      mockStartUpdates.mockResolvedValue(undefined);
      mockWatchPosition.mockResolvedValue({ remove: jest.fn() });
  mockHasStarted.mockResolvedValue(false);
  mockStopUpdates.mockResolvedValue(undefined);
  mockIsRegistered.mockResolvedValue(false);
      boom.mockRejectedValue(new Error('native failure'));

      await expect(startShiftTracking()).resolves.toBeDefined();
    }
  });
});

/**
 * The hour-long holes in a technician's trail.
 *
 * Moses reported that tracking stopped while he was still working with the app
 * open. His trail bore it out: dense fixes with 4-100m accuracy, then nothing
 * for 30 to 60 minutes, repeatedly, recovering on its own. Not the network --
 * the gaps are in `recordedAt`, the handset's own clock, so the fixes were
 * never collected. Not the retry backoff either, which caps at ten minutes.
 *
 * An Android battery manager reclaiming the location service, or iOS
 * terminating it, leaves the task **registered**. The guard asked whether it
 * was registered, said yes, and returned early -- so nothing ever restarted
 * the updates, and the only recovery was relaunching the app.
 */
describe('a background task the OS has stopped', () => {
  it('is not treated as already running', async () => {
    mockIsRegistered.mockResolvedValue(true);
    mockHasStarted.mockResolvedValue(false);

    await startShiftTracking();

    expect(mockStartUpdates).toHaveBeenCalled();
  });

  it('is cleared out before being started again', async () => {
    // `startLocationUpdatesAsync` on a task that is still registered has
    // nothing to do, so without this the stall survives the restart.
    mockIsRegistered.mockResolvedValue(true);
    mockHasStarted.mockResolvedValue(false);

    await startShiftTracking();

    expect(mockStopUpdates).toHaveBeenCalled();
  });

  it('is not reported as active tracking', async () => {
    // Settings said "recording your location" while nothing had been sent for
    // an hour, because it asked the same wrong question.
    mockIsRegistered.mockResolvedValue(true);
    mockHasStarted.mockResolvedValue(false);

    expect(await isShiftTrackingActive()).toBe(false);
  });
});

describe('re-arming tracking', () => {
  it('restarts updates that have stopped', async () => {
    mockHasStarted.mockResolvedValue(false);

    const result = await ensureShiftTracking();

    expect(result).toEqual({ started: true, mode: 'BACKGROUND' });
    expect(mockStartUpdates).toHaveBeenCalled();
  });

  it('does nothing at all when updates are already running', async () => {
    /**
     * This runs on every foreground and every two minutes while the app is
     * open. Restarting a healthy watcher would drop the OS's accumulated fix
     * state and cost battery for nothing, so the ordinary case must be one
     * question and no action.
     */
    mockHasStarted.mockResolvedValue(true);

    const result = await ensureShiftTracking();

    expect(result).toBeNull();
    expect(mockStartUpdates).not.toHaveBeenCalled();
    expect(mockStopUpdates).not.toHaveBeenCalled();
  });

  it('never throws, whatever the OS says', async () => {
    // It is called from a timer and an AppState listener, neither of which has
    // anywhere to put an error.
    mockHasStarted.mockRejectedValue(new Error('no location services'));
    mockRequestForeground.mockRejectedValue(new Error('no Info.plist keys'));

    await expect(ensureShiftTracking()).resolves.toBeDefined();
  });
});
