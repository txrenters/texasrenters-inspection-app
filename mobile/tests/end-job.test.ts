import { planEndJob } from '../src/utils/end-job';
import type { JobTask } from '../src/utils/job-tasks';

/**
 * End job is the submission (the office, 2026-09-18): the job screen is a list
 * with End job under it, and End job settles what the review screen used to.
 */

const task = (over: Partial<JobTask> & Pick<JobTask, 'key' | 'kind'>): JobTask => ({
  number: null,
  title: over.key === 'inspection' ? 'Occupied inspection' : over.key === 'filterChange' ? 'Filter change' : 'Pest control',
  state: 'DONE',
  detail: null,
  ...over,
});

const ready = { canSubmit: true, incompleteRequiredRooms: [] };

describe('what End job settles first', () => {
  it('submits straight away when everything is done', () => {
    const plan = planEndJob(
      [
        task({ key: 'filterChange', kind: 'FILTERS', state: 'DONE' }),
        task({ key: 'pestControl', kind: 'SERVICE', state: 'DONE' }),
        task({ key: 'inspection', kind: 'INSPECTION', state: 'DONE' }),
      ],
      ready,
    );

    expect(plan).toEqual({ blockers: [], unticked: [] });
  });

  it('sends the technician back to the areas still required, naming them', () => {
    const plan = planEndJob([task({ key: 'inspection', kind: 'INSPECTION', state: 'PART' })], {
      canSubmit: false,
      incompleteRequiredRooms: [
        { id: 'a', name: 'Kitchen', isRequired: true, completionStatus: 'IN_PROGRESS' },
        { id: 'b', name: 'Bedroom 2', isRequired: true, completionStatus: 'NOT_STARTED' },
      ],
    });

    expect(plan.blockers).toEqual([
      {
        opens: 'INSPECTION',
        title: 'Finish the occupied inspection first',
        message: '2 required areas are not finished: Kitchen, Bedroom 2.',
      },
    ]);
  });

  /**
   * Moses, 2026-10-12: every room of a move-out submitted, the last three
   * videos still on the phone, and End job refused by the server with "Complete
   * or provide an authorized skip reason" -- the phone had said 15 of 15.
   */
  it('says a submitted area whose video is still sending is sending, not unfinished', () => {
    const inspection = task({ key: 'inspection', kind: 'INSPECTION', state: 'PART', title: 'Move-out inspection' });
    const sending = (id: string, name: string, uploadStatus: string) => ({
      id,
      name,
      isRequired: true,
      completionStatus: 'RECORDING_SAVED',
      uploadStatus,
    });

    const onlySending = planEndJob([inspection], {
      canSubmit: false,
      incompleteRequiredRooms: [sending('a', 'Bedroom 1', 'UPLOADING'), sending('b', 'Bathroom 1', 'PENDING')],
    });
    expect(onlySending.blockers).toEqual([
      {
        opens: 'INSPECTION',
        title: 'Videos are still sending',
        message:
          'Bedroom 1, Bathroom 1 are still sending from this phone. Keep the app open with signal; End job works once they have arrived.',
      },
    ]);

    // A video that failed is work for the technician again, not a wait.
    const mixed = planEndJob([inspection], {
      canSubmit: false,
      incompleteRequiredRooms: [
        sending('a', 'Bedroom 1', 'UPLOADING'),
        { id: 'c', name: 'Kitchen', isRequired: true, completionStatus: 'RECORDING_SAVED', uploadStatus: 'FAILED' },
      ],
    });
    expect(mixed.blockers[0]).toEqual({
      opens: 'INSPECTION',
      title: 'Finish the move-out inspection first',
      message: '1 required area is not finished: Kitchen. Still sending their video: Bedroom 1.',
    });
  });

  it('sends the technician back to filters not yet photographed or answered', () => {
    const plan = planEndJob([task({ key: 'filterChange', kind: 'FILTERS', state: 'PART', detail: '1 of 2 answered' })], ready);

    expect(plan.blockers.map((blocker) => [blocker.opens, blocker.message])).toEqual([
      ['FILTERS', '1 of 2 answered. Stack the filters and take one photo of them all, or say why one was not changed.'],
    ]);
  });

  it('counts a filter change answered not done as settled', () => {
    expect(planEndJob([task({ key: 'filterChange', kind: 'FILTERS', state: 'NOT_DONE' })], ready).blockers).toEqual([]);
  });

  /** The office (2026-09-29): an unticked service is never a reason to stop. */
  it('never blocks on a service left unticked, and hands it on to be sent as not done', () => {
    const pest = task({ key: 'pestControl', kind: 'SERVICE', state: 'TODO' });
    const plan = planEndJob([pest, task({ key: 'fleaTreatment', kind: 'SERVICE', state: 'NOT_DONE' })], ready);

    expect(plan).toEqual({ blockers: [], unticked: [pest] });
  });
});
