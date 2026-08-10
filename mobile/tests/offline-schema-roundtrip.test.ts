import {
  findingSchema,
  inspectionPageSchema,
  roomPhotoSchema,
  roomSchema,
} from '../src/repositories/api/repositories';

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

describe('inspectionPageSchema round trip', () => {
  const serverInspection = {
    id: 'insp-1',
    externalInspectionId: 'PW-1',
    propertyId: 'prop-1',
    type: 'MOVE_OUT',
    scheduledAt: '2026-08-01T00:00:00.000Z',
    assignedUserId: 'tech-1',
    status: 'TECHNICIAN_SUBMITTED',
    priority: 'STANDARD',
    roomIds: ['room-1'],
    propertyNotes: '',
    property: {
      id: 'prop-1',
      address: '1 Main St',
      cityStateZip: 'Austin, TX 78701',
      imageTone: 'teal',
    },
    progress: { completed: 1, total: 3, hasFailedUpload: false },
  };
  const serverPage = {
    items: [serverInspection],
    page: 1,
    pageSize: 25,
    total: 312,
    totalPages: 13,
  };

  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip(inspectionPageSchema, serverPage);
    expect(second).toEqual(first);
  });

  it('keeps the server total instead of the page length', () => {
    // The old schema was `z.object({ items })`, so `total` was parsed away and
    // the header counted rows in hand — permanently "25 total".
    const parsed = inspectionPageSchema.parse(serverPage);
    expect(parsed.total).toBe(312);
    expect(parsed.items).toHaveLength(1);
  });

  it('accepts every status the server can send, not the six it used to list', () => {
    // TECHNICIAN_SUBMITTED, UNDER_REVIEW, TBD and FOLLOW_UP_REQUIRED were all
    // missing from the enum while the list is scoped to "not CANCELLED". One
    // submitted inspection therefore failed the parse for the *whole* list —
    // and the "Submitted" chip exists to show exactly those records.
    for (const status of [
      'TECHNICIAN_SUBMITTED',
      'UNDER_REVIEW',
      'TBD',
      'FOLLOW_UP_REQUIRED',
    ]) {
      const page = { ...serverPage, items: [{ ...serverInspection, status }] };
      expect(inspectionPageSchema.parse(page).items[0]!.status).toBe(status);
    }
  });

  it('keeps an unrecognised status rather than dropping the whole page', () => {
    // A status this build has never heard of still describes real work. The
    // presentation layer renders it as "Unknown"; losing the list would be worse.
    const page = { ...serverPage, items: [{ ...serverInspection, status: 'SOME_FUTURE_STATE' }] };
    expect(inspectionPageSchema.parse(page).items[0]!.status).toBe('SOME_FUTURE_STATE');
  });

  it('rejects a page whose envelope has no total rather than caching a broken count', () => {
    const { total: _total, ...withoutTotal } = serverPage;
    expect(() => inspectionPageSchema.parse(withoutTotal)).toThrow();
  });
});

const serverRoom = {
  id: 'room-1',
  inspectionId: 'inspection-1',
  propertyAreaId: 'area-1',
  name: 'Library',
  floorName: 'Ground',
  order: 1,
  isRequired: true,
  inspectionType: 'OCCUPIED',
  baseline: {
    summary: 'No move-in baseline is available.',
    condition: 'NOT_AVAILABLE',
    existingDefects: [],
    evidenceCount: 0,
  },
  completionStatus: 'COMPLETED',
  uploadStatus: 'COMPLETED',
  processingStatus: 'READY_FOR_REVIEW',
  environment: 'INDOOR',
  category: 'INDOOR_ROOM',
  source: 'AI_FLOOR_PLAN',
  areaStatus: 'APPROVED',
  summaryConfirmedAt: '2026-08-11T09:00:00.000Z',
  analysisPending: false,
};

describe('roomSchema round trip', () => {
  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip(roomSchema, serverRoom);
    expect(second).toEqual(first);
  });

  it('keeps the summary confirmation across the trip', () => {
    // The cached copy is what a warm start reads. Losing this field would show
    // a technician a confirmation prompt for a summary they already signed off.
    const { second } = roundTrip(roomSchema, serverRoom);
    expect(second).toMatchObject({ summaryConfirmedAt: '2026-08-11T09:00:00.000Z' });
  });

  it('defaults analysisPending to false when the backend cannot report it', () => {
    // This field gates submission. An older backend that omits it must not be
    // read as "maybe still analyzing", or every submission against it blocks.
    const { analysisPending: _omitted, ...older } = serverRoom;
    const { first, second } = roundTrip(roomSchema, older);
    expect(first).toMatchObject({ analysisPending: false });
    expect(second).toEqual(first);
  });

  it('treats an absent confirmation as unconfirmed rather than failing', () => {
    // Rooms cached before the field existed, and rooms nobody has confirmed,
    // arrive the same way: with the key missing. Both mean "not confirmed".
    const { summaryConfirmedAt: _omitted, ...unconfirmed } = serverRoom;
    const { first, second } = roundTrip(roomSchema, unconfirmed);
    expect((first as { summaryConfirmedAt?: string }).summaryConfirmedAt).toBeUndefined();
    expect(second).toEqual(first);
  });
});
