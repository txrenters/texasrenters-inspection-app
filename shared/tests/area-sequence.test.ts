import { describe, expect, it } from 'vitest';

import { areaSequenceKey, sortAreasBySequence } from '../src/index.js';

/**
 * The office's order for a property's rooms (the maintenance team, 2026-10-08):
 * always the entrance first.
 */
describe('the order rooms are listed in', () => {
  it('follows the office’s list, from names written the way they are on real houses', () => {
    // 20906 Greenfield Trl's move-out, in the order it was walked.
    const walked = [
      'Bedroom 1',
      'Bedroom 4',
      'Bathroom 1',
      'Bathroom 3',
      'Outside Area 1',
      'Outside Area 2',
      'Office. Front Of The Home.',
      'Master Bedroom',
      'Master Bathroom',
      'Bathroom Downstairs',
      'Upstairs Hallway',
      'Bedroom 3 (Right-Right)',
      'Stairs',
      'Gameroom',
      'Entrance',
      'Formal Dining Room',
      'Garage',
      'Downstairs hallway',
      'Downstairs living room',
      'Laundry',
      'Kitchen',
      'Breakfast room',
    ];

    expect(sortAreasBySequence(walked, (name) => name)).toEqual([
      'Entrance',
      'Downstairs living room',
      'Formal Dining Room',
      'Breakfast room',
      'Kitchen',
      'Master Bedroom',
      'Bedroom 1',
      'Bedroom 3 (Right-Right)',
      'Bedroom 4',
      'Master Bathroom',
      'Bathroom 1',
      'Bathroom 3',
      'Bathroom Downstairs',
      'Office. Front Of The Home.',
      'Gameroom',
      'Stairs',
      'Upstairs Hallway',
      'Downstairs hallway',
      'Laundry',
      'Garage',
      'Outside Area 1',
      'Outside Area 2',
    ]);
  });

  it('puts a room the list does not name last, keeping the order those came in', () => {
    expect(sortAreasBySequence(['Attic', 'Kitchen', 'Wine cellar', 'Entry'], (name) => name)).toEqual([
      'Entry',
      'Kitchen',
      'Attic',
      'Wine cellar',
    ]);
  });

  it('goes by a room’s number, not by its letters', () => {
    expect(sortAreasBySequence(['Bedroom 10', 'Bedroom 2', 'Bedroom'], (name) => name)).toEqual([
      'Bedroom',
      'Bedroom 2',
      'Bedroom 10',
    ]);
  });

  it('reads the room each name is, not the words it shares with another', () => {
    expect(areaSequenceKey('Master Bathroom').kind).toBe('Master Bathroom');
    expect(areaSequenceKey('Primary suite').kind).toBe('Master Bedroom');
    expect(areaSequenceKey('Half bath').kind).toBe('Bathroom Downstairs');
    expect(areaSequenceKey('Upstairs Hallway').kind).toBe('Upstairs Hallway');
    expect(areaSequenceKey('Hallway Between Bedrooms').kind).toBe('Downstairs Hallway');
    expect(areaSequenceKey('Game Room').kind).toBe('Game Room');
    expect(areaSequenceKey('Staircase').kind).toBe('Stairs');
    expect(areaSequenceKey('Back Yard').kind).toBe('Outside Areas');
  });
});
