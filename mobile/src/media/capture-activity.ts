/**
 * Whether the camera is filming right now, for the work that must wait on it.
 *
 * The office's rule (2026-10-06): nothing uploads during a take. A move-out
 * films one room while the last room's video is still going up, and the two
 * fought over the same phone -- the encoder and the camera's buffers on one
 * side, the upload's memory and the radio on the other. Technicians on iPhones
 * saw the app freeze and then close, worst in Low Power Mode. Uploads now run
 * between rooms: the queue stops at the next chunk boundary when a take starts
 * and carries on from Cloudflare's offset when it ends.
 *
 * Module state rather than a store, because nothing renders from it: the camera
 * writes it and the upload queue reads it, and neither should re-render the
 * other.
 */

let recording = false;
const listeners = new Set<(recording: boolean) => void>();

export function isCaptureActive(): boolean {
  return recording;
}

export function setCaptureActive(active: boolean): void {
  if (recording === active) return;
  recording = active;
  listeners.forEach((listener) => listener(active));
}

/** Called on every change; returns the unsubscribe. */
export function subscribeToCaptureActivity(listener: (recording: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
