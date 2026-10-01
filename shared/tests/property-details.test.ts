import { describe, expect, it } from 'vitest';

import {
  customFieldLabel,
  isAccessField,
  isPlaceholderValue,
  propertyDetailSections,
} from '../src/contracts/property-details';

/** The property page's Details tab (the office, 2026-10-01). Values invented. */

describe('what reads as empty', () => {
  it('is the office’s placeholders, in any case', () => {
    for (const value of ['Not Completed', 'UPDATE', 'N/A', 'na', 'n/a', '.', '..', '-', 'Not Provided', 'Not Applicable', '', '  ', null])
      expect(isPlaceholderValue(value)).toBe(true);
  });

  it('is never an answer, even a negative one', () => {
    for (const value of ['None', 'No', 'No Pool', 'In Lease', '20x25x1', '0123'])
      expect(isPlaceholderValue(value)).toBe(false);
  });
});

describe('the fields that open a home', () => {
  it('are the office’s code and key fields, renamed or not', () => {
    for (const name of ['Lockbox Code', 'Gated Community? Gate Code?', 'Alarm System Code', 'Garage Remotes_Garage Code', 'Mailbox Keys', 'Key Information - anything we need to know', 'Lockbox code #2'])
      expect(isAccessField(name)).toBe(true);
  });

  it('are not the ones that only mention keys or codes in passing', () => {
    for (const name of ['Property Re-Key', 'Code Work', 'Last Property Code Work Completed_Inspected', 'Occupancy Status'])
      expect(isAccessField(name)).toBe(false);
  });
});

describe('the sections on the page', () => {
  const sections = propertyDetailSections([
    { name: 'Occupancy Status', value: 'In Lease' },
    { name: 'Make Ready Notes', value: 'Not Completed' },
    { name: 'Lockbox Code', value: '1234' },
    { name: 'Gated Community? Gate Code?', value: '#5678' },
    { name: 'Sprinkler Notes', value: 'Front zone leaks' },
  ]);
  const section = (title: string) => sections.find((entry) => entry.title === title)!;

  it('list every field in order, filled or not, with placeholders as empty', () => {
    const status = section('Status & make ready').rows;
    expect(status[0]).toEqual({ name: 'Occupancy Status', label: 'Occupancy Status', value: 'In Lease' });
    expect(status[1]).toEqual({ name: 'Make Ready Notes', label: 'Make Ready Notes', value: null });
    expect(status.every((row) => row.value === null || row.name === 'Occupancy Status')).toBe(true);
  });

  it('never include an access code', () => {
    const shown = JSON.stringify(sections);
    expect(shown).not.toContain('1234');
    expect(shown).not.toContain('5678');
  });

  it('keep a field the office added in Propertyware, under Other', () => {
    expect(section('Other').rows).toEqual([{ name: 'Sprinkler Notes', label: 'Sprinkler Notes', value: 'Front zone leaks' }]);
  });

  it('label the office’s awkward names plainly', () => {
    expect(customFieldLabel('Owner Pet Prefences')).toBe('Owner pet preferences');
    expect(customFieldLabel('Zone')).toBe('Zone');
  });
});
