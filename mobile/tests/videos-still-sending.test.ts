import { videosStillSendingCount } from '../src/media/videos-still-sending';

/**
 * A job's videos still going from this phone (2026-11-14): shown on its row,
 * after End job too, until they land. Everything invented.
 */
describe('a job\'s videos still sending', () => {
  const upload = (over: Record<string, unknown>) => ({
    id: 'local-upload-1',
    inspectionId: 'job-1',
    status: 'PENDING' as const,
    ownerUserId: 'tech-1',
    ...over,
  });

  it('counts this technician\'s waiting, going and held videos of the job', () => {
    const uploads = [
      upload({ id: 'local-upload-1', status: 'PENDING' }),
      upload({ id: 'local-upload-2', status: 'UPLOADING' }),
      upload({ id: 'local-upload-3', status: 'PAUSED' }),
    ];
    expect(videosStillSendingCount(uploads as never, 'job-1', 'tech-1')).toBe(3);
  });

  it('leaves out one sent or failed, another job\'s, another technician\'s, and the server\'s own copies', () => {
    const uploads = [
      upload({ id: 'local-upload-1', status: 'COMPLETED' }),
      upload({ id: 'local-upload-2', status: 'FAILED' }),
      upload({ id: 'local-upload-3', inspectionId: 'job-2' }),
      upload({ id: 'local-upload-4', ownerUserId: 'tech-2' }),
      upload({ id: 'server-upload-5' }),
    ];
    expect(videosStillSendingCount(uploads as never, 'job-1', 'tech-1')).toBe(0);
  });
});
