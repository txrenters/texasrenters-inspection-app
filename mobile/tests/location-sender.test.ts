/**
 * Sending recorded fixes, now from the location task as well as the timer.
 *
 * The timer alone could not keep the office map live: Android stops JavaScript
 * timers when the app leaves the screen, so a whole drive stayed on the handset
 * and arrived in one batch at the next property. Sending from the task fixes
 * that, and brings three things with it that these pin down -- one send at a
 * time, no request per fix, and never renewing a session that cannot be saved.
 */
const mockRequestJson = jest.fn();
const mockGetSession = jest.fn();
const mockPlatform = { OS: 'android' };
const mockAppState = { currentState: 'background' };

jest.mock('../src/repositories/api/repositories', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
}));

jest.mock('../src/auth/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
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
import {
  drainLocationQueue,
  resetLocationSender,
  sendRecordedFixes,
} from '../src/location/location-sender';
import type { QueuedFix } from '../src/location/location-queue';
import {
  appendLocationFixes,
  readLocationQueue,
  writeLocationQueue,
} from '../src/location/location-storage';
/* eslint-enable import/first */

const fix = (id: string, secondsAgo = 30): QueuedFix => ({
  id,
  latitude: 29.5516,
  longitude: -95.1449,
  recordedAt: new Date(Date.now() - secondsAgo * 1_000).toISOString(),
  accuracyMeters: 6,
  headingDegrees: 42,
  speedMetersPerSecond: 16.4,
});

const session = { accessToken: 'token', refreshToken: 'refresh', expiresAt: 0 };

/** A request the test finishes when it chooses to. */
function heldRequest() {
  let finish: () => void = () => undefined;
  mockRequestJson.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ accepted: 1, rejected: 0 });
      }),
  );
  return () => finish();
}

beforeEach(async () => {
  jest.clearAllMocks();
  resetLocationSender();
  await writeLocationQueue([]);
  mockPlatform.OS = 'android';
  mockAppState.currentState = 'background';
  mockGetSession.mockResolvedValue(session);
  mockRequestJson.mockResolvedValue({ accepted: 1, rejected: 0 });
});

describe('sending the queue', () => {
  it('posts what is queued and removes it once the API has it', async () => {
    await appendLocationFixes([fix('a', 60), fix('b', 45)]);

    await expect(drainLocationQueue()).resolves.toEqual({ sent: 2, remaining: 0 });

    const [path, request] = mockRequestJson.mock.calls[0];
    expect(path).toBe('/api/v1/technician/locations');
    const body = JSON.parse((request as { body: string }).body);
    expect(body.fixes.map((each: { deviceFixId: string }) => each.deviceFixId)).toEqual(['a', 'b']);
    expect(body.fixes[0]).toMatchObject({ headingDegrees: 42, speedMetersPerSecond: 16.4 });
    expect(await readLocationQueue()).toEqual([]);
  });

  it('keeps a batch the API did not take, backed off', async () => {
    await appendLocationFixes([fix('a')]);
    mockRequestJson.mockRejectedValueOnce(new Error('no signal'));

    await expect(drainLocationQueue()).resolves.toEqual({ sent: 0, remaining: 1 });

    const [kept] = await readLocationQueue();
    expect(kept?.attempts).toBe(1);
    expect(kept?.nextAttemptAt).toBeDefined();
  });

  it('runs one send at a time', async () => {
    // Two overlapping sends post the same fixes twice.
    await appendLocationFixes([fix('a')]);
    const finish = heldRequest();

    const first = drainLocationQueue();
    const second = drainLocationQueue();
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await Promise.all([first, second]);

    expect(mockRequestJson).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting on a send that has hung for a minute', async () => {
    // Android runs no timers in the background, so the request's own abort
    // never fires there. Without this, one hung request in a dead zone held
    // every later fix on the handset.
    await appendLocationFixes([fix('a')]);
    heldRequest();
    const startedAt = Date.now();
    void drainLocationQueue(startedAt);
    await new Promise((resolve) => setImmediate(resolve));

    await drainLocationQueue(startedAt + 61_000);

    expect(mockRequestJson).toHaveBeenCalledTimes(2);
  });

  it('does not lose a fix recorded while a send is out', async () => {
    // The sender reads the queue, the task appends, the sender writes back what
    // it read minus what it sent -- without the new fix. Changes are applied
    // one after another so that cannot happen.
    await appendLocationFixes([fix('sent')]);
    const finish = heldRequest();

    const sending = drainLocationQueue();
    await new Promise((resolve) => setImmediate(resolve));
    const recording = appendLocationFixes([fix('recorded-meanwhile', 1)]);
    finish();
    await Promise.all([sending, recording]);

    expect((await readLocationQueue()).map((each) => each.id)).toEqual(['recorded-meanwhile']);
  });
});

describe('sending as each fix is recorded', () => {
  it('sends straight away', async () => {
    await appendLocationFixes([fix('a')]);

    await sendRecordedFixes();

    expect(mockRequestJson).toHaveBeenCalledTimes(1);
  });

  it('sends at most once every ten seconds', async () => {
    // iOS reports every ten metres, several times a second in a car.
    const now = Date.now();
    await appendLocationFixes([fix('a')]);
    await sendRecordedFixes(now);

    await appendLocationFixes([fix('b', 1)]);
    await sendRecordedFixes(now + 2_000);
    await sendRecordedFixes(now + 9_000);
    expect(mockRequestJson).toHaveBeenCalledTimes(1);

    await sendRecordedFixes(now + 10_000);
    expect(mockRequestJson).toHaveBeenCalledTimes(2);
  });

  it('never throws into the location task', async () => {
    await appendLocationFixes([fix('a')]);
    mockGetSession.mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(sendRecordedFixes()).resolves.toBeUndefined();
  });
});

/**
 * Renewing rotates the refresh token, and offering the retired one again ends
 * every session on the account. A renewal that cannot be saved is a sign-out
 * waiting to happen -- and an iPhone's keychain cannot be written while the
 * phone is locked, which is exactly when the location task now sends.
 */
describe('the session, from a pocket', () => {
  it('is not renewed on an iPhone that is not on screen', async () => {
    mockPlatform.OS = 'ios';
    mockAppState.currentState = 'background';
    await appendLocationFixes([fix('a')]);

    await drainLocationQueue();

    expect(mockGetSession).toHaveBeenCalledWith({ renew: false });
    expect(mockRequestJson).toHaveBeenCalledWith(
      '/api/v1/technician/locations',
      expect.any(Object),
      { renewSession: false },
    );
  });

  it('may be renewed on an iPhone with the app open', async () => {
    mockPlatform.OS = 'ios';
    mockAppState.currentState = 'active';
    await appendLocationFixes([fix('a')]);

    await drainLocationQueue();

    expect(mockGetSession).toHaveBeenCalledWith({ renew: true });
  });

  it('may be renewed on Android, whose keystore works while locked', async () => {
    await appendLocationFixes([fix('a')]);

    await drainLocationQueue();

    expect(mockGetSession).toHaveBeenCalledWith({ renew: true });
  });

  it('leaves the fixes for the app when there is no usable session, without backing them off', async () => {
    // A backed-off fix waits out its delay even after the app opens and could
    // send it at once.
    mockGetSession.mockResolvedValue(null);
    await appendLocationFixes([fix('a')]);

    await expect(drainLocationQueue()).resolves.toEqual({ sent: 0, remaining: 1 });

    expect(mockRequestJson).not.toHaveBeenCalled();
    const [kept] = await readLocationQueue();
    expect(kept?.nextAttemptAt).toBeUndefined();
  });
});
