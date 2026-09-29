import { repositories } from '../repositories';
import { useDemoStore } from '../stores/demo.store';

import { deleteRoomSnapshot } from './local-snapshots';

/**
 * The old photographs of a changed area, removed now that new evidence
 * replaces them (the office, 2026-09-30: "if I use the photo or upload from
 * gallery, the old evidence should be removed and be replace with the new
 * ones").
 *
 * Change Evidence only marks them (`markEvidenceForReplacement`); the area
 * keeps its evidence until something replaces it, so a technician who reopens
 * an area and thinks better of it has lost nothing. Call this after the first
 * new photograph is filed -- from the camera or the gallery -- and it does
 * nothing on every photograph after that.
 *
 * On the phone at once: the old copies leave the area's strip and the upload
 * queue, and their files are deleted. On the server behind the technician,
 * saved first like every write here (`replaceRoomEvidence`), so a closed app or
 * a lost signal removes them later. Never the photograph just taken: the list
 * was made before it existed.
 */
export function replaceOldEvidence(roomId: string) {
  const state = useDemoStore.getState();
  const old = state.evidenceToReplace?.[roomId];
  if (!old) return;
  state.clearEvidenceReplacement(roomId);

  const doomed = new Set(old.photoKeys);
  const local = (state.snapshots ?? []).filter((snapshot) => doomed.has(snapshot.id));
  state.removeSnapshots(old.photoKeys);
  for (const snapshot of local) {
    try {
      deleteRoomSnapshot(snapshot.uri);
    } catch {
      // A file already gone is the outcome wanted.
    }
  }
  void repositories.inspections
    .replaceRoomEvidence(roomId, old.photoKeys, old.photoIds)
    // Held is kept and sent later; a refusal (a finalized inspection) leaves
    // the server's copies where the office can still see them.
    .catch(() => undefined);
}
