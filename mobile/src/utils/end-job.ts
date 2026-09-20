import type { JobTask } from './job-tasks';
import type { SubmissionGate } from './submission-gate';

/**
 * What End job has to settle before it can submit (the office, 2026-09-18).
 *
 * The job screen is a list -- pest control ticked in place, the filter change
 * and the inspection opened -- with End job under it, and End job is the
 * submission: there is no separate review screen to walk through first. So it
 * answers here what the review screen used to hold back on:
 *
 * - **Work still to do.** An inspection with a required area unfinished, or a
 *   filter change with a register not yet photographed, is something only the
 *   technician can finish, so End job names it and opens it rather than
 *   submitting around it.
 * - **A service left unticked.** Pest control not ticked means it was not done,
 *   and the office's rule wants the reason (the owner's choice: "Ask why, then
 *   submit"), so End job asks why and then carries on.
 */

export interface EndJobBlocker {
  /** Which row of the job to open: its inspection, or its filter change. */
  opens: 'INSPECTION' | 'FILTERS';
  title: string;
  message: string;
}

export interface EndJobPlan {
  /** What has to be finished first. End job opens the first of them. */
  blockers: EndJobBlocker[];
  /** Services not ticked, asked about one at a time and then submitted as not done. */
  unticked: JobTask[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function planEndJob(
  tasks: readonly JobTask[],
  gate: Pick<SubmissionGate, 'canSubmit' | 'incompleteRequiredRooms'>,
): EndJobPlan {
  const blockers: EndJobBlocker[] = [];

  const inspection = tasks.find((task) => task.kind === 'INSPECTION');
  if (!gate.canSubmit && gate.incompleteRequiredRooms.length) {
    const left = gate.incompleteRequiredRooms;
    blockers.push({
      opens: 'INSPECTION',
      title: `Finish the ${inspection?.title.toLowerCase() ?? 'inspection'} first`,
      message: `${plural(left.length, 'required area is', 'required areas are')} not finished: ${left
        .map((room) => room.name)
        .join(', ')}.`,
    });
  }

  const filters = tasks.find((task) => task.kind === 'FILTERS');
  if (filters && (filters.state === 'TODO' || filters.state === 'PART'))
    blockers.push({
      opens: 'FILTERS',
      title: 'Finish the filter change first',
      message: filters.detail
        ? `${filters.detail}. Photograph each filter with its size in shot, or say why it was not changed.`
        : 'Photograph each filter with its size in shot, or say why it was not changed.',
    });

  return {
    blockers,
    unticked: tasks.filter((task) => task.kind === 'SERVICE' && task.state === 'TODO'),
  };
}
