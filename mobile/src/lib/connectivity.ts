import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import { environment } from '../config/environment';

/**
 * Probe our own API rather than Google's captive-portal endpoint.
 *
 * NetInfo decides `isInternetReachable` by HEADing
 * `https://clients3.google.com/generate_204` every 60 seconds with a 15 second
 * timeout, and flipping to false the first time that one request fails. On a
 * network that throttles or blocks Google — an office router doing client
 * isolation is a reliable way to get there — the app announced "No connection"
 * on stable Wi-Fi, recovered on the next 5 second retry, and did it again a
 * minute later. The API it actually needs was reachable throughout.
 *
 * Asking the API directly makes "online" mean the only thing the app cares
 * about: can we reach the backend. It also removes a request to a third party
 * from every technician's device every minute.
 *
 * Configured at module scope so it is in place before anything subscribes —
 * NetInfo applies configuration to the next probe, not retroactively.
 */
const reachabilityUrl = environment.apiBaseUrl
  ? `${environment.apiBaseUrl.replace(/\/$/, '')}/api/v1/health`
  : null;

if (reachabilityUrl)
  NetInfo.configure({
    reachabilityUrl,
    // The endpoint is unauthenticated and answers HEAD, so this costs a header
    // exchange rather than a body.
    reachabilityMethod: 'HEAD',
    reachabilityTest: (response) => Promise.resolve(response.status === 200),
    // A tunnelled request from a phone is slower than a Google 204 — measured
    // around half a second, but a cold edge or a congested cell is not. The
    // default 15s was tight enough that one slow response read as offline.
    reachabilityRequestTimeout: 20_000,
    reachabilityLongTimeout: 60_000,
    reachabilityShortTimeout: 5_000,
  });

/**
 * Real device connectivity, as the upload queue needs to see it.
 *
 * Before this module the app hard-coded `isOnline: true` in the demo store, so
 * the Uploads tab reported "Connected" while a technician stood in a basement
 * with no signal. Everything here is driven by NetInfo instead.
 */
export type Connectivity = {
  isOnline: boolean;
  /**
   * True when the technician is paying for the bytes — cellular, or any link
   * the OS reports as expensive (a metered hotspot reports Wi-Fi but is not
   * free). "Wi-Fi only uploads" is really "not metered", so it keys off this.
   */
  isMetered: boolean;
  /** NetInfo connection type, surfaced for diagnostics only. */
  type: string;
};

export const UNKNOWN_CONNECTIVITY: Connectivity = {
  // Optimistic until NetInfo reports: a false "offline" would stall the queue
  // on launch for the seconds before the first event arrives.
  isOnline: true,
  isMetered: false,
  type: 'unknown',
};

export function readConnectivity(state: NetInfoState): Connectivity {
  // isInternetReachable is null while NetInfo is still probing; treat that as
  // reachable and let the request itself fail rather than blocking uploads.
  const isOnline = Boolean(state.isConnected) && state.isInternetReachable !== false;
  // `details` is null for the "none"/"unknown" connection types, and the
  // expensive flag is absent on several others — both must be tolerated.
  const details = state.details as { isConnectionExpensive?: boolean } | null;
  const expensive = Boolean(details?.isConnectionExpensive);
  return {
    isOnline,
    isMetered: state.type === 'cellular' || expensive,
    type: state.type,
  };
}

export function subscribeToConnectivity(listener: (value: Connectivity) => void): () => void {
  return NetInfo.addEventListener((state) => listener(readConnectivity(state)));
}

export async function fetchConnectivity(): Promise<Connectivity> {
  return readConnectivity(await NetInfo.fetch());
}

export type UploadGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the upload queue may run right now.
 *
 * Kept pure and separate from the runner so the rules are testable and so the
 * Uploads tab can explain a stalled queue using the *same* logic that stopped
 * it — a paused queue with no visible reason is indistinguishable from a bug,
 * and this app asks technicians to confirm "pending uploads: 0" before they
 * finish a job.
 */
export function evaluateUploadGate(input: {
  autoUpload: boolean;
  wifiOnlyUploads: boolean;
  connectivity: Connectivity;
}): UploadGate {
  const { autoUpload, wifiOnlyUploads, connectivity } = input;
  if (!autoUpload)
    return {
      allowed: false,
      reason: 'Automatic upload is off. Turn it on in Settings to send queued evidence.',
    };
  if (!connectivity.isOnline)
    return {
      allowed: false,
      reason: 'No connection. Evidence is safe on this device and uploads resume automatically.',
    };
  if (wifiOnlyUploads && connectivity.isMetered)
    return {
      allowed: false,
      reason: 'Waiting for Wi-Fi. "Wi-Fi only uploads" is on and this connection is metered.',
    };
  return { allowed: true };
}
