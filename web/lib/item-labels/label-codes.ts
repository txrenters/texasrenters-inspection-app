import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';

/**
 * An item code as the two bar codes its label carries (2026-11-19): stripes
 * (Code 128) for a scanner device, and a QR square for a phone camera. Both
 * hold the item code itself and nothing else, so a label stays right for as
 * long as the code does, and a scan needs no lookup table of its own.
 *
 * Worked out in the browser from the code: nothing is asked of the server and
 * nothing billed is called.
 */

/** Blank modules either side of the stripes; a scanner needs ten to find where they start. */
export const QUIET_MODULES = 10;

/** The stripes, one entry a module, dark is true; the quiet zones are not included. */
export function stripeModules(code: string): boolean[] {
  const holder: { encodings?: { data: string }[] } = {};
  JsBarcode(holder, code, { format: 'CODE128' });
  const data = (holder.encodings ?? []).map((part) => part.data).join('');
  if (!data) throw new Error(`${code} cannot be drawn as a bar code.`);
  return [...data].map((module) => module === '1');
}

/** Each dark run of the stripes: its first module and its width in modules. */
export function stripeRuns(code: string): { runs: { at: number; width: number }[]; modules: number } {
  const modules = stripeModules(code);
  const runs: { at: number; width: number }[] = [];
  modules.forEach((dark, index) => {
    if (!dark) return;
    const last = runs.at(-1);
    if (last && last.at + last.width === index) last.width += 1;
    else runs.push({ at: index, width: 1 });
  });
  return { runs, modules: modules.length };
}

/** The QR square: its side in modules, and which are dark, row by row. */
export function qrModules(code: string): { size: number; dark: boolean[] } {
  const { modules } = QRCode.create(code, { errorCorrectionLevel: 'M' });
  return { size: modules.size, dark: Array.from(modules.data, (module) => Boolean(module)) };
}

/** The QR square as one SVG path over a `size` by `size` box. */
export function qrPath(code: string): { size: number; path: string } {
  const { size, dark } = qrModules(code);
  let path = '';
  dark.forEach((on, index) => {
    if (on) path += `M${index % size} ${Math.floor(index / size)}h1v1h-1z`;
  });
  return { size, path };
}
