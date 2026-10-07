import * as LegacyFileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

/**
 * A recording sent to Cloudflare in one request, by the operating system.
 *
 * The chunked tus path reads every 10 MiB of a walkthrough into JavaScript and
 * hands it to `fetch`, a chunk at a time, for as long as the app stays open.
 * On an iPhone it also stops the moment the phone locks or the technician
 * switches apps, since iOS suspends the JavaScript that is driving it
 * (2026-10-06).
 *
 * `expo-file-system`'s upload task -- in the app since long before 1.3.0 --
 * gives the whole file to the platform instead: an iOS background
 * `URLSession` reading straight from disk, or OkHttp on Android. Not one byte
 * passes through JavaScript, and on iOS the transfer carries on while the app
 * is suspended. If iOS ends the app before it finishes, the bytes still arrive;
 * the queue's next pass asks Cloudflare how much it has and sends the rest in
 * chunks.
 */

/**
 * The largest single request Cloudflare's tus endpoint takes.
 *
 * Every other chunk must be a multiple of 256 KiB, but "the final chunk of an
 * upload that fits within a single chunk is exempt" -- so a whole file this size
 * or smaller goes in one PATCH. About six and a half minutes of video at the
 * 4 Mbps cap; a longer take is sent in chunks as before.
 */
export const WHOLE_FILE_MAX_BYTES = 209_715_200;

export interface WholeFileResponse {
  status: number;
  headers: Record<string, string>;
}

/** Sends one file as the body of one request; null when the request was cancelled. */
export type WholeFileSender = (request: {
  url: string;
  localUri: string;
  headers: Record<string, string>;
  onProgress: (sentBytes: number) => void;
}) => Promise<WholeFileResponse | null>;

/** The platform's own uploader, where there is one: never on the web build. */
export function nativeWholeFileSender(): WholeFileSender | undefined {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return undefined;
  return async ({ url, localUri, headers, onProgress }) => {
    const task = LegacyFileSystem.createUploadTask(
      url,
      localUri,
      {
        httpMethod: 'PATCH',
        uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
        // Ignored on Android, where the request lives as long as the process --
        // which the shift's location service keeps running.
        sessionType: LegacyFileSystem.FileSystemSessionType.BACKGROUND,
        headers,
      },
      ({ totalBytesSent }) => onProgress(totalBytesSent),
    );
    const result = await task.uploadAsync();
    return result ? { status: result.status, headers: result.headers ?? {} } : null;
  };
}

/** A response header by name, whatever case the platform reports it in. */
export function headerValue(headers: Record<string, string>, name: string) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}
