const mockGetSession = jest.fn();
const mockGetInfoAsync = jest.fn();
const mockUploadAsync = jest.fn();
const mockCreateUploadTask = jest.fn();

jest.mock('../src/config/environment', () => ({
  environment: {
    apiBaseUrl: 'http://localhost:3000/api/v1',
    apiBaseUrls: ['http://localhost:3000/api/v1'],
  },
}));
jest.mock('../src/auth/supabase', () => ({
  getSupabaseClient: () => ({ auth: { getSession: mockGetSession } }),
}));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
  createUploadTask: (...args: unknown[]) => mockCreateUploadTask(...args),
  FileSystemUploadType: { MULTIPART: 'multipart' },
}));

import {
  ApiMediaRepository,
  ApiUploadRepository,
} from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';

const flushQueue = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('live-data room recording upload', () => {
  beforeEach(() => {
    useDemoStore.getState().resetDemoData();
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
    });
    mockGetInfoAsync.mockResolvedValue({ exists: true });
    mockCreateUploadTask.mockReturnValue({ uploadAsync: mockUploadAsync });
    mockUploadAsync.mockResolvedValue({ status: 201, body: '{}' });
  });

  it('saves locally, uploads to the backend, then hands ownership to the server', async () => {
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      propertyAddress: '100 Main St',
      roomName: 'Living room',
      uri: 'file:///documents/inspection-recordings/inspection-live/room-live/video.mp4',
      durationSeconds: 12,
      estimatedSizeMb: 4.2,
      note: 'Window wall documented',
    });
    const upload = await uploadRepository.enqueue(media);
    await flushQueue();

    expect(media.id).toMatch(/^local-media-/);
    expect(upload.id).toMatch(/^local-upload-/);
    expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
    const [url, uri, options] = mockCreateUploadTask.mock.calls[0] as [
      string,
      string,
      { parameters: Record<string, string>; headers: Record<string, string> },
    ];
    expect(url).toBe('http://localhost:3000/api/v1/technician/rooms/room-live/media');
    expect(uri).toBe(media.uri);
    expect(options.parameters.idempotencyKey).toBe(media.id);
    expect(options.parameters.durationSeconds).toBe('12');
    expect(options.headers.authorization).toBe('Bearer test-access-token');
    // Server owns the recording now: the local queue entry and media are gone.
    expect(
      useDemoStore.getState().uploads.filter((item) => item.id.startsWith('local-upload-')),
    ).toHaveLength(0);
    expect(useDemoStore.getState().media.filter((item) => item.id === media.id)).toHaveLength(0);
  });

  it('marks the queue entry FAILED when the backend rejects the upload', async () => {
    mockUploadAsync.mockResolvedValue({
      status: 409,
      body: JSON.stringify({ message: 'Room already has an approved recording.' }),
    });
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      uri: 'file:///video.mp4',
      durationSeconds: 5,
      estimatedSizeMb: 2,
      note: '',
    });
    await uploadRepository.enqueue(media);
    await flushQueue();

    const item = useDemoStore.getState().uploads.find((entry) => entry.mediaId === media.id);
    expect(item?.status).toBe('FAILED');
    expect(item?.lastError).toBe('Room already has an approved recording.');
  });

  it('fails without a network call when the recording file is missing', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: false });
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      uri: 'file:///gone.mp4',
      durationSeconds: 5,
      estimatedSizeMb: 2,
      note: '',
    });
    await uploadRepository.enqueue(media);
    await flushQueue();

    const item = useDemoStore.getState().uploads.find((entry) => entry.mediaId === media.id);
    expect(item?.status).toBe('FAILED');
    expect(mockCreateUploadTask).not.toHaveBeenCalled();
  });

  it('does not create duplicate queue entries for the same saved video', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: false });
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      uri: 'file:///video.mp4',
      durationSeconds: 5,
      estimatedSizeMb: 2,
      note: '',
    });

    const first = await uploadRepository.enqueue(media);
    const second = await uploadRepository.enqueue(media);
    await flushQueue();

    expect(second.id).toBe(first.id);
    expect(
      useDemoStore.getState().uploads.filter((item) => item.mediaId === media.id),
    ).toHaveLength(1);
  });

  it('retries a failed upload when retry is requested', async () => {
    mockUploadAsync.mockResolvedValueOnce({ status: 502, body: '' });
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      uri: 'file:///video.mp4',
      durationSeconds: 5,
      estimatedSizeMb: 2,
      note: '',
    });
    const upload = await uploadRepository.enqueue(media);
    await flushQueue();
    expect(
      useDemoStore.getState().uploads.find((item) => item.id === upload.id)?.status,
    ).toBe('FAILED');

    await uploadRepository.retry(upload.id);
    await flushQueue();

    expect(mockCreateUploadTask).toHaveBeenCalledTimes(2);
    expect(
      useDemoStore.getState().uploads.filter((item) => item.id.startsWith('local-upload-')),
    ).toHaveLength(0);
  });
});
