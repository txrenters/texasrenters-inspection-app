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
 * - **A service left unticked.** Pest control not ticked means it was not done.
 *   End job used to stop and ask why ("Ask why, then submit"); since 2026-09-29
 *   it is never a reason to stop -- the job goes in with it as not done and to
 *   be booked again (`withUntickedNotDone`), and a note can be left on the row
 *   beforehand.
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
  /** Services not ticked, submitted as not done and to be booked again. */
  unticked: JobTask[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * An area submitted here whose video is still on its way. It is not completed
 * until the server has the video, so End job waits for it -- but it is not
 * work left to do, and "not finished" told a technician who had finished every
 * room to go and finish one (Moses, 2026-10-12).
 */
const STILL_SENDING = new Set(['PENDING', 'UPLOADING', 'PAUSED']);
const isSending = (room: { completionStatus: string; uploadStatus?: string | null }) =>
  room.completionStatus === 'RECORDING_SAVED' && STILL_SENDING.has(room.uploadStatus ?? 'PENDING');
const names = (rooms: readonly { name: string }[]) => rooms.map((room) => room.name).join(', ');

export function planEndJob(
  tasks: readonly JobTask[],
  gate: Pick<SubmissionGate, 'canSubmit' | 'incompleteRequiredRooms'>,
  /** An HVAC job's filters are scored as well (Moses, 2026-10-01). */
  filterRules: { assess: boolean; changeAsked: boolean } = { assess: false, changeAsked: true },
): EndJobPlan {
  const blockers: EndJobBlocker[] = [];

  const inspection = tasks.find((task) => task.kind === 'INSPECTION');
  if (!gate.canSubmit && gate.incompleteRequiredRooms.length) {
    const sending = gate.incompleteRequiredRooms.filter(isSending);
    const left = gate.incompleteRequiredRooms.filter((room) => !isSending(room));
    const wait = `Keep the app open with signal; End job works once ${sending.length === 1 ? 'it has' : 'they have'} arrived.`;
    blockers.push(
      left.length
        ? {
            opens: 'INSPECTION',
            title: `Finish the ${inspection?.title.toLowerCase() ?? 'inspection'} first`,
            message: `${plural(left.length, 'required area is', 'required areas are')} not finished: ${names(left)}.${
              sending.length ? ` Still sending their video: ${names(sending)}.` : ''
            }`,
          }
        : {
            opens: 'INSPECTION',
            title: sending.length === 1 ? 'A video is still sending' : 'Videos are still sending',
            message: `${names(sending)} ${sending.length === 1 ? 'is' : 'are'} still sending from this phone. ${wait}`,
          },
    );
  }

  const filters = tasks.find((task) => task.kind === 'FILTERS');
  if (filters && (filters.state === 'TODO' || filters.state === 'PART')) {
    const ask = !filterRules.assess
      ? 'Stack the filters and take one photo of them all, or say why one was not changed.'
      : filterRules.changeAsked
        ? 'Score each filter Clean, Undamaged and Working, and take one photo of them all or say why one was not changed.'
        : 'Score each filter Clean, Undamaged and Working, or say why it could not be.';
    blockers.push({
      opens: 'FILTERS',
      title: filterRules.assess && !filterRules.changeAsked ? 'Finish the filters first' : 'Finish the filter change first',
      message: filters.detail ? `${filters.detail}. ${ask}` : ask,
    });
  }

  return {
    blockers,
    unticked: tasks.filter((task) => task.kind === 'SERVICE' && task.state === 'TODO'),
  };
}
