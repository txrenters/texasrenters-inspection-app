import {
  computeCameraLayout,
  guideBottom,
  guideFitsInsidePreview,
  type CameraLayoutInput,
} from '../src/capture/camera-layout';

/**
 * Real logical dimensions and safe-area insets. The overlap bug was invisible
 * in code review precisely because it depended on these numbers.
 */
const DEVICES: { name: string; input: CameraLayoutInput }[] = [
  {
    name: 'iPhone SE (3rd gen)',
    input: { screenHeight: 667, screenWidth: 375, topInset: 20, bottomInset: 0 },
  },
  {
    name: 'iPhone 13 mini',
    input: { screenHeight: 812, screenWidth: 375, topInset: 50, bottomInset: 34 },
  },
  {
    name: 'iPhone 14',
    input: { screenHeight: 844, screenWidth: 390, topInset: 47, bottomInset: 34 },
  },
  {
    name: 'iPhone 15 Pro Max',
    input: { screenHeight: 932, screenWidth: 430, topInset: 59, bottomInset: 34 },
  },
];

describe('computeCameraLayout', () => {
  it.each(DEVICES)('keeps the framing guide inside the preview on $name', ({ input }) => {
    expect(guideFitsInsidePreview(computeCameraLayout(input))).toBe(true);
  });

  it.each(DEVICES)('keeps the guide clear of the bottom control stack on $name', ({ input }) => {
    const layout = computeCameraLayout(input);
    const controlsTop = input.screenHeight - input.bottomInset - 232;
    // The original defect, stated as an assertion: on an iPhone 14 the guide
    // ended 68pt *below* this line.
    expect(guideBottom(layout)).toBeLessThanOrEqual(controlsTop);
  });

  it.each(DEVICES)('keeps the guide below the header on $name', ({ input }) => {
    const layout = computeCameraLayout(input);
    expect(layout.guide.top).toBeGreaterThanOrEqual(input.topInset);
  });

  it('reproduces the original overlap when the guide is a share of screen height', () => {
    // Guards the reasoning, not just the result: 48% of screen height centred
    // on the full screen cannot clear a 288pt panel on any iPhone.
    const screenHeight = 844;
    const legacyGuideHeight = screenHeight * 0.48;
    const legacyBottom = screenHeight / 2 + legacyGuideHeight / 2;
    const legacyPanelTop = screenHeight - 288;
    expect(legacyBottom - legacyPanelTop).toBeGreaterThan(60);

    const fixed = computeCameraLayout(DEVICES[2]!.input);
    expect(guideBottom(fixed)).toBeLessThan(legacyPanelTop);
  });

  it('shrinks the guide when the bottom stack grows, instead of overlapping it', () => {
    const base = computeCameraLayout({ ...DEVICES[2]!.input, bottomStackHeight: 200 });
    const taller = computeCameraLayout({ ...DEVICES[2]!.input, bottomStackHeight: 320 });
    expect(taller.guide.height).toBeLessThan(base.guide.height);
    expect(guideFitsInsidePreview(taller)).toBe(true);
  });

  it('adapts to a taller header rather than pushing the guide upward', () => {
    const base = computeCameraLayout({ ...DEVICES[2]!.input, headerHeight: 64 });
    const tall = computeCameraLayout({ ...DEVICES[2]!.input, headerHeight: 120 });
    expect(tall.guide.top).toBeGreaterThan(base.guide.top);
    expect(guideFitsInsidePreview(tall)).toBe(true);
  });

  it('caps the aspect so the guide never reads as an exclusion boundary', () => {
    const layout = computeCameraLayout(DEVICES[3]!.input);
    expect(layout.guide.height / layout.guide.width).toBeLessThanOrEqual(1.5);
  });

  it('collapses rather than rendering a squashed guide on an extreme layout', () => {
    const layout = computeCameraLayout({
      ...DEVICES[0]!.input,
      bottomStackHeight: 460,
    });
    expect(layout.collapsed).toBe(true);
    // Still reports as "fits", so the caller hides it instead of clamping it
    // into the controls.
    expect(guideFitsInsidePreview(layout)).toBe(true);
  });

  it('never returns a negative height when the screen is impossibly short', () => {
    const layout = computeCameraLayout({
      screenHeight: 300,
      screenWidth: 375,
      topInset: 47,
      bottomInset: 34,
    });
    expect(layout.guide.height).toBeGreaterThanOrEqual(0);
    expect(layout.preview.height).toBeGreaterThanOrEqual(0);
  });

  it('centres the guide horizontally', () => {
    const { input } = DEVICES[2]!;
    const layout = computeCameraLayout(input);
    expect(layout.guide.left * 2 + layout.guide.width).toBe(input.screenWidth);
  });
});
