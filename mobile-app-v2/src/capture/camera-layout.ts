/**
 * Camera screen zone geometry.
 *
 * The framing guide used to be `h-[48%]` of the *whole screen*, centred in a
 * full-screen absolute container, while the bottom control panel was a fixed
 * 288pt. On an iPhone 14 (844pt) that put the guide's lower edge at 624pt and
 * the panel's top edge at 556pt — 68pt of overlap. Solving
 * `0.74 × height > height − 288` shows it overlapped on any screen shorter than
 * ~1108pt, which is every iPhone ever shipped. A percentage of the screen can
 * never be safe, because it does not know what else is on the screen.
 *
 * So the guide is derived from what is actually left over after the header,
 * the capture-information region, the controls and both safe-area insets have
 * taken their space. Pure and measurement-driven, so it is testable against
 * real device dimensions.
 */

export type CameraLayoutInput = {
  screenHeight: number;
  screenWidth: number;
  topInset: number;
  bottomInset: number;
  /** Measured header height; falls back to a sensible default before layout. */
  headerHeight?: number;
  /** Measured height of the capture-info + controls + status stack. */
  bottomStackHeight?: number;
};

export type CameraLayout = {
  /** Vertical extent of the region the technician composes their shot in. */
  preview: { top: number; height: number };
  /** The framing guide, fully inside `preview`. */
  guide: { top: number; left: number; width: number; height: number };
  /** Where guidance chrome may sit without colliding with the guide edges. */
  guidanceTop: number;
  /** True when the screen is too short to show a usable guide at all. */
  collapsed: boolean;
};

/** 8-point spacing scale. Every gap in the camera chrome comes from here. */
export const SPACING = { xs: 4, sm: 8, md: 12, base: 16, lg: 24, xl: 32 } as const;

/** Minimum touch targets, per the platform accessibility guidance. */
export const TOUCH = { control: 44, snapshot: 56, record: 76 } as const;

const DEFAULT_HEADER_HEIGHT = 64;
const DEFAULT_BOTTOM_STACK_HEIGHT = 232;
/** Below this the guide stops being useful and is hidden rather than squashed. */
const MINIMUM_GUIDE_HEIGHT = 180;
/** Breathing room between the guide and the regions above and below it. */
const GUIDE_MARGIN = SPACING.lg;
const GUIDE_WIDTH_RATIO = 0.84;
/**
 * Cap the guide's aspect so it stays a framing hint rather than a full-height
 * box. Taller than this and it reads as an object-detection boundary — as if
 * anything outside it were excluded from the recording, which is false.
 */
const MAX_GUIDE_ASPECT = 1.5;

export function computeCameraLayout(input: CameraLayoutInput): CameraLayout {
  const {
    screenHeight,
    screenWidth,
    topInset,
    bottomInset,
    headerHeight = DEFAULT_HEADER_HEIGHT,
    bottomStackHeight = DEFAULT_BOTTOM_STACK_HEIGHT,
  } = input;

  const previewTop = topInset + headerHeight;
  const previewBottom = screenHeight - bottomInset - bottomStackHeight;
  const previewHeight = Math.max(0, previewBottom - previewTop);

  const availableGuideHeight = previewHeight - GUIDE_MARGIN * 2;
  const width = Math.round(screenWidth * GUIDE_WIDTH_RATIO);
  const height = Math.round(Math.min(availableGuideHeight, width * MAX_GUIDE_ASPECT));
  const collapsed = height < MINIMUM_GUIDE_HEIGHT;

  return {
    preview: { top: previewTop, height: previewHeight },
    guide: {
      top: Math.round(previewTop + (previewHeight - height) / 2),
      left: Math.round((screenWidth - width) / 2),
      width,
      height: Math.max(0, height),
    },
    // Guidance chrome sits just inside the guide's lower edge, so it never
    // strays into the controls and never covers the centre of the shot.
    guidanceTop: Math.round(previewTop + (previewHeight - height) / 2 + Math.max(0, height) - 96),
    collapsed,
  };
}

/** The guide's lower edge — the number that used to end up under the panel. */
export const guideBottom = (layout: CameraLayout) => layout.guide.top + layout.guide.height;

/** True when the guide is entirely within the preview region, inclusive. */
export function guideFitsInsidePreview(layout: CameraLayout): boolean {
  if (layout.collapsed) return true;
  return (
    layout.guide.top >= layout.preview.top &&
    guideBottom(layout) <= layout.preview.top + layout.preview.height
  );
}
