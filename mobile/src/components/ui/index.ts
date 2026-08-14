/**
 * The shared UI layer.
 *
 * This directory held only `Loader` and `Skeleton`, so every screen built its
 * own buttons, cards, badges and headers. That is where the drift came from:
 * five radius values in use with no rule, seven press treatments, four card
 * paddings, and 45 hardcoded colour literals filling in for tokens the
 * stylesheet could not reach.
 *
 * A screen should not be picking those values. Reach for a primitive first, and
 * if one does not fit, widen it here rather than hand-rolling beside it.
 */

export { Badge, BADGE_TONE_CLASS, type BadgeTone } from './Badge';
export { Button } from './Button';
export { Card, CardGroup } from './Card';
export { Loader } from './Loader';
export { PRESS_ROW, PRESS_SURFACE } from './press';
export { GroupLabel, ScreenHeader, SectionHeader } from './ScreenHeader';
export {
  DetailSkeleton,
  InspectionCardSkeleton,
  InspectionListSkeleton,
  MediaGridSkeleton,
  Skeleton,
  SkeletonScreen,
  StatsRowSkeleton,
  UploadListSkeleton,
} from './Skeleton';
