export const JOBBER_SOURCE_SYSTEM = 'jobber';

/**
 * Jobber pins breaking schema changes behind a date, sent on every request.
 *
 * Not optional and not defaulted by the API: an omitted header resolves to
 * whatever Jobber considers current, which means a field this code relies on
 * can disappear on a day nobody deployed anything. The value is configured
 * rather than hardcoded so the pin can be moved deliberately.
 */
export const JOBBER_VERSION_HEADER = 'x-jobber-graphql-version';

/** PKCE is S256-only; Jobber rejects `plain`. */
export const JOBBER_CODE_CHALLENGE_METHOD = 'S256';

/**
 * How early a token is treated as already expired.
 *
 * Access tokens live 60 minutes. Refreshing exactly at expiry races the request
 * that noticed — clock skew between us and Jobber, plus the flight time of the
 * request itself, is enough to send an expired token. A minute of slack costs
 * one extra refresh an hour and removes the race.
 */
export const JOBBER_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Authorization codes are single-use and die after 10 minutes. */
export const JOBBER_AUTH_STATE_TTL_MS = 10 * 60_000;
