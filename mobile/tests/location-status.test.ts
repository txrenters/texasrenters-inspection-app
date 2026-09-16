/**
 * The phone telling the office how it is recording.
 *
 * Twice a technician's marker sat still through a drive and nothing said why:
 * recording off, a permission refused, an old update, fixes stuck on the
 * handset all looked identical from the console.
 */
const mockRequestJson = jest.fn();
const mockForeground = jest.fn();
const mockBackground = jest.fn();
const mockServices = jest.fn();
const mockMode = jest.fn();
const mockPlatform = { OS: 'android' };
const mockAppState = { currentState: 'active' };

jest.mock('../src/repositories/api/repositories', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
}));

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: () => mockForeground(),
  getBackgroundPermissionsAsync: () => mockBackground(),
  hasServicesEnabledAsync: () => mockServices(),
}));

jest.mock('expo-updates', () => ({ updateId: '06a0287f-24cd-4036-b229-04835f823f55' }));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.1.0' } },
}));

jest.mock('../src/location/shift-tracking', () => ({
  currentShiftMode: () => mockMode(),
}));

jest.mock('../src/location/location-sender', () => ({
  maySessionRenewNow: () => mockPlatform.OS !== 'ios' || mockAppState.currentState === 'active',
}));

// Getters: the factory runs at import, before these objects are initialised.
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatform.OS;
    },
  },
  AppState: {
    get currentState() {
      return mockAppState.currentState;
    },
  },
}));

/* eslint-disable import/first */
import { reportTracking, resetTrackingReports } from '../src/location/location-status';
import { appendLocationFixes, writeLocationQueue } from '../src/location/location-storage';
/* eslint-enable import/first */

const sentBody = (call = 0) =>
  JSON.parse((mockRequestJson.mock.calls[call]?.[1] as { body: string }).body) as Record<
    string,
    unknown
  >;

beforeEach(async () => {
  jest.clearAllMocks();
  resetTrackingReports();
  await writeLocationQueue([]);
  mockPlatform.OS = 'android';
  mockAppState.currentState = 'active';
  mockForeground.mockResolvedValue({ granted: true, status: 'granted' });
  mockBackground.mockResolvedValue({ granted: false, status: 'denied' });
  mockServices.mockResolvedValue(true);
  mockMode.mockResolvedValue('BACKGROUND');
  mockRequestJson.mockResolvedValue({ reportedAt: '2026-09-16T15:40:00.000Z' });
});

describe('reporting how the phone records', () => {
  it('says what is recording, what is allowed, and what is waiting', async () => {
    await appendLocationFixes([
      { id: 'fix-1', latitude: 29.55, longitude: -95.14, recordedAt: '2026-09-16T15:39:02.000Z' },
    ]);

    await reportTracking({ started: true, mode: 'BACKGROUND' });

    expect(mockRequestJson.mock.calls[0]?.[0]).toBe('/api/v1/technician/location-status');
    expect(sentBody()).toEqual({
      recording: 'BACKGROUND',
      stoppedBecause: null,
      foregroundPermission: 'GRANTED',
      backgroundPermission: 'DENIED',
      servicesEnabled: true,
      platform: 'android',
      appVersion: '1.1.0',
      updateId: '06a0287f-24cd-4036-b229-04835f823f55',
      appState: 'active',
      lastFixAt: '2026-09-16T15:39:02.000Z',
      queuedFixes: 1,
    });
  });

  it('names why recording is off, including the technician’s own pause', async () => {
    mockMode.mockResolvedValue(null);

    await reportTracking({ started: false, reason: 'PAUSED' });

    expect(sentBody()).toMatchObject({ recording: 'OFF', stoppedBecause: 'PAUSED' });
  });

  it('does not send the same report again within a few minutes', async () => {
    const now = Date.now();
    await reportTracking(null, now);
    await reportTracking(null, now + 60_000);

    expect(mockRequestJson).toHaveBeenCalledTimes(1);
  });

  it('sends a change straight away', async () => {
    const now = Date.now();
    await reportTracking(null, now);
    mockBackground.mockResolvedValue({ granted: true, status: 'granted' });
    await reportTracking(null, now + 60_000);

    expect(mockRequestJson).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toMatchObject({ backgroundPermission: 'GRANTED' });
  });

  it('never renews the session from an iPhone in the background', async () => {
    // The two-minute check fires there too, and a renewal a locked keychain
    // cannot save ends every session on the account.
    mockPlatform.OS = 'ios';
    mockAppState.currentState = 'background';

    await reportTracking(null);

    expect(mockRequestJson.mock.calls[0]?.[2]).toEqual({ renewSession: false });
  });

  it('never throws, whatever the server says', async () => {
    // An API that does not know the route yet answers 404.
    mockRequestJson.mockRejectedValue(new Error('TexasRenters API request failed (404).'));

    await expect(reportTracking(null)).resolves.toBeUndefined();
  });
});
