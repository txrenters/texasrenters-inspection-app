import { create } from 'zustand';

import { UNKNOWN_CONNECTIVITY, type Connectivity } from '../lib/connectivity';

/**
 * Device connectivity, fed by NetInfo through `ConnectivitySync`.
 *
 * This file used to be `export { useDemoStore as useNetworkStore }` — a
 * re-export of the demo store, whose `isOnline` was initialised to `true` and
 * never written by anything. Every consumer therefore rendered "Connected"
 * unconditionally, including the Uploads tab and the diagnostics screen a
 * technician is asked to send when reporting a problem.
 */
type NetworkState = Connectivity & {
  /** False until NetInfo reports for the first time. */
  isResolved: boolean;
  setConnectivity: (value: Connectivity) => void;
};

export const useNetworkStore = create<NetworkState>()((set) => ({
  ...UNKNOWN_CONNECTIVITY,
  isResolved: false,
  setConnectivity: (value) => set({ ...value, isResolved: true }),
}));
