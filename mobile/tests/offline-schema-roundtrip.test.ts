import { findingSchema, roomPhotoSchema } from '../src/repositories/api/repositories';

/**
 * `cachedApiRecord` stores the *parsed* value and re-parses it with the same
 * schema when serving from cache. Any schema whose output shape differs from
 * its input shape must therefore survive a round trip, or the cached copy is
 * silently discarded the first time a technician goes offline — the exact
 * moment the cache is supposed to help.
 */
function roundTrip<T extends { parse: (value: unknown) => unknown }>(schema: T, input: unknown) {
  const first = schema.parse(input);
  // JSON is what actually reaches storage; `undefined` keys vanish here.
  const stored = JSON.parse(JSON.stringify(first));
  return { first, second: schema.parse(stored) };
}

const serverPhoto = {
  id: 'photo-1',
  roomId: 'room-1',
  findingId: null,
  captureType: 'AREA_OVERVIEW',
  sequenceNumber: 1,
  label: null,
  capturedAt: '2026-07-31T10:00:00.000Z',
  contentPath: '/api/v1/technician/photos/photo-1/content',
};

describe('roomPhotoSchema round trip', () => {
  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip(roomPhotoSchema, serverPhoto);
    expect(second).toEqual(first);
  });

  it('survives absent optional fields, which JSON drops entirely', () => {
    const { id, roomId, captureType, capturedAt, contentPath } = serverPhoto;
    const sparse = { id, roomId, captureType, capturedAt, contentPath };
    const { first, second } = roundTrip(roomPhotoSchema, sparse);
    expect(second).toEqual(first);
    // Normalised to null rather than left undefined, so the cached JSON keeps
    // the keys and the second parse sees the same shape as the first.
    expect(first).toMatchObject({ findingId: null, sequenceNumber: null, label: null });
  });

  it('keeps an unrecognised capture type instead of rejecting the photo', () => {
    // A photo the app cannot classify is still evidence, and must still count.
    const parsed = roomPhotoSchema.parse({ ...serverPhoto, captureType: 'SOMETHING_NEW' });
    expect(parsed.captureType).toBe('SOMETHING_NEW');
  });

  it('rejects a photo missing its identity rather than caching a broken row', () => {
    expect(() => roomPhotoSchema.parse({ ...serverPhoto, id: undefined })).toThrow();
  });
});

describe('findingSchema round trip', () => {
  const serverFinding = {
    id: 'finding-1',
    inspectionId: 'insp-1',
    roomId: 'room-1',
    roomName: 'Kitchen',
    title: 'Scuffed baseboard',
    category: 'Surfaces',
    severity: 'LOW',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.82,
    videoTimestampStart: 84,
    videoTimestampEnd: 91,
    baselineCondition: 'No damage recorded at move-in.',
    observation: 'A scuff runs along the baseboard.',
    aiSummary: 'A scuff runs along the baseboard.',
    recommendedReview: 'Confirm against the move-in photos.',
    reviewStatus: 'PENDING_REVIEW',
  };

  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip(findingSchema, serverFinding);
    expect(second).toEqual(first);
  });

  it('survives an absent reviewerNotes', () => {
    const { first, second } = roundTrip(findingSchema, serverFinding);
    expect(second).toEqual(first);
    expect((first as { reviewerNotes?: string }).reviewerNotes).toBeUndefined();
  });

  it('rejects an unknown comparison result rather than caching it', () => {
    // These drive tone and wording on the finding screen; an unmapped value
    // would render as a blank label in front of a resident.
    expect(() =>
      findingSchema.parse({ ...serverFinding, comparisonResult: 'MADE_UP' }),
    ).toThrow();
  });
});
