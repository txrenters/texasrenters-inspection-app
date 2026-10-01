import { apiBlob } from '@/lib/api';

/**
 * Full-size photographs for the evidence viewer, kept for a while after they
 * have been shown.
 *
 * Each one comes through the authenticated API, which answers `no-store`, so
 * the browser keeps none of them, and the viewer used to throw each one away
 * as soon as it moved on. Measured from the office on 2026-10-02: 1.9 s for a
 * 639 KB photograph, paid again on every return to it. A 320 px thumbnail
 * still took 0.8-1.2 s, so the wait is mostly the round trip rather than the
 * size -- which is why fetching the next photograph while this one is being
 * looked at helps more than asking for a smaller one would.
 *
 * Bounded, because these are originals: a dozen is a few megabytes, a whole
 * inspection would not be. Least recently used goes first.
 */
const LIMIT = 12;

const loading = new Map<string, Promise<string>>();
/** The object URL of each photograph that has arrived, readable without waiting. */
const ready = new Map<string, string>();

/** The photograph's object URL, if it has already arrived. */
export function cachedPhoto(path: string): string | null {
  return ready.get(path) ?? null;
}

/** The photograph's object URL, fetching it once however many ask. */
export function loadPhoto(path: string): Promise<string> {
  const existing = loading.get(path);
  if (existing) {
    // Re-inserted so it counts as the most recently used.
    loading.delete(path);
    loading.set(path, existing);
    return existing;
  }
  const request = apiBlob(path).then((blob) => {
    const url = URL.createObjectURL(blob);
    // Kept only while still wanted. One evicted on its way is handed to whoever
    // was waiting for it and left for the page to release, rather than revoked
    // under an <img> that is about to show it.
    if (loading.get(path) === request) ready.set(path, url);
    return url;
  });
  loading.set(path, request);
  // A failure is not kept. The next attempt should ask again, not replay it.
  request.catch(() => {
    if (loading.get(path) === request) loading.delete(path);
  });
  evict();
  return request;
}

/** Fetches a photograph that is likely to be wanted next, ignoring failure. */
export function preloadPhoto(path: string) {
  void loadPhoto(path).catch(() => undefined);
}

function evict() {
  for (const path of loading.keys()) {
    if (loading.size <= LIMIT) return;
    loading.delete(path);
    const url = ready.get(path);
    ready.delete(path);
    if (url) URL.revokeObjectURL(url);
  }
}

/** For tests: start from nothing. */
export function forgetPhotos() {
  for (const url of ready.values()) URL.revokeObjectURL(url);
  loading.clear();
  ready.clear();
}
