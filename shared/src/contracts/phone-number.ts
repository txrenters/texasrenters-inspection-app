/**
 * A person's phone number, read the same way by the API and the console.
 *
 * Stored in E.164 (`+17135550100`) so a `tel:` link needs no further work and
 * two spellings of one number compare equal. Typed however the office types it:
 * "(713) 555-0100", "713.555.0100", "+1 713 555 0100". Ten digits are a US
 * number, as every phone on the team is; anything else has to say its own
 * country code with a leading "+".
 */

/** E.164 allows at most fifteen digits; eight is the shortest real number. */
const MIN_INTERNATIONAL_DIGITS = 8;
const MAX_INTERNATIONAL_DIGITS = 15;

/** What to show beside the field, so a refusal is never a surprise. */
export const PHONE_NUMBER_HINT = 'A 10-digit US number, or + and the country code.';

/**
 * The number in E.164, or null when it is not one.
 *
 * Only separators people actually type are tolerated: spaces, dots, dashes and
 * brackets. Letters ("ext 4", "call after 5") are refused rather than dropped,
 * because silently storing part of what was typed is how a number goes wrong.
 */
export function normalizePhoneNumber(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    return digits.length >= MIN_INTERNATIONAL_DIGITS && digits.length <= MAX_INTERNATIONAL_DIGITS
      ? `+${digits}`
      : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * A stored number written for people: US numbers as "(713) 555-0100", anything
 * else as stored. Never throws on a value it does not recognise.
 */
export function formatPhoneNumber(stored: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(stored);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : stored;
}
