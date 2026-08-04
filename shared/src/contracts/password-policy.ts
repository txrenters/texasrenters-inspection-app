/**
 * The password policy, defined once.
 *
 * It was previously written out in four places — the API DTO, the mobile
 * change-password screen, the web reset screen, and the copy telling people
 * what to type — and they drifted twice. The API asked for twelve characters
 * while the app checked eight, so a password could pass the form and be
 * refused by the server; both times a person hit it before a test did.
 *
 * Each rule carries its own message because a rejection has to name the
 * requirement that failed rather than list all of them. The regular
 * expressions are exported separately so the API's decorators can use the same
 * patterns these predicates do — `class-validator` takes a pattern, not a
 * function, so it cannot consume `PASSWORD_RULES` directly.
 */

export const MINIMUM_PASSWORD_LENGTH = 6;

/** bcrypt ignores anything past 72 bytes, so accepting more would be a lie. */
export const MAXIMUM_PASSWORD_LENGTH = 72;

export const PASSWORD_PATTERNS = {
  capital: /[A-Z]/,
  number: /[0-9]/,
  special: /[^A-Za-z0-9]/,
} as const;

export const PASSWORD_MESSAGES = {
  tooShort: `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.`,
  tooLong: `Use no more than ${MAXIMUM_PASSWORD_LENGTH} characters.`,
  capital: 'Include at least one capital letter.',
  number: 'Include at least one number.',
  special: 'Include at least one special character.',
} as const;

/** What to show before anything is typed, so the rules are read not discovered. */
export const PASSWORD_REQUIREMENT_SUMMARY = `At least ${MINIMUM_PASSWORD_LENGTH} characters, with a capital letter, a number and a special character.`;

export interface PasswordRule {
  test: (value: string) => boolean;
  message: string;
}

/** Ordered so the first failure reported is the most basic one. */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    test: (value) => value.length >= MINIMUM_PASSWORD_LENGTH,
    message: PASSWORD_MESSAGES.tooShort,
  },
  {
    test: (value) => value.length <= MAXIMUM_PASSWORD_LENGTH,
    message: PASSWORD_MESSAGES.tooLong,
  },
  { test: (value) => PASSWORD_PATTERNS.capital.test(value), message: PASSWORD_MESSAGES.capital },
  { test: (value) => PASSWORD_PATTERNS.number.test(value), message: PASSWORD_MESSAGES.number },
  { test: (value) => PASSWORD_PATTERNS.special.test(value), message: PASSWORD_MESSAGES.special },
];

/** The first unmet rule, or null. Clients check locally to save a round trip; the API still decides. */
export function firstUnmetPasswordRule(value: string): PasswordRule | null {
  return PASSWORD_RULES.find((rule) => !rule.test(value)) ?? null;
}
