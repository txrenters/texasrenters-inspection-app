import { filterRows, filtersPhoto, withFiltersPhoto, withoutPhoto, withServicePhoto } from '../src/utils/job-tasks';

/**
 * A filter's photograph discarded in the camera's review window.
 *
 * It is written into the checklist the moment the shutter fires. Discarding it
 * deleted the image and left the answers pointing at it: the job submitted as
 * photographed and read "Photograph still uploading" in the console for ever
 * (5706 Micah Ln, 2026-10-02).
 */

const DETAILS = 'Filter Change: 12x24x1;16x25x1;16x25x1 + Pest Control + HVAC Inspection';

describe('discarding the filters’ photograph', () => {
  it('takes it out of every register it was written into, which then ask for one again', () => {
    const taken = withFiltersPhoto(null, DETAILS, 'snapshot-1');
    expect(filtersPhoto(filterRows(DETAILS, taken))).toEqual({ photoKey: 'snapshot-1', photoId: null });

    const discarded = withoutPhoto(taken, 'snapshot-1');

    expect(filtersPhoto(filterRows(DETAILS, discarded))).toBeNull();
    // Still changed: the technician did change them; only the picture went.
    expect(discarded.filters?.every((filter) => filter.changed && filter.photoKey === null)).toBe(true);
  });

  it('leaves a photograph that has already arrived, and any other photograph, alone', () => {
    const arrived = {
      ...withFiltersPhoto(null, DETAILS, 'snapshot-1'),
    };
    arrived.filters = arrived.filters!.map((filter) => ({ ...filter, photoId: 'photo-1' }));
    expect(withoutPhoto(arrived, 'snapshot-1').filters?.every((filter) => filter.photoKey === 'snapshot-1')).toBe(
      true,
    );

    const pest = withServicePhoto(withFiltersPhoto(null, DETAILS, 'snapshot-1'), 'pestControl', 'snapshot-2');
    const afterPest = withoutPhoto(pest, 'snapshot-2');
    expect(afterPest.services.pestControl).toMatchObject({ done: true, photoKey: null });
    expect(afterPest.filters?.every((filter) => filter.photoKey === 'snapshot-1')).toBe(true);
  });
});
