import { describe, expect, it } from 'vitest';

import { businessDayOf, photoFileName, photoPlace } from './photo-file-name';

describe('a downloaded photograph’s name', () => {
  it('reads the property, what it shows and the day', () => {
    expect(photoFileName(['2210 Cedar Bend Dr Unit B', 'AC filter change', '2026-11-23'])).toBe(
      '2210 Cedar Bend Dr Unit B - AC filter change - 2026-11-23.jpg',
    );
    expect(photoFileName(['2210 Cedar Bend Dr Unit B', 'Kitchen', 'Area overview', '2026-11-23'])).toBe(
      '2210 Cedar Bend Dr Unit B - Kitchen - Area overview - 2026-11-23.jpg',
    );
  });

  it('leaves out what it does not know, and keeps out what a file name cannot hold', () => {
    expect(photoFileName([null, 'Kitchen · Move-in', undefined, '2026-11-23'])).toBe(
      'Kitchen - Move-in - 2026-11-23.jpg',
    );
    expect(photoFileName(['12 Oak St, Apt 4', 'Filter 20x25x1 / hall: "upper"?'])).toBe(
      '12 Oak St Apt 4 - Filter 20x25x1 hall upper.jpg',
    );
    expect(photoFileName([])).toBe('Photo.jpg');
  });

  it('takes the Texas day, not the reader’s', () => {
    // 9:30 PM in Texas is already the next morning in Manila, and past midnight UTC.
    expect(businessDayOf('2026-11-24T03:30:00.000Z')).toBe('2026-11-23');
    expect(businessDayOf(null)).toBeNull();
    expect(businessDayOf('not a date')).toBeNull();
  });
});

describe('where a photograph was taken', () => {
  it('is the street, then the unit', () => {
    expect(
      photoPlace({ propertywareBuilding: { addressLine1: '2210 Cedar Bend Dr' }, propertywareUnit: { name: 'Unit B' } }),
    ).toBe('2210 Cedar Bend Dr Unit B');
  });

  it('says the street once when the unit already carries it', () => {
    expect(
      photoPlace({
        propertywareBuilding: { addressLine1: '2210 Cedar Bend Dr' },
        propertywareUnit: { name: '2210 Cedar Bend Dr Unit B' },
      }),
    ).toBe('2210 Cedar Bend Dr Unit B');
    expect(photoPlace({ propertywareBuilding: { addressLine1: '5706 Oak Ln' }, propertywareUnit: null })).toBe(
      '5706 Oak Ln',
    );
  });

  it('falls back to the building’s name, and is nothing without either', () => {
    expect(photoPlace({ propertywareBuilding: { addressLine1: null, name: 'Mariposa Flats' } })).toBe('Mariposa Flats');
    expect(photoPlace(null)).toBeNull();
  });
});
