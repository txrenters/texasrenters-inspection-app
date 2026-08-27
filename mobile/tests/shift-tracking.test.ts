/**
 * `startShiftTracking` must never throw.
 *
 * The caller is a switch in Settings. A throw there is not a handled failure —
 * it surfaced as the app's own error screen from tapping a toggle:
 *
 *   Uncaught (in promise) Error: One of the `NSLocation*UsageDescription` keys
 *   must be present in Info.plist to be able to use geolocation.
 */
import { startShiftTracking } from '../src/location/shift-tracking';

const mockHasServices = jest.fn();
const mockRequestForeground = jest.fn();
const mockRequestBackground = jest.fn();
const mockStartUpdates = jest.fn();

jest.mock('expo-location', () => ({
  hasServicesEnabledAsync: () => mockHasServices(),
  requestForegroundPermissionsAsync: () => mockRequestForeground(),
  requestBackgroundPermissionsAsync: () => mockRequestBackground(),
  startLocationUpdatesAsync: (...args: unknown[]) => mockStartUpdates(...args),
  stopLocationUpdatesAsync: jest.fn(),
  Accuracy: { Balanced: 3 },
  ActivityType: { Other: 1 },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));

jest.mock('../src/location/location-storage', () => ({
  appendLocationFixes: jest.fn(),
}));


beforeEach(() => {
  jest.clearAllMocks();
  mockHasServices.mockResolvedValue(true);
  mockRequestForeground.mockResolvedValue({ granted: true });
  mockRequestBackground.mockResolvedValue({ granted: true });
  mockStartUpdates.mockResolvedValue(undefined);
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

  it('reports a refused background permission separately', async () => {
    mockRequestBackground.mockResolvedValue({ granted: false });

    await expect(startShiftTracking()).resolves.toEqual({
      started: false,
      reason: 'BACKGROUND_DENIED',
    });
    expect(mockStartUpdates).not.toHaveBeenCalled();
  });

  it('starts tracking when everything is granted', async () => {
    await expect(startShiftTracking()).resolves.toEqual({ started: true });
    expect(mockStartUpdates).toHaveBeenCalled();
  });

  it('never rejects, whatever the platform does', async () => {
    // The guarantee the caller depends on: Settings wraps this in
    // try/finally with no catch, so a rejection reaches nobody.
    for (const boom of [mockHasServices, mockRequestForeground, mockRequestBackground, mockStartUpdates]) {
      jest.clearAllMocks();
      mockHasServices.mockResolvedValue(true);
      mockRequestForeground.mockResolvedValue({ granted: true });
      mockRequestBackground.mockResolvedValue({ granted: true });
      mockStartUpdates.mockResolvedValue(undefined);
      boom.mockRejectedValue(new Error('native failure'));

      await expect(startShiftTracking()).resolves.toBeDefined();
    }
  });
});
