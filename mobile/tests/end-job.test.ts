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

  it('sends the technician back to filters not yet photographed or answered', () => {
    const plan = planEndJob([task({ key: 'filterChange', kind: 'FILTERS', state: 'PART', detail: '1 of 2 answered' })], ready);

    expect(plan.blockers.map((blocker) => [blocker.opens, blocker.message])).toEqual([
      ['FILTERS', '1 of 2 answered. Photograph each filter with its size in shot, or say why it was not changed.'],
    ]);
  });

  it('counts a filter change answered not done as settled', () => {
    expect(planEndJob([task({ key: 'filterChange', kind: 'FILTERS', state: 'NOT_DONE' })], ready).blockers).toEqual([]);
  });

  /** The owner's choice (2026-09-18): "Ask why, then submit". */
  it('asks why about a service left unticked rather than refusing to end the job', () => {
    const pest = task({ key: 'pestControl', kind: 'SERVICE', state: 'TODO' });
    const plan = planEndJob([pest, task({ key: 'fleaTreatment', kind: 'SERVICE', state: 'NOT_DONE' })], ready);

    expect(plan).toEqual({ blockers: [], unticked: [pest] });
  });
});
