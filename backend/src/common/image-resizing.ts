import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Photos come straight off a phone camera — commonly 3–8 MB each. Serving those
 * originals to a homeowner's browser, or embedding twenty of them in a PDF,
 * produces a download nobody wants. Every delivered photo is therefore capped
 * at a sensible width first. At 1000px a photo is still sharp at the ~250pt
 * column the report layout uses, while typically shrinking 10–20x.
 *
 * Reuses ffmpeg-static, already a dependency for video processing, rather than
 * pulling in a second image library.
 */

/**
 * Only these widths may be requested. A public, unauthenticated endpoint drives
 * this and caches each width as its own stored object — an open integer would
 * let anyone fill the bucket with variants.
 */
export const ALLOWED_PHOTO_WIDTHS = [320, 1000] as const;
export type AllowedPhotoWidth = (typeof ALLOWED_PHOTO_WIDTHS)[number];

export function isAllowedPhotoWidth(value: number): value is AllowedPhotoWidth {
  return (ALLOWED_PHOTO_WIDTHS as readonly number[]).includes(value);
}

/**
 * Re-encodes to at most `width` px wide. Returns the original bytes whenever
 * resizing is impossible or would not help, so callers always get something
 * displayable rather than an error.
 */
export async function resizeImage(bytes: Buffer, width: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegPath = require('ffmpeg-static') as string | null;
  if (!ffmpegPath) return bytes;
  const directory = await mkdtemp(join(tmpdir(), 'txr-image-'));
  const input = join(directory, 'input');
  const output = join(directory, 'output.jpg');
  try {
    await writeFile(input, bytes);
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(ffmpegPath, [
        '-y',
        '-i',
        input,
        '-vf',
        // min() never upscales a photo already narrower than the target; -2
        // keeps the height even, which JPEG encoding requires.
        `scale='min(${width},iw)':-2`,
        '-q:v',
        '4',
        output,
      ]);
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) return bytes;
    const resized = await readFile(output);
    // A result that grew means the source was already well optimised.
    return resized.length > 0 && resized.length < bytes.length ? resized : bytes;
  } catch {
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
