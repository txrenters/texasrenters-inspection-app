import { progressBarWidth, progressPercent } from '../src/utils/upload-progress';

describe('progressPercent', () => {
  it('converts the 0–1 fraction every producer emits into a percentage', () => {
    // The bug this exists to prevent: 0.42 rendered as "0.42%" with a bar 0.42%
    // wide, which is visually identical to an upload that never started.
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(0.42)).toBe(42);
    expect(progressPercent(0.99)).toBe(99);
    expect(progressPercent(1)).toBe(100);
  });

  it('rounds to a whole number instead of printing a long float', () => {
    // 0.5063291139240506 was reaching the screen verbatim.
    expect(progressPercent(0.5063291139240506)).toBe(51);
  });

  it('tolerates a value that is already a percentage rather than showing 9900%', () => {
    expect(progressPercent(42)).toBe(42);
    expect(progressPercent(100)).toBe(100);
  });

  it('clamps nonsense instead of rendering a bar wider than its track', () => {
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(500)).toBe(100);
    expect(progressPercent(Number.NaN)).toBe(0);
    expect(progressPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('progressBarWidth', () => {
  it('renders a CSS-ready percentage width', () => {
    expect(progressBarWidth(0.42)).toBe('42%');
    expect(progressBarWidth(1)).toBe('100%');
  });

  it('keeps a started upload visible rather than rounding it to nothing', () => {
    // A 6 MB video 0.5% in has genuinely started; a 0%-wide bar says otherwise.
    expect(progressBarWidth(0.005)).toBe('2%');
    expect(progressBarWidth(0.011)).toBe('2%');
  });

  it('still shows exactly zero for an upload that has not begun', () => {
    expect(progressBarWidth(0)).toBe('0%');
  });
});
