import { reportRoomStatus } from '../src/admin/report-room-status';

/**
 * A walked room whose video is still on its way, or never came (2026-11-14),
 * printed as such in the reports rather than "Not inspected". Everything
 * invented.
 */
describe('a room in the report while its video is away', () => {
  const video = (over: Record<string, unknown> = {}) => ({
    uploadStatus: 'SESSION_CREATED',
    readyAt: null,
    processingStatus: 'PENDING',
    failureCode: null,
    ...over,
  });

  it('says its video is still arriving, or never arrived', () => {
    expect(reportRoomStatus('RECORDED', [video()])).toBe('VIDEO_ARRIVING');
    expect(reportRoomStatus('RECORDED', [video({ processingStatus: 'FAILED', failureCode: 'VIDEO_NEVER_ARRIVED' })])).toBe(
      'VIDEO_NEVER_ARRIVED',
    );
  });

  it('leaves the room as it is once a video is here, or when it was completed or skipped', () => {
    expect(reportRoomStatus('RECORDED', [video({ uploadStatus: 'UPLOADED' }), video()])).toBe('RECORDED');
    expect(reportRoomStatus('COMPLETED', [video()])).toBe('COMPLETED');
    expect(reportRoomStatus('SKIPPED', [video()])).toBe('SKIPPED');
    expect(reportRoomStatus('PENDING', [])).toBe('PENDING');
    expect(reportRoomStatus('PENDING')).toBe('PENDING');
  });
});
