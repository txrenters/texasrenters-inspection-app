import {
  checklistSchema,
  evidenceRequestSchema,
  roomSchema,
} from '../src/repositories/api/repositories';

/**
 * The wire contract for a scored checklist item.
 *
 * These are cached and re-parsed from their own stored output, so the shape has
 * to survive the round trip — and the tri-state has to survive it *as* a
 * tri-state. A null that came back as false would turn "nobody checked" into
 * "found faulty" in the printed report.
 */
function roundTrip(input: unknown) {
  const first = checklistSchema.parse(input);
  const stored = JSON.parse(JSON.stringify(first));
  return { first, second: checklistSchema.parse(stored) };
}

const serverItem = {
  id: 'item-1',
  label: 'Doors and locks',
  keywords: ['door', 'lock'],
  isClean: false,
  isUndamaged: false,
  isWorking: true,
  comment: 'scratches on door need to be painted',
  recordedAt: '2026-08-11T09:00:00.000Z',
};

describe('checklist assessment contract', () => {
  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip([serverItem]);
    expect(second).toEqual(first);
  });

  it('keeps a false apart from a null across the trip', () => {
    // The distinction the whole feature rests on: false is "found faulty",
    // null is "nobody assessed it". JSON preserves both, and so must the schema.
    const { second } = roundTrip([
      { ...serverItem, isClean: false, isUndamaged: null, isWorking: true },
    ]);
    expect(second[0]).toMatchObject({ isClean: false, isUndamaged: null, isWorking: true });
  });

  it('reads an item from a backend that cannot score as unassessed', () => {
    // The pre-assessment shape: id, label, keywords and nothing else. It must
    // parse — and must not imply the item was found faulty.
    const { first, second } = roundTrip([{ id: 'item-1', label: 'Doors and locks', keywords: [] }]);
    expect(first[0]).toMatchObject({
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      comment: null,
      recordedAt: null,
    });
    expect(second).toEqual(first);
  });

  it('rejects a non-boolean axis rather than coercing it', () => {
    // "false" as a string is truthy. Coercing here would record a defect the
    // technician never reported.
    expect(() => checklistSchema.parse([{ ...serverItem, isClean: 'false' }])).toThrow();
  });

  it('keeps an empty keyword list rather than dropping the item', () => {
    const parsed = checklistSchema.parse([{ id: 'a', label: 'Smoke alarms' }]);
    expect(parsed[0]).toMatchObject({ label: 'Smoke alarms', keywords: [] });
  });
});

describe('evidence request contract', () => {
  it('reads a targeted request', () => {
    const [request] = evidenceRequestSchema.parse([
      {
        id: 'req-1',
        roomId: 'area-1',
        roomName: 'Library',
        note: 'Need a close-up of the water stain.',
        requestedAt: '2026-08-11T09:00:00.000Z',
        items: ['Walls and ceilings'],
      },
    ]);
    expect(request!).toMatchObject({ roomName: 'Library', items: ['Walls and ceilings'] });
  });

  it('treats an absent item list as a whole-area request', () => {
    // Empty means "re-walk the area" rather than "nothing was asked for", and
    // the card words those two cases differently.
    const [request] = evidenceRequestSchema.parse([
      {
        id: 'req-1',
        roomId: 'area-1',
        roomName: 'Library',
        note: 'The walkthrough skipped the far wall.',
        requestedAt: '2026-08-11T09:00:00.000Z',
      },
    ]);
    expect(request!.items).toEqual([]);
  });

  it('rejects a request with no note rather than showing a blank instruction', () => {
    expect(() =>
      evidenceRequestSchema.parse([
        { id: 'req-1', roomId: 'a', roomName: 'Library', requestedAt: '2026-08-11T09:00:00.000Z' },
      ]),
    ).toThrow();
  });
});

/**
 * A room from a visit that has no baseline.
 *
 * The server omits the whole `baseline` block for an HVAC inspection on
 * purpose — that visit sits outside the MOVE_IN -> OCCUPIED -> BACK_TO_MARKET
 * -> MOVE_OUT chain and has nothing to compare against. Absent is a different
 * statement from a baseline whose condition is NOT_AVAILABLE, which is why it
 * is omitted rather than sent empty.
 *
 * The schema still required it, and a zod object rejects the *whole* room when
 * one field fails, so the technician's entire area list failed to parse and the
 * app showed a query error instead of the job.
 */
describe('room contract', () => {
  const room = {
    id: 'area-1',
    inspectionId: 'insp-1',
    propertyAreaId: 'pa-1',
    name: 'Hall',
    floorName: '2nd floor',
    order: 1,
    isRequired: true,
    completionStatus: 'NOT_STARTED',
    uploadStatus: 'PENDING',
    processingStatus: 'NOT_STARTED',
    note: null,
    skipReason: null,
  };

  it('reads an HVAC room that carries no baseline', () => {
    const parsed = roomSchema.parse({ ...room, inspectionType: 'HVAC' });
    expect(parsed.baseline).toBeUndefined();
    expect(parsed.name).toBe('Hall');
  });

  /**
   * The failure this schema keeps having. A closed enum here rejects the
   * *whole* room, so the office adding a kind of visit costs every technician
   * their area list — for a change that has nothing to do with them. The
   * screens label the types they know and fall back for the rest.
   */
  it('reads a room from a kind of visit it has never heard of', () => {
    for (const inspectionType of [
      'ROOF',
      'SUPRA_LOCKBOX_PLACEMENT',
      'SUPRA_LOCKBOX_REMOVAL',
      'AC_FILTER_DELIVERY',
      'SOMETHING_ADDED_NEXT_YEAR',
    ]) {
      const parsed = roomSchema.parse({ ...room, inspectionType });
      expect(parsed.inspectionType).toBe(inspectionType);
      expect(parsed.name).toBe('Hall');
    }
  });

  it('still reads the baseline when the visit has one', () => {
    const parsed = roomSchema.parse({
      ...room,
      inspectionType: 'MOVE_OUT',
      baseline: {
        summary: 'Clean at move-in.',
        condition: 'DOCUMENTED',
        existingDefects: ['Scuffed skirting'],
        evidenceCount: 2,
      },
    });
    expect(parsed.baseline).toMatchObject({ condition: 'DOCUMENTED', evidenceCount: 2 });
  });

  it('rejects a baseline that is present but malformed', () => {
    // Optional means "may be absent", not "may be anything".
    expect(() =>
      roomSchema.parse({
        ...room,
        inspectionType: 'MOVE_OUT',
        baseline: { summary: 'Clean at move-in.', condition: 'UNKNOWN' },
      }),
    ).toThrow();
  });
});
