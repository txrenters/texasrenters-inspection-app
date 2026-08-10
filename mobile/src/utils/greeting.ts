/**
 * The time-of-day greeting, in the technician's own local time.
 *
 * **This deliberately does not use location.** A device already knows where it
 * is, in the only sense that matters here: its clock and time zone follow the
 * technician. A phone in Manila reports 09:00 at nine in the morning Manila
 * time; the same phone in Texas reports 09:00 at nine in the morning Texas
 * time. `Date` reads that setting, so the greeting is already correct on both
 * without asking anyone anything.
 *
 * Location would add a permission prompt, a denial path, a native module, and a
 * privacy question — and produce the same answer. The one case it would
 * genuinely fix is a phone whose time zone is set wrong, and that phone is
 * already showing the wrong time everywhere else, which the technician would
 * notice long before reading a greeting.
 */
export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening';

/**
 * Boundaries at noon and 18:00.
 *
 * "Evening" rather than "night" past midnight: a technician opening the app at
 * 01:00 is finishing a long day, and being told "good night" by their own
 * timesheet reads as sarcasm. Three greetings also keep the string list short
 * enough to stay honest — every extra band is another boundary to argue about.
 */
export function greetingFor(date: Date = new Date()): Greeting {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
