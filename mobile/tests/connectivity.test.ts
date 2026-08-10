import type { NetInfoState } from '@react-native-community/netinfo';

import {
  evaluateUploadGate,
  readConnectivity,
  UNKNOWN_CONNECTIVITY,
  type Connectivity,
} from '../src/lib/connectivity';

function connectivity(overrides: Partial<Connectivity> = {}): Connectivity {
  return { isOnline: true, isMetered: false, type: 'wifi', ...overrides };
}

function netInfo(overrides: Record<string, unknown> = {}) {
  return {
    type: 'wifi',
    isConnected: true,
    isInternetReachable: true,
    details: { isConnectionExpensive: false },
    ...overrides,
  } as unknown as NetInfoState;
}

describe('readConnectivity', () => {
  it('treats a connected, reachable link as online', () => {
    expect(readConnectivity(netInfo()).isOnline).toBe(true);
  });

  it('is offline when disconnected, or when the internet is explicitly unreachable', () => {
    expect(readConnectivity(netInfo({ isConnected: false })).isOnline).toBe(false);
    expect(readConnectivity(netInfo({ isInternetReachable: false })).isOnline).toBe(false);
  });

  it('stays online while reachability is still being probed', () => {
    // NetInfo reports null until the probe completes. Treating that as offline
    // would stall the queue for seconds on every launch.
    expect(readConnectivity(netInfo({ isInternetReachable: null })).isOnline).toBe(true);
  });

  it('counts cellular as metered', () => {
    expect(readConnectivity(netInfo({ type: 'cellular' })).isMetered).toBe(true);
  });

  it('counts an expensive Wi-Fi link as metered', () => {
    // A phone hotspot reports type "wifi" but the technician still pays per byte.
    expect(
      readConnectivity(netInfo({ details: { isConnectionExpensive: true } })).isMetered,
    ).toBe(true);
  });

  it('does not crash when details are absent', () => {
    expect(() => readConnectivity(netInfo({ details: null }))).not.toThrow();
  });
});

describe('evaluateUploadGate', () => {
  it('allows uploads on an unmetered connection with automatic upload on', () => {
    expect(
      evaluateUploadGate({
        autoUpload: true,
        wifiOnlyUploads: false,
        connectivity: connectivity(),
      }).allowed,
    ).toBe(true);
  });

  it('blocks when automatic upload is off, and says so', () => {
    const gate = evaluateUploadGate({
      autoUpload: false,
      wifiOnlyUploads: false,
      connectivity: connectivity(),
    });
    expect(gate.allowed).toBe(false);
    // The reason is rendered verbatim; a paused queue must never be silent.
    expect(gate.allowed === false && gate.reason).toMatch(/Settings/);
  });

  it('reports the disabled preference ahead of connectivity', () => {
    // Both are wrong here. Naming the toggle is actionable; "no connection" is not.
    const gate = evaluateUploadGate({
      autoUpload: false,
      wifiOnlyUploads: false,
      connectivity: connectivity({ isOnline: false }),
    });
    expect(gate.allowed === false && gate.reason).toMatch(/Automatic upload is off/);
  });

  it('blocks when offline', () => {
    const gate = evaluateUploadGate({
      autoUpload: true,
      wifiOnlyUploads: false,
      connectivity: connectivity({ isOnline: false }),
    });
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toMatch(/safe on this device/);
  });

  it('blocks a metered connection only when Wi-Fi only is on', () => {
    const metered = connectivity({ isMetered: true, type: 'cellular' });
    expect(
      evaluateUploadGate({ autoUpload: true, wifiOnlyUploads: false, connectivity: metered })
        .allowed,
    ).toBe(true);

    const gate = evaluateUploadGate({
      autoUpload: true,
      wifiOnlyUploads: true,
      connectivity: metered,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toMatch(/Wi-Fi/);
  });

  it('allows Wi-Fi only uploads once the connection is unmetered', () => {
    expect(
      evaluateUploadGate({
        autoUpload: true,
        wifiOnlyUploads: true,
        connectivity: connectivity({ isMetered: false }),
      }).allowed,
    ).toBe(true);
  });

  it('does not block on the optimistic pre-NetInfo default', () => {
    // The queue must not stall in the window before the first NetInfo event.
    expect(
      evaluateUploadGate({
        autoUpload: true,
        wifiOnlyUploads: true,
        connectivity: UNKNOWN_CONNECTIVITY,
      }).allowed,
    ).toBe(true);
  });
});

/**
 * The reachability probe decides the "No connection" banner, and its default
 * target is not our API.
 *
 * NetInfo HEADs https://clients3.google.com/generate_204 every 60 seconds and
 * flips isInternetReachable to false the first time that one request fails. On
 * a network that throttles or blocks Google, the app announced "No connection"
 * on stable Wi-Fi and recovered seconds later, in a loop, while the backend was
 * reachable throughout. Pointing the probe at our own health endpoint is what
 * makes "online" mean the thing the app depends on.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- the module configures NetInfo at import time, so it must be re-required after jest.doMock; a static import would bind before the mock exists. */
describe('reachability probe configuration', () => {
  it('probes the TexasRenters API, never a third party', () => {
    jest.resetModules();
    const configure = jest.fn();
    jest.doMock('@react-native-community/netinfo', () => ({
      __esModule: true,
      default: { configure, addEventListener: jest.fn(), fetch: jest.fn() },
    }));
    jest.doMock('../src/config/environment', () => ({
      environment: { apiBaseUrl: 'https://backend.example.test' },
    }));

    require('../src/lib/connectivity');

    expect(configure).toHaveBeenCalledTimes(1);
    const options = configure.mock.calls[0]![0] as {
      reachabilityUrl: string;
      reachabilityMethod: string;
    };
    expect(options.reachabilityUrl).toBe('https://backend.example.test/api/v1/health');
    expect(options.reachabilityUrl).not.toContain('google');
    // HEAD, because the endpoint answers it and a body buys nothing on a probe
    // that runs on every technician's device every minute.
    expect(options.reachabilityMethod).toBe('HEAD');
  });

  it('leaves NetInfo alone when no API base URL is configured', () => {
    // A build with no API URL has nothing useful to probe, and configuring an
    // empty target would report every device permanently offline.
    jest.resetModules();
    const configure = jest.fn();
    jest.doMock('@react-native-community/netinfo', () => ({
      __esModule: true,
      default: { configure, addEventListener: jest.fn(), fetch: jest.fn() },
    }));
    jest.doMock('../src/config/environment', () => ({ environment: { apiBaseUrl: null } }));

    require('../src/lib/connectivity');

    expect(configure).not.toHaveBeenCalled();
  });
});
