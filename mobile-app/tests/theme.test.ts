import { brandColors, darkColors, lightColors, resolveTheme } from '../src/theme';

describe('Texas Renters Inspection theme', () => {
  it('uses the dominant logo colors as the brand palette', () => {
    expect(brandColors.blue).toBe('#1D4492');
    expect(brandColors.green).toBe('#85C43F');
    expect(lightColors.primary).toBe(brandColors.blue);
    expect(lightColors.secondary).toBe(brandColors.green);
    expect(darkColors.secondary).toBe(brandColors.green);
  });

  it.each([
    ['light', 'dark', 'light'],
    ['dark', 'light', 'dark'],
    ['system', 'dark', 'dark'],
    ['system', 'light', 'light'],
    ['system', null, 'light'],
  ] as const)(
    'resolves %s preference with %s system mode to %s',
    (preference, system, expected) => {
      expect(resolveTheme(preference, system)).toBe(expected);
    },
  );
});
