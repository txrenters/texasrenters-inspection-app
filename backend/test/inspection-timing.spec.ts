import { inspectionEvidenceTimes, inspectionSpan } from '../src/admin/inspection-timing';

/**
 * How long the inspection itself took, beside the whole-job clock (the office,
 * 2026-09-18). Read from the evidence: the first photograph or recording in
 * the job's own areas to the last.
 */

const at = (time: string) => new Date(`2026-09-18T${time}:00.000Z`);

const photo = (device: string | null, server = '23:59') => ({
  deviceCapturedAt: device ? at(device) : null,
  capturedAt: at(server),
});

describe('the inspection’s own span', () => {
  it('runs from the first photograph to the end of the last recording', () => {
    const span = inspectionSpan({
      photos: [photo('14:20'), photo('14:31')],
      recordings: [{ recordedAt: at('14:40'), createdAt: at('15:30'), durationSeconds: 5 * 60 }],
    });

    expect(span).toEqual({ from: at('14:20'), to: at('14:45'), clock: 'DEVICE' });
  });

  it('measures the same length on a phone whose clock is wrong', () => {
    // A difference between two readings of one clock: an offset cancels out.
    const right = inspectionSpan({ photos: [photo('14:20'), photo('14:58')], recordings: [] })!;
    const fiveMinutesFast = inspectionSpan({ photos: [photo('14:25'), photo('15:03')], recordings: [] })!;

    expect(fiveMinutesFast.to.getTime() - fiveMinutesFast.from.getTime()).toBe(
      right.to.getTime() - right.from.getTime(),
    );
  });

  it('never mixes the phone’s times with the server’s', () => {
    // The server's receipt of a photograph queued in a basement can be an hour
    // after it was taken; mixing it in would stretch the span by that hour.
    const span = inspectionSpan({
      photos: [photo('14:20', '15:40'), photo('14:30', '15:41'), photo(null, '16:10')],
      recordings: [],
    });

    expect(span).toEqual({ from: at('14:20'), to: at('14:30'), clock: 'DEVICE' });
  });

  it('falls back to the server’s times when the phone gave none', () => {
    const span = inspectionSpan({ photos: [photo(null, '14:20'), photo(null, '14:50')], recordings: [] });

    expect(span).toEqual({ from: at('14:20'), to: at('14:50'), clock: 'SERVER' });
  });

  it('is nothing for one photograph, which is a moment rather than a length', () => {
    expect(inspectionSpan({ photos: [photo('14:20')], recordings: [] })).toBeNull();
    expect(inspectionSpan({ photos: [], recordings: [] })).toBeNull();
  });
});

describe('the evidence it is read from', () => {
  it('leaves out the areas the job’s services are photographed in', async () => {
    const prisma = {
      inspectionPhoto: { findMany: jest.fn().mockResolvedValue([]) },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
    };

    await inspectionEvidenceTimes(prisma as never, 'org-1', 'job-1');

    for (const delegate of [prisma.inspectionPhoto, prisma.inspectionMedia])
      expect(delegate.findMany.mock.calls[0]![0].where).toEqual({
        organizationId: 'org-1',
        inspectionId: 'job-1',
        // The job's other tasks, not rooms.
        inspectionArea: {
          propertyArea: { name: { notIn: ['AC filters', 'Pest control', 'Flea treatment'] } },
        },
      });
  });
});
