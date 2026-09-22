/**
 * Navigation's chrome.
 *
 * Every component in this directory is presentational: it takes plain props,
 * holds no session state, fetches nothing and navigates nowhere. The engine
 * decides which step the driver is on and whether they have arrived; the map
 * decides what is drawn under these; this directory only renders what it is
 * handed. Nothing here imports from `../engine` or `../map`, and the prop types
 * are declared locally and kept small so that stays true — a component that
 * needed `NavProgress` would be a component that had started deciding things.
 *
 * The exception, stated once: the shared contracts. `NavManeuver` and its
 * helpers come from `@texasrenters/shared` because an icon table keyed on
 * anything else would drift from the enum the router is normalised onto.
 */

export { ArrivalSheet } from './ArrivalSheet';
export { ChainRail, type ChainLeg, type ChainStop, type ChainStopState } from './ChainRail';
export { DayRow } from './DayRow';
export { ManeuverBanner, type BannerTone } from './ManeuverBanner';
export { ManeuverIcon } from './ManeuverIcon';
export { MapButtons, RecentrePill } from './MapButtons';
export { NavHud } from './NavHud';
export { NoRouteScreen, type NoRouteStop } from './NoRouteScreen';
export { OutOfOrderSheet } from './OutOfOrderSheet';
export { ResumeSheet } from './ResumeSheet';
export { SpeedPill } from './SpeedPill';
export { StepList, type ArrivalRow, type NextLegRow, type StepRow } from './StepList';
export {
  NAV_DARK,
  NAV_LIGHT,
  navColors,
  navDistance,
  navDuration,
  navMiles,
  roughBearing,
  useNavColors,
  type NavPalette,
} from './nav-colors';
