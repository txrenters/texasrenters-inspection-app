import { AppState, Platform } from 'react-native';

import { UPLOAD_LINK_EXPIRED_MESSAGE } from './stream-upload-runner';
import type { UploadPath } from './tus-upload';
import { WHOLE_FILE_MAX_BYTES } from './whole-file-upload';

/**
 * Which queued recordings may go up now, and how many at once.
 *
 * One at a time, and nothing during a take, from 2026-10-06: the chunked
 * upload read 10 MiB at a time into JavaScript and turned it into a base64
 * string there, while the next room was being filmed, and iPhones in Low Power
 * Mode froze and closed. That step is gone (chunks go by `expo/fetch`), and a
 * fresh take now goes to Cloudflare whole, through the platform's own uploader
 * (`whole-file-upload`), which reads the file from disk without JavaScript.
 *
 * So from 2026-11-14, when the office said slow uploads were holding up its
 * work:
 * - a recording sent whole may start during a take, and two may go at once.
 *   Two, so the next room's video is already in the platform's hands when the
 *   phone locks, and keeps going there;
 * - the chunked path is as it was: alone, between takes. It is the one that
 *   runs JavaScript, and it stops when the phone locks anyway.
 */

/** How many recordings may be in flight at once. */
export const MAX_UPLOADS_AT_ONCE = 2;

export interface UploadPlan {
  /** The way it is expected to go; Cloudflare's own offset decides for certain once it starts. */
  path: UploadPath;
  /** Nothing else is sent beside it. */
  alone: boolean;
}

/**
 * How a queued recording is expected to go up.
 *
 * Whole when it is fresh and fits one request, on a phone with the uploader
 * (never the web build). A recording Cloudflare already has part of is resumed
 * in chunks, and so is one too large for one request: takes from before the
 * 195 MiB cap (`MAX_RECORDING_BYTES`).
 *
 * Alone in chunks, as always. And alone once its upload link lapsed before it
 * arrived: a link lasts about 55 minutes from the moment the upload starts, and
 * two transfers side by side each get half the signal. A long take on a weak
 * signal is let have all of it the second time.
 */
export function uploadPlan(
  item: { sizeBytes: number; uploadedBytes?: number; lastError?: string },
  nativeUploader: boolean,
): UploadPlan {
  const fresh = !(item.uploadedBytes && item.uploadedBytes > 0);
  const fits = item.sizeBytes > 0 && item.sizeBytes <= WHOLE_FILE_MAX_BYTES;
  const path: UploadPath = nativeUploader && fresh && fits ? 'whole-file' : 'chunks';
  return { path, alone: path === 'chunks' || item.lastError === UPLOAD_LINK_EXPIRED_MESSAGE };
}

export interface UploadConditions {
  /** A room is being filmed; see `capture-activity`. */
  filming: boolean;
  /** The platform starts a background transfer now, not when it sees fit; see `platformStartsTransfersNow`. */
  handOverNow: boolean;
}

/**
 * Whether a transfer handed to the platform now starts now.
 *
 * iOS treats a background transfer created while the app is in the background
 * as discretionary, and may hold it for Wi-Fi or a charger -- with its upload
 * link running out, and the queue waiting on it. The app runs in the
 * background all shift (location), so the queue does tick there. Android's
 * uploader has no such rule.
 */
export function platformStartsTransfersNow(): boolean {
  return Platform.OS !== 'ios' || AppState.currentState !== 'background';
}

/** The recordings in flight. Module state, like the lock it replaces: one queue per app. */
export function createUploadSlots(limit = MAX_UPLOADS_AT_ONCE) {
  /** Recording id → whether it goes alone. */
  const held = new Map<string, boolean>();
  const onlyOne = (id: string) => [...held.keys()].every((other) => other === id);

  return {
    get size() {
      return held.size;
    },
    holds(id: string) {
      return held.has(id);
    },
    /** Whether a recording with this plan may start now. */
    mayStart(plan: UploadPlan, { filming, handOverNow }: UploadConditions): boolean {
      if (held.size >= limit || [...held.values()].some(Boolean)) return false;
      if (plan.alone && held.size > 0) return false;
      return plan.path === 'whole-file' ? handOverNow : !filming;
    },
    /** Claimed before anything is awaited, so two ticks never take the same recording. */
    start(id: string, plan: UploadPlan) {
      held.set(id, plan.alone);
    },
    /**
     * Asked before every chunk: alone, and not during a take. A recording that
     * set out whole and has to finish in chunks waits here for the others.
     */
    mayChunk(id: string, filming: boolean): boolean {
      return !filming && onlyOne(id);
    },
    finish(id: string) {
      held.delete(id);
    },
  };
}

export type UploadSlots = ReturnType<typeof createUploadSlots>;
