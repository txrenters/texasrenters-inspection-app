/**
 * The navigation engine: what it decides, and what it needs to decide it.
 *
 * The screens import from here. Note what is *not* exported: there is no way in
 * from this directory to the shift's location queue, its storage or its sender.
 * Navigation reads positions and never records one -- which is the whole of why
 * a second consumer of the GPS is safe here when a second *recorder* was not.
 * See the note at the top of `nav-fixes.ts`.
 *
 * `nav-session.ts` is pure and has no React in it; import it directly from a
 * test rather than through this file, which pulls `expo-location` in behind it.
 */

export {
  announce,
  announcementSentence,
  maneuverClause,
  type NavAnnouncement,
  type NavSpeaker,
} from './announcer';

export { formatArrivalClock, formatDistance, formatDuration, milesFromMeters } from './format';

export {
  latestNavFix,
  navFixesArePublished,
  publishNavFix,
  resetNavFixes,
  subscribeToNavFixes,
} from './nav-fixes';

export {
  INITIAL_NAV_SESSION,
  NAV_ADVANCE_COUNTDOWN_MS,
  NAV_LEG_RETRY_MS,
  NAV_REROUTE_MIN_SPACING_MS,
  NAV_SIGNAL_LOST_MS,
  advanceNavSession,
  chainFromLegs,
  legPathFor,
  skipToNextStop,
  startNavSession,
  stopNavSession,
  type NavBlockReason,
  type NavDayRoute,
  type NavDayStop,
  type NavEffect,
  type NavPhase,
  type NavSessionInput,
  type NavSessionState,
  type NavSessionStep,
  type NavSessionView,
} from './nav-session';

export {
  useNavigationSession,
  type NavLegRequest,
  type NavigationSession,
  type UseNavigationSessionOptions,
} from './useNavigationSession';
