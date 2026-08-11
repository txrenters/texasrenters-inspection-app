import { describe, expect, it } from 'vitest';

import { propertyOptionLabel } from './property-label';

describe('propertyOptionLabel', () => {
  it('drops the name when the address already starts with it', () => {
    // The case from the field: the property is named after its own street, so
    // "name — address" printed the same thing twice.
    expect(
      propertyOptionLabel('10054 Copper Hollow Ln.', '10054 Copper Hollow Ln, Houston, TX 77044-5594'),
    ).toBe('10054 Copper Hollow Ln, Houston, TX 77044-5594');
  });

  it('ignores punctuation and spacing differences between the two fields', () => {
    // "Ln." vs "Ln", double spaces, trailing comma — all still the same street.
    expect(propertyOptionLabel('12 Oak St.', '12  Oak St, Austin, TX')).toBe('12  Oak St, Austin, TX');
  });

  it('keeps a genuinely distinct name', () => {
    expect(propertyOptionLabel('Westlake Tower', '900 Congress Ave, Austin, TX')).toBe(
      'Westlake Tower — 900 Congress Ave, Austin, TX',
    );
  });

  it('does not treat a different street with a shared prefix as redundant', () => {
    // "12 Oak" is not a prefix of "120 Oak" once normalised to whole tokens…
    expect(propertyOptionLabel('Oakland House', '12 Oak St, Austin, TX')).toBe(
      'Oakland House — 12 Oak St, Austin, TX',
    );
  });

  it('falls back cleanly when either side is missing', () => {
    expect(propertyOptionLabel('Westlake Tower', '')).toBe('Westlake Tower');
    expect(propertyOptionLabel('', '900 Congress Ave')).toBe('900 Congress Ave');
    expect(propertyOptionLabel('   ', '900 Congress Ave')).toBe('900 Congress Ave');
  });
});
