/**
 * When it is fair to interrupt a technician about a downloaded update.
 *
 * Kept out of the component because this project has no React renderer, and
 * "never interrupts a recording" is a rule worth asserting rather than trusting.
 */

/**
 * Screens where a prompt would cost work rather than a tap.
 *
 * The camera holds a take that cannot be resumed, and the review screen holds
 * one that has not been saved yet. A sheet over either is at best a fumbled
 * dismissal mid-walkthrough and at worst a lost room, so the update waits —
 * it has already been downloaded and is not going anywhere.
 */
const PROTECTED_PATH_FRAGMENTS = ['/camera/', '/recording-review/'] as const;

export function isSafeToInterrupt(pathname: string) {
  return !PROTECTED_PATH_FRAGMENTS.some((fragment) => pathname.includes(fragment));
}

export function shouldPromptForUpdate({
  dismissed,
  isUpdatePending,
  pathname,
}: {
  /** Set by "Later", so the prompt does not reappear on every navigation. */
  dismissed: boolean;
  /** expo-updates: an update is downloaded and applies on the next reload. */
  isUpdatePending: boolean;
  pathname: string;
}) {
  // Pending, not merely available: an update that has not finished downloading
  // cannot be applied by restarting, so offering to restart would be a lie.
  return isUpdatePending && !dismissed && isSafeToInterrupt(pathname);
}
