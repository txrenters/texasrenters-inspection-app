/**
 * Which frame the console is drawn in: the classic console, or the Jobber-style
 * shell (components/jobber-shell), for an office that spends its day in Jobber.
 *
 * Only the frame and the palette differ. The pages, the permissions and what
 * every button does are the same in both, so switching is a matter of taste and
 * can never lose anyone a feature.
 *
 * A cookie, not local storage, because the admin layout reads it on the server
 * and renders the chosen frame on the first paint -- the same reason the
 * sidebar's open state is a cookie. Per browser, not per account: it is how this
 * screen looks, not who you are.
 */
export type ConsoleShell = 'classic' | 'jobber';

export const CONSOLE_SHELL_COOKIE = 'console_shell';

/** Classic until somebody chooses otherwise, so nobody's screen changes under them. */
export const DEFAULT_CONSOLE_SHELL: ConsoleShell = 'classic';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Anything but a known shell (a missing cookie, an old value) is the default. */
export function parseConsoleShell(value: string | undefined | null): ConsoleShell {
  return value === 'jobber' || value === 'classic' ? value : DEFAULT_CONSOLE_SHELL;
}

/** The `document.cookie` assignment that remembers a choice for a year. */
export function consoleShellCookie(shell: ConsoleShell) {
  return `${CONSOLE_SHELL_COOKIE}=${shell}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
