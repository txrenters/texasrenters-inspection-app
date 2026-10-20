import { formatEnumLabel } from '@texasrenters/shared';
import type { InspectionType } from '@texasrenters/shared';

/**
 * What a downloaded report is called, in the office's words.
 *
 * The office uploads every report to Propertyware as it downloads it, and asked
 * on 2026-10-20 for the file to arrive already named the way they name it there
 * -- `318 Notional Harbor Ln_Occupied Inspection.pdf` -- rather than renaming a
 * lowercase slug by hand each time.
 *
 * Deliberately not the report's `templateLabel`: that is the name printed on the
 * form ("Routine Inspection" for an occupied visit), while Propertyware files
 * an occupied visit as an "Occupied Inspection".
 */
const INSPECTION_FILE_LABEL: Record<InspectionType, string> = {
  MOVE_IN: 'Move In Inspection',
  MOVE_OUT: 'Move Out Inspection',
  OCCUPIED: 'Occupied Inspection',
  BACK_TO_MARKET: 'Back to Market Inspection',
  HVAC: 'HVAC Inspection',
  ROOF: 'Roof Inspection',
  SUPRA_LOCKBOX_PLACEMENT: 'Supra Lockbox Placement',
  SUPRA_LOCKBOX_REMOVAL: 'Supra Lockbox Removal',
  AC_FILTER_DELIVERY: 'AC Filter Delivery',
};

export const COMPARISON_FILE_LABEL = 'Move In Move Out Comparison';

/** Leaves room for the label and `.pdf` well inside any file system's limit. */
const MAX_ADDRESS_LENGTH = 100;

export function inspectionFileLabel(type: string) {
  return (
    INSPECTION_FILE_LABEL[type as InspectionType] ?? `${formatEnumLabel(type)} Inspection`
  );
}

/**
 * The property as the file name spells it: `318 Notional Harbor Ln Unit B`.
 *
 * The address keeps the capitals it was stored with -- the office asked for
 * them -- and a word stored all in lowercase gets its first letter raised.
 * Characters Windows refuses in a file name are dropped, since that is where
 * the file is saved before it goes to Propertyware.
 */
export function propertyFileStem(property: {
  name: string;
  addressLine1: string;
  unitName?: string | null;
}) {
  const unit = property.unitName?.trim() ? ` Unit ${property.unitName.trim()}` : '';
  return `${property.addressLine1 || property.name}${unit}`
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    // Not `\b`: it splits "Ñandú" after the Ñ and would raise the a.
    .replace(/(^|\s)(\p{Ll})/gu, (_, space: string, letter: string) => space + letter.toUpperCase())
    .slice(0, MAX_ADDRESS_LENGTH)
    .replace(/[\s.]+$/, '')
    .trim();
}

/** `318 Notional Harbor Ln_Occupied Inspection.pdf`, or the label alone with no address. */
export function reportPdfFileName(
  property: Parameters<typeof propertyFileStem>[0],
  label: string,
) {
  const stem = propertyFileStem(property);
  return `${stem ? `${stem}_` : ''}${label}.pdf`;
}

/**
 * The `Content-Disposition` for a download of `fileName`.
 *
 * A header value must be plain ASCII -- a Headers object throws on anything
 * else, which would turn an accented street name into a failed download -- so
 * `filename` carries an ASCII copy and `filename*` the exact name for every
 * browser that reads it (all current ones).
 */
export function attachmentDisposition(fileName: string) {
  const ascii = fileName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
