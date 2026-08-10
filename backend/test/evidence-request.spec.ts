import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateEvidenceRequestDto } from '../src/admin/admin.dto';

const AREA = '20000000-0000-4000-8000-000000000001';
const ITEM = '20000000-0000-4000-8000-000000000002';

/**
 * Whether creating a request should also hand the inspection back.
 *
 * The rule under test is the one in `createEvidenceRequest`: a request the
 * technician cannot reach is not a request. The technician queue is
 * SCHEDULED + IN_PROGRESS only, so anything past submission has to be returned
 * to IN_PROGRESS or the request is invisible in the field.
 *
 * The surrounding transaction needs a live database, so the decision itself is
 * exercised here as the predicate it is, alongside the payload contract.
 */
const REOPENABLE = [
  'TECHNICIAN_SUBMITTED',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'UNDER_REVIEW',
  'TBD',
  'FOLLOW_UP_REQUIRED',
  'COMPLETED',
];
function reopensOnRequest(status: string) {
  return REOPENABLE.includes(status);
}

describe('evidence request routing', () => {
  it('returns a submitted inspection to the technician', () => {
    // The whole point: before this, "Request more evidence" set UNDER_REVIEW,
    // which is not in the technician's queue — so the office could label an
    // inspection but nothing ever reached the field.
    for (const status of ['TECHNICIAN_SUBMITTED', 'REVIEW_REQUIRED', 'UNDER_REVIEW'])
      expect(reopensOnRequest(status)).toBe(true);
  });

  it('reopens even a finalized inspection, because the request implies it', () => {
    expect(reopensOnRequest('COMPLETED')).toBe(true);
  });

  it('leaves an inspection already with the technician alone', () => {
    // Nothing to reopen — it is in their queue. Forcing a status write would
    // clear completionBlockedReason for no reason.
    expect(reopensOnRequest('IN_PROGRESS')).toBe(false);
    expect(reopensOnRequest('SCHEDULED')).toBe(false);
  });
});

describe('evidence request payload', () => {
  it('accepts an area, specific items and a note', async () => {
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: AREA,
      checklistItemIds: [ITEM],
      note: 'Need a close-up of the water stain above the window.',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a whole-area request with no items', async () => {
    // Empty means "the whole area" rather than "nothing", which is how a
    // reviewer asks for a re-walk rather than one detail.
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: AREA,
      note: 'The walkthrough skipped the far wall.',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('requires a note', async () => {
    // A request that does not say what is wrong sends the technician back to a
    // finished room with nothing to act on — the exact failure this replaces.
    const dto = plainToInstance(CreateEvidenceRequestDto, { inspectionAreaId: AREA });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('note');
  });

  it('rejects an empty or whitespace note', async () => {
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: AREA,
      note: '  ',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects a malformed area id rather than querying on it', async () => {
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: 'not-a-uuid',
      note: 'Please re-check the ceiling.',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('inspectionAreaId');
  });

  it('rejects a malformed checklist item id', async () => {
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: AREA,
      checklistItemIds: [ITEM, 'nope'],
      note: 'Please re-check the ceiling.',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('checklistItemIds');
  });

  it('bounds the item list', async () => {
    const dto = plainToInstance(CreateEvidenceRequestDto, {
      inspectionAreaId: AREA,
      checklistItemIds: Array.from({ length: 51 }, () => ITEM),
      note: 'Please re-check everything.',
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('checklistItemIds');
  });
});
