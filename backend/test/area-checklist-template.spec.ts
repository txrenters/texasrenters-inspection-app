import { checklistTemplateFor } from '@texasrenters/shared';

/**
 * The template is the default checklist every area gets, including one a
 * technician adds on site — where nobody has classified it and only the name
 * and environment are known.
 */
describe('area checklist template', () => {
  it('gives every indoor area the base set', () => {
    // Unrecognised is not empty: every room has doors, walls, a floor and
    // lights, and an empty list would leave nothing to cover and no sign that
    // anything was missing.
    expect(checklistTemplateFor({ name: 'Wine cellar', environment: 'INDOOR' })).toEqual([
      'Doors and locks',
      'Walls and ceilings',
      'Floor and coverings',
      'Windows and locks',
      'Lights and power points',
    ]);
  });

  it('adds what the room needs on top of the base', () => {
    const kitchen = checklistTemplateFor({ name: 'Kitchen', environment: 'INDOOR' });
    expect(kitchen.slice(0, 5)).toEqual(
      checklistTemplateFor({ name: 'Wine cellar', environment: 'INDOOR' }),
    );
    expect(kitchen).toContain('Sink, taps and spouts');
    expect(kitchen).toContain('Dishwasher');
  });

  it('replaces the base outdoors rather than extending it', () => {
    // A lawn has no ceiling, and asking a technician to tick one teaches them
    // to tick anything.
    const yard = checklistTemplateFor({ name: 'Back yard', environment: 'OUTDOOR' });
    expect(yard).toContain('Lawn and garden');
    expect(yard).not.toContain('Walls and ceilings');
    expect(yard).not.toContain('Floor and coverings');
  });

  it('walks a porch or balcony like the outside', () => {
    expect(checklistTemplateFor({ name: 'Front porch', environment: 'SEMI_OUTDOOR' })).toContain(
      'Gutters and downpipes',
    );
  });

  it('reads the name when nobody has classified the area', () => {
    // The technician-added case: a typed name and an environment, nothing else.
    expect(checklistTemplateFor({ name: 'Master bath', environment: 'INDOOR' })).toContain(
      'Toilet and roll holder',
    );
    expect(checklistTemplateFor({ name: 'Bedroom 2', environment: 'INDOOR' })).toContain(
      'Built-ins and mirrors',
    );
  });

  it('does not let a bathroom fall through to the bedroom list', () => {
    // "Master bathroom" contains "bath" and "master"; the bedroom rule would
    // also match it, so order decides. This is the one that breaks silently.
    const masterBath = checklistTemplateFor({ name: 'Master bathroom', environment: 'INDOOR' });
    expect(masterBath).toContain('Bath, shower and taps');
    expect(masterBath).not.toContain('Built-ins and mirrors');
  });

  it('prefers an administrator category over the name', () => {
    // Someone classified it; that outranks whatever it happens to be called.
    expect(
      checklistTemplateFor({ name: 'Bedroom store', category: 'GARAGE', environment: 'INDOOR' }),
    ).toContain('Shelving and workbench');
  });

  it('lets the name decide when the category only says "a room"', () => {
    // INDOOR_ROOM says a room, not which kind, so the name still chooses.
    expect(
      checklistTemplateFor({ name: 'Kitchen', category: 'INDOOR_ROOM', environment: 'INDOOR' }),
    ).toContain('Refrigerator');
  });

  it('never returns duplicates', () => {
    for (const name of ['Kitchen', 'Master bathroom', 'Bedroom 1', 'Hallway', 'Garage']) {
      const items = checklistTemplateFor({ name, environment: 'INDOOR' });
      expect(new Set(items).size).toBe(items.length);
    }
  });
});
