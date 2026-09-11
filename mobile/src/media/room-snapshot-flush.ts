import { flushRoomSnapshots } from './snapshot-upload';
import { useDemoStore } from '../stores/demo.store';

/**
 * `flushRoomSnapshots`, bound to the device's snapshot store.
 *
 * A module of its own because both callers sit on the wrong side of an import
 * cycle from each other: `repositories.ts` completes an area, `offline-writes`
 * replays that completion when the signal returns, and `repositories.ts`
 * already imports `offline-writes`. Putting the store wiring here lets both
 * reach it without either importing the other.
 *
 * `snapshot-upload` itself stays store-agnostic — it takes a port so its rules
 * can be tested without zustand — so this is the one place that knows where the
 * snapshots actually live.
 */
export async function flushRoomSnapshotsNow(roomId: string): Promise<void> {
  const { snapshots, updateSnapshot } = useDemoStore.getState();
  await flushRoomSnapshots(roomId, snapshots ?? [], { update: updateSnapshot });
}
