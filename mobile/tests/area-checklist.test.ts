import {
  checklistForArea,
  checklistProgress,
  matchChecklistMentions,
  resolveAreaChecklist,
  type ChecklistItem,
} from '../src/capture/area-checklist';

describe('resolveAreaChecklist', () => {
  const AUTHORED = [
    { id: 'e9c1', label: 'Sink', keywords: ['sink'] },
    { id: 'a72f', label: 'Counter top', keywords: ['counter', 'top'] },
  ];

  it('shows what the administrator wrote, not a generated stand-in', () => {
    // The area screen used to generate its own list while the camera fetched
    // the authored one, so the two screens disagreed about the same room — and
    // the auto-tick recorded coverage against items nobody was ever shown.
    const items = resolveAreaChecklist(AUTHORED, { name: 'Kitchen' });
    expect(items.map((item) => item.label)).toEqual(['Sink', 'Counter top']);
    expect(items.map((item) => item.id)).toEqual(['e9c1', 'a72f']);
  });

  it('falls back to the generated list only when nothing is authored', () => {
    // An unconfigured area still guides the technician rather than showing an
    // empty sheet, and an empty array means unconfigured just as undefined does.
    for (const authored of [undefined, []]) {
      const items = resolveAreaChecklist(authored, { name: 'Kitchen' });
      expect(items).toEqual(checklistForArea({ name: 'Kitchen' }));
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it('keeps the authored list whatever the area is called', () => {
    // The generated list is chosen by room name. An authored list must not be
    // second-guessed by it — an administrator naming an area "Kitchen" and
    // listing three things gets those three things.
    expect(resolveAreaChecklist(AUTHORED, { name: 'Patio (right)' })).toHaveLength(2);
    expect(resolveAreaChecklist(AUTHORED, { name: 'Kitchen' })).toHaveLength(2);
  });
});

describe('checklistForArea', () => {
  it('picks the list that matches the room', () => {
    expect(checklistForArea({ name: 'Kitchen' }).map((item) => item.id)).toContain('appliances');
    expect(checklistForArea({ name: 'Main Bathroom' }).map((item) => item.id)).toContain('toilet');
    expect(checklistForArea({ name: 'Bedroom 2' }).map((item) => item.id)).toContain('storage');
  });

  it('does not read an en-suite as a bedroom', () => {
    // "Master Bedroom Ensuite" contains "bed"; the bathroom rule has to win or
    // the technician gets asked about wardrobes in a shower room.
    const items = checklistForArea({ name: 'Master Bedroom Ensuite' }).map((item) => item.id);
    expect(items).toContain('shower');
    expect(items).not.toContain('storage');
  });

  it('lets an outdoor classification override the name', () => {
    // The floor plan knows this is outside even though it is called a room.
    const items = checklistForArea({ name: 'Garden Room', environment: 'OUTDOOR' }).map(
      (item) => item.id,
    );
    expect(items).toContain('boundary');
  });

  it('falls back to a general list for an unrecognised area', () => {
    const items = checklistForArea({ name: 'Landing' }).map((item) => item.id);
    expect(items).toEqual(expect.arrayContaining(['walls', 'flooring', 'doors']));
  });

  it('never returns an empty checklist', () => {
    for (const name of ['', 'Nook', 'Zone 7', 'Cupboard under stairs']) {
      expect(checklistForArea({ name }).length).toBeGreaterThan(0);
    }
  });
});

describe('matchChecklistMentions', () => {
  const items: ChecklistItem[] = [
    { id: 'sink', label: 'Sink', keywords: ['sink', 'tap'] },
    { id: 'floor', label: 'Floor', keywords: ['floor', 'carpet'] },
    { id: 'drain', label: 'Drainage', keywords: ['drain'] },
  ];

  it('matches an item the technician mentions in passing', () => {
    expect(matchChecklistMentions(items, 'the sink looks fine here')).toEqual(['sink']);
  });

  it('matches more than one item in a single sentence', () => {
    expect(matchChecklistMentions(items, 'checking the tap and the carpet')).toEqual([
      'sink',
      'floor',
    ]);
  });

  it('matches a plural', () => {
    expect(matchChecklistMentions(items, 'both taps are working')).toEqual(['sink']);
  });

  it('does not fire on a word that merely contains the keyword', () => {
    // The reason matching is word-bounded rather than a substring check:
    // "draining board" is not a statement about drainage, and "tape" is not a tap.
    expect(matchChecklistMentions(items, 'there is tape on the draining board')).toEqual([]);
  });

  it('ignores punctuation and casing', () => {
    expect(matchChecklistMentions(items, 'The SINK, honestly, is fine.')).toEqual(['sink']);
  });

  it('returns nothing for silence or noise', () => {
    expect(matchChecklistMentions(items, '')).toEqual([]);
    expect(matchChecklistMentions(items, '   ...   ')).toEqual([]);
  });
});

describe('checklistProgress', () => {
  const items: ChecklistItem[] = [
    { id: 'a', label: 'A', keywords: [] },
    { id: 'b', label: 'B', keywords: [] },
  ];

  it('counts covered items', () => {
    expect(checklistProgress(items, ['a'])).toEqual({ covered: 1, total: 2 });
  });

  it('ignores saved ids that are no longer on the list', () => {
    // Checklists are generated from the area name, so renaming an area can
    // change the list under saved state. Reporting "3 of 2" would be worse
    // than forgetting a tick.
    expect(checklistProgress(items, ['a', 'removed-item'])).toEqual({ covered: 1, total: 2 });
  });

  it('does not double-count a repeated id', () => {
    expect(checklistProgress(items, ['a', 'a'])).toEqual({ covered: 1, total: 2 });
  });
});
