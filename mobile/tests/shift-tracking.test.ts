/**
 * `startShiftTracking` must never throw.
 *
 * The caller is a switch in Settings. A throw there is not a handled failure —
 * it surfaced as the app's own error screen from tapping a toggle:
 *
 *   Uncaught (in promise) Error: One of the `NSLocation*UsageDescription` keys
 *   must be present in Info.plist to be able to use geolocation.
 */
import { startShiftTracking, stopShiftTracking } from '../src/location/shift-tracking';

const mockHasServices = jest.fn();
const mockRequestForeground = jest.fn();
const mockRequestBackground = jest.fn();
const mockStartUpdates = jest.fn();
const mockWatchPosition = jest.fn();
const mockAppendFixes = jest.fn();

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: () => mockHasServices(),
  requestForegroundPermissionsAsync: () => mockRequestForeground(),
  requestBackgroundPermissionsAsync: () => mockRequestBackground(),
  startLocationUpdatesAsync: (...args: unknown[]) => mockStartUpdates(...args),
  watchPositionAsync: (...args: unknown[]) => mockWatchPosition(...args),
  stopLocationUpdatesAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
  ActivityType: { Other: 1 },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
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
      boom.mockRejectedValue(new Error('native failure'));

      await expect(startShiftTracking()).resolves.toBeDefined();
    }
  });
});
