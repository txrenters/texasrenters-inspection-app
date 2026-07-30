#!/usr/bin/env node
/**
 * Generates the light and dark splash assets from the brand logo.
 *
 * Re-run this when `docs/texasrenterslogo-transparent.png` changes:
 *
 *   node mobile-app-v2/scripts/build-splash.mjs
 *
 * Why a dark variant exists: the logo's "TEXAS" and ".com" are dark navy
 * (luminance ~55-62). On the dark theme's #0A0F18 background they are all but
 * invisible, while the green "RENTERS" (luminance ~146-169) reads fine. The
 * transform lifts only the dark pixels to the dark theme's foreground colour
 * and leaves the green untouched, so the mark keeps its identity in both
 * themes instead of being reduced to half a wordmark.
 *
 * Uses `sharp` from the workspace root. This is a build-time tool, not shipped.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ROOT, 'docs', 'texasrenterslogo-transparent.png');
const OUT_DIR = join(ROOT, 'mobile-app-v2', 'assets');

/** Square canvas: `resizeMode: 'contain'` fits it to screen width on a phone. */
const CANVAS = 1024;
/** Logo width as a fraction of the canvas — leaves a comfortable margin. */
const LOGO_SCALE = 0.62;
/** Below this luminance a pixel is the navy wordmark, not the green one. */
const DARK_PIXEL_LUMINANCE = 100;
/** Dark theme `--card-foreground`, so the splash matches the app it opens into. */
const DARK_THEME_INK = [236, 240, 243];

async function recolorForDarkTheme(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (luminance >= DARK_PIXEL_LUMINANCE) continue;
    // Alpha is preserved so antialiased edges stay smooth rather than jagged.
    [data[i], data[i + 1], data[i + 2]] = DARK_THEME_INK;
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function centerOnCanvas(logo) {
  const width = Math.round(CANVAS * LOGO_SCALE);
  const resized = await sharp(logo).resize({ width, fit: 'inside' }).png().toBuffer();
  return sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      // Transparent: the theme's backgroundColor shows through, so one asset
      // does not hardcode a background that would fight the other theme.
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, gravity: 'centre' }])
    .png()
    .toBuffer();
}

await mkdir(OUT_DIR, { recursive: true });

const original = await sharp(SOURCE).png().toBuffer();
await sharp(await centerOnCanvas(original)).toFile(join(OUT_DIR, 'splash-light.png'));
await sharp(await centerOnCanvas(await recolorForDarkTheme(original))).toFile(
  join(OUT_DIR, 'splash-dark.png'),
);

console.log(`Wrote splash-light.png and splash-dark.png (${CANVAS}x${CANVAS}) to assets/`);
