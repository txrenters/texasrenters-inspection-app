import { describe, expect, it } from 'vitest';

import { formatPhoneNumber, normalizePhoneNumber } from '../src/contracts/phone-number.js';

describe('normalizePhoneNumber', () => {
  it.each([
    ['(713) 555-0100', '+17135550100'],
    ['713.555.0100', '+17135550100'],
    ['713-555-0100', '+17135550100'],
    ['7135550100', '+17135550100'],
    ['1 713 555 0100', '+17135550100'],
    ['+1 (713) 555-0100', '+17135550100'],
    ['  713 555 0100  ', '+17135550100'],
    ['+63 917 123 4567', '+639171234567'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizePhoneNumber(input)).toBe(expected);
  });

  it.each([
    ['555-0100', 'too short for a US number'],
    ['2 713 555 0100', 'eleven digits that are not a US 1-prefix'],
    ['713 555 0100 ext 4', 'letters are refused, not dropped'],
    ['call 713 555 0100', 'letters are refused, not dropped'],
    ['+1234567', 'too short with a country code'],
    ['+1234567890123456', 'longer than E.164 allows'],
    ['', 'empty'],
    ['++17135550100', 'a doubled plus'],
  ])('refuses %s (%s)', (input) => {
    expect(normalizePhoneNumber(input)).toBeNull();
  });
});

describe('formatPhoneNumber', () => {
  it('writes a US number the way the office reads one', () => {
    expect(formatPhoneNumber('+17135550100')).toBe('(713) 555-0100');
  });

  it('leaves any other number as stored', () => {
    expect(formatPhoneNumber('+639171234567')).toBe('+639171234567');
    expect(formatPhoneNumber('not a number')).toBe('not a number');
  });
});
