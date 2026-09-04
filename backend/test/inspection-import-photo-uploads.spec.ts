import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';

/**
 * Storing a report's photographs.
 *
 * A report carries a few hundred — 271 in one recent import, 376 in another —
 * and each one is a separate round trip to object storage. Uploaded one at a
 * time, almost the whole import was spent waiting on the network, which is what
 * made an import something that had to be watched rather than started.
 *
 * The risk in uploading several at once is not the uploading. It is that the
 * commit walks areas in order and reads the result positionally through a
 * running cursor, so if the returned array is ordered by *completion* every
 * photograph is filed against the wrong room — silently, with no error
 * anywhere. That is what most of this pins down.
 */

const ORGANIZATION = '00000000-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);

const photo = (index: number) => ({
  // Distinct bytes per photograph, so the content digest in the key differs and
  // a mixed-up ordering cannot accidentally look correct.
  bytes: Buffer.from([0xff, 0xd8, index & 0xff, 0xd9]),
  width: 100 + index,
  height: 200 + index,
});

/**
 * A storage double that records call order and can be told how long each
 * upload takes.
 */
function storageDouble(delayFor: (key: string) => number = () => 0) {
  let inFlight = 0;
  const peak = { value: 0 };
  const started: string[] = [];
  const finished: string[] = [];
  const storage = {
    putBytes: jest.fn(async (storageKey: string) => {
      started.push(storageKey);
      inFlight += 1;
      peak.value = Math.max(peak.value, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayFor(storageKey)));
      inFlight -= 1;
      finished.push(storageKey);
    }),
  };
  return { storage, peak, started, finished };
}

const serviceWith = (storage: unknown) =>
  new InspectionImportService({} as never, storage as never, { read: jest.fn() } as never);

/** `storePhotos` is private; these tests are about exactly that behaviour. */
const storePhotos = (service: InspectionImportService, photos: unknown[]) =>
  (
    service as unknown as {
      storePhotos: (
        organizationId: string,
        fingerprint: string,
        photos: unknown[],
      ) => Promise<Array<{ storageKey: string; width: number; height: number; sizeBytes: number }>>;
    }
  ).storePhotos(ORGANIZATION, FINGERPRINT, photos);

describe('storing a report’s photographs', () => {
  it('returns them in source order even when the uploads finish backwards', async () => {
    // The failure this exists for. Later photographs are made to finish first,
    // which is what appending-on-completion would order the result by.
    const photos = Array.from({ length: 12 }, (_, index) => photo(index));
    const { storage, finished } = storageDouble((key) => {
      const index = Number(key.split('/').pop()!.slice(0, 4));
      return (12 - index) * 2;
    });

    const stored = await storePhotos(serviceWith(storage), photos);

    expect(stored).toHaveLength(12);
    // Completion order really was not source order, so the assertion below is
    // testing something rather than passing by accident.
    expect(finished).not.toEqual([...finished].sort());
    stored.forEach((entry, index) => {
      expect(entry.width).toBe(100 + index);
      expect(entry.height).toBe(200 + index);
      expect(entry.storageKey).toContain(`/${String(index).padStart(4, '0')}-`);
    });
  });

  it('uploads every photograph exactly once', async () => {
    const photos = Array.from({ length: 25 }, (_, index) => photo(index));
    const { storage, started } = storageDouble();

    const stored = await storePhotos(serviceWith(storage), photos);

    expect(storage.putBytes).toHaveBeenCalledTimes(25);
    expect(new Set(started).size).toBe(25);
    expect(stored.every((entry) => entry?.storageKey)).toBe(true);
  });

  it('keeps a bounded number in flight rather than opening one per photograph', async () => {
    // Several hundred simultaneous uploads would trade a slow import for an
    // exhausted socket pool and storage rate limits.
    const photos = Array.from({ length: 60 }, (_, index) => photo(index));
    const { storage, peak } = storageDouble(() => 1);

    await storePhotos(serviceWith(storage), photos);

    expect(peak.value).toBeGreaterThan(1);
    expect(peak.value).toBeLessThanOrEqual(8);
  });

  it('does not start more workers than there are photographs', async () => {
    const { storage, peak } = storageDouble(() => 1);
    await storePhotos(serviceWith(storage), [photo(0), photo(1)]);
    expect(peak.value).toBeLessThanOrEqual(2);
  });

  it('fails the import when a photograph cannot be stored', async () => {
    // A report whose evidence is incomplete must not commit. The job records
    // the failure; swallowing it would file an inspection with a hole in it.
    const storage = {
      putBytes: jest.fn(async (storageKey: string) => {
        if (storageKey.includes('/0003-')) throw new Error('R2 refused the object');
      }),
    };

    await expect(
      storePhotos(serviceWith(storage), Array.from({ length: 10 }, (_, i) => photo(i))),
    ).rejects.toThrow('R2 refused the object');
  });

  it('handles a report with no photographs at all', async () => {
    const { storage } = storageDouble();
    await expect(storePhotos(serviceWith(storage), [])).resolves.toEqual([]);
    expect(storage.putBytes).not.toHaveBeenCalled();
  });

  it('keys each object by its content, so a re-run overwrites rather than duplicates', async () => {
    const { storage } = storageDouble();
    const photos = [photo(0), photo(1)];

    const first = await storePhotos(serviceWith(storage), photos);
    const second = await storePhotos(serviceWith(storage), photos);

    expect(first.map((entry) => entry.storageKey)).toEqual(
      second.map((entry) => entry.storageKey),
    );
  });
});
