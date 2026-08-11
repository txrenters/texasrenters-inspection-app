import { describe, expect, it } from 'vitest';

import { checklistTemplateFor, classifyAreaByName } from '../src/index.js';

/** What an extracted area ends up with: classify by name, then take its list. */
function checklistForExtractedName(name: string) {
  const { environment, category } = classifyAreaByName(name);
  return checklistTemplateFor({ name, environment, category });
}

describe('classifyAreaByName', () => {
  it('sends outdoor space outdoors, which is the whole point', () => {
    // The regression this exists to prevent: the floor-plan model returns a
    // name and no classification, so these all landed as INDOOR and were handed
    // a checklist asking a technician to inspect the ceiling of a lawn.
    for (const name of ['Back Yard', 'Front Porch', 'Patio (left)', 'Balcony', 'Rear Deck']) {
      expect(classifyAreaByName(name).environment, name).not.toBe('INDOOR');
      expect(checklistForExtractedName(name), name).toContain('Lawn and garden');
      expect(checklistForExtractedName(name), name).not.toContain('Walls and ceilings');
    }
  });

  it('keeps a garage indoors, because it has the things the indoor list asks about', () => {
    // Enclosed, with doors, walls and lights — the source report gives
    // GARAGE/CARPORT the indoor base plus shelving, not the outdoor list.
    const garage = classifyAreaByName('Two-car Garage');
    expect(garage.environment).toBe('INDOOR');
    expect(garage.category).toBe('GARAGE');
    expect(checklistForExtractedName('Two-car Garage')).toEqual([
      'Doors and locks',
      'Walls and ceilings',
      'Floor and coverings',
      'Windows and locks',
      'Lights and power points',
      'Shelving and workbench',
      'Smoke alarms',
    ]);
    // Offered, not demanded — same judgement the extraction service made.
    expect(garage.isRequired).toBe(false);
    expect(classifyAreaByName('Back Yard').isRequired).toBe(false);
    expect(classifyAreaByName('Kitchen').isRequired).toBe(true);
  });

  it('gives an enclosed space the indoor list even when it is filed outdoors', () => {
    // The mobile Add Area form offers Garage as SEMI_OUTDOOR. checklistTemplateFor
    // used to return on the environment alone, so a garage was asked about its
    // lawn and never about its doors, walls or lights.
    const garage = checklistTemplateFor({
      name: 'Garage',
      category: 'GARAGE',
      environment: 'SEMI_OUTDOOR',
    });
    expect(garage).toContain('Doors and locks');
    expect(garage).toContain('Shelving and workbench');
    expect(garage).not.toContain('Lawn and garden');

    // A genuine outdoor area is unaffected — no category, or an outdoor one.
    expect(checklistTemplateFor({ name: 'Patio', category: 'PATIO', environment: 'OUTDOOR' })).toEqual(
      checklistTemplateFor({ name: 'Patio', environment: 'OUTDOOR' }),
    );
    expect(
      checklistTemplateFor({ name: 'Patio', category: 'PATIO', environment: 'OUTDOOR' }),
    ).toContain('Lawn and garden');
  });

  it('does not assert a room type it has no business asserting', () => {
    // checklistTemplateFor treats a set category as authoritative and only
    // reads the name when it is unspecific. Naming the room type here would
    // bypass the checklist's own room rules instead of helping them, so an
    // ordinary room stays INDOOR_ROOM and the kitchen list still arrives.
    expect(classifyAreaByName('Kitchen').category).toBe('INDOOR_ROOM');
    expect(classifyAreaByName('Master Bedroom').category).toBe('INDOOR_ROOM');
    expect(checklistForExtractedName('Kitchen')).toContain('Stove, hobs and griller');
    expect(checklistForExtractedName('Master Bathroom')).toContain('Toilet and roll holder');
  });

  it('treats anything unrecognised as an ordinary indoor room', () => {
    // The safe default: an indoor list on an outdoor area is visibly wrong to a
    // reviewer, where the reverse quietly drops walls-and-ceilings from a room.
    for (const name of ['Bonus Space', '', 'Room 4']) {
      expect(classifyAreaByName(name).environment, name).toBe('INDOOR');
      expect(classifyAreaByName(name).category, name).toBe('INDOOR_ROOM');
      expect(checklistForExtractedName(name), name).toContain('Walls and ceilings');
    }
  });
});

describe('checklistTemplateFor, against the source report', () => {
  it('gives an entrance its entry closet', () => {
    // This was unreachable: entrance/entry/foyer shared one rule with hall and
    // stair that resolved to HALLWAY, and AreaCategory has no ENTRANCE member,
    // so the ENTRANCE table could not be reached from a name or a category.
    // Every foyer took the bare base list and lost the one item that is its own.
    expect(checklistForExtractedName('Foyer')).toContain('Entry closet');
    expect(checklistForExtractedName('Entrance')).toContain('Entry closet');
    expect(checklistForExtractedName('Entry Hall')).toContain('Entry closet');

    // ...without swallowing the corridors it used to share a rule with.
    expect(checklistForExtractedName('Central Hallway')).not.toContain('Entry closet');
    expect(checklistForExtractedName('Staircase (front)')).not.toContain('Entry closet');
    expect(checklistForExtractedName('Central Hallway')).toEqual([
      'Doors and locks',
      'Walls and ceilings',
      'Floor and coverings',
      'Windows and locks',
      'Lights and power points',
    ]);
  });

  it('reproduces each room type from the 17307 Nordway report', () => {
    // Transcribed from the report's own ROOM/ITEM tables. If someone edits the
    // template tables, this says which room they changed and against what.
    const expected: Record<string, string[]> = {
      Kitchen: [
        'Cupboards, drawers and bench tops',
        'Sink, taps and spouts',
        'Stove, hobs and griller',
        'Refrigerator',
        'Microwave',
        'Dishwasher',
        'Smoke alarms',
      ],
      Bathroom: [
        'Bath, shower and taps',
        'Basin, vanity and mirror',
        'Toilet and roll holder',
        'Heating and exhaust fan',
      ],
      'Bedroom 1': ['Blinds and curtains', 'Built-ins and mirrors', 'Closet', 'Smoke alarms'],
      'Living Room': ['Blinds and curtains', 'Smoke alarms'],
      'Dining Area': ['Blinds and curtains', 'Smoke alarms'],
      Laundry: ['Wash tubs, taps and spouts', 'Washer', 'Dryer'],
    };

    for (const [name, additions] of Object.entries(expected)) {
      expect(checklistForExtractedName(name), name).toEqual([
        'Doors and locks',
        'Walls and ceilings',
        'Floor and coverings',
        'Windows and locks',
        'Lights and power points',
        ...additions,
      ]);
    }
  });

  it('never returns an empty list', () => {
    // An area with no items leaves a technician nothing to cover and no sign
    // that anything is missing.
    for (const name of ['', 'Nook', 'Back Yard', 'Garage']) {
      expect(checklistForExtractedName(name).length, name).toBeGreaterThan(0);
    }
  });
});
