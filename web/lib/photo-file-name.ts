import { BUSINESS_TIME_ZONE } from '@/lib/clock';

/**
 * Names for a downloaded photograph (approved on the canvas, 2026-11-26):
 * the property, what the photo is of, and the day, so a folder of them reads
 * without opening any --
 *
 *   2210 Cedar Bend Dr Unit B - AC filter change - 2026-11-23.jpg
 *   2210 Cedar Bend Dr Unit B - Kitchen - Area overview - 2026-11-23.jpg
 *
 * The file itself is the original, untouched; only its name is made here. The
 * API names it `photo-<id>`, which says nothing to whoever finds it later.
 */

/** What a file name cannot hold on Windows or a Mac, and a comma, which reads badly in one. */
const UNSAFE = /[\\/:*?"<>|,]+/g;
/** The console's own separator, "Kitchen · Move-in", becomes the file name's. */
const DOT = /\s*·\s*/g;

export function photoFileName(parts: ReadonlyArray<string | null | undefined>, extension = 'jpg') {
  const name = parts
    .map((part) => part?.replace(DOT, ' - ').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' - ');
  return `${name || 'Photo'}.${extension}`;
}

/** The Texas day of a moment, `yyyy-MM-dd`: a Manila evening is already tomorrow. */
export function businessDayOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIME_ZONE });
}

/** Where the photograph was taken, as a file name starts: the street, then the unit. */
export function photoPlace(
  inspection:
    | {
        propertywareBuilding?: { addressLine1?: string | null; name?: string | null } | null;
        propertywareUnit?: { name?: string | null } | null;
      }
    | null
    | undefined,
): string | null {
  const building = inspection?.propertywareBuilding;
  const street = building?.addressLine1?.trim() || building?.name?.trim() || null;
  const unit = inspection?.propertywareUnit?.name?.trim() || null;
  if (!street) return unit;
  if (!unit || street.toLowerCase().includes(unit.toLowerCase())) return street;
  // A unit named for its whole address already says the street.
  if (unit.toLowerCase().includes(street.toLowerCase())) return unit;
  return `${street} ${unit}`;
}
