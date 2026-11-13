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
 * until the server has the video -- but it is not work left to do, and "not
 * finished" told a technician who had finished every room to go and finish one
 * (Moses, 2026-10-12).
 *
 * Nor does End job wait for it any more (2026-11-14): the job is sent with the
 * videos still on their way named (`videosStillSending`), the server takes them
 * when they land and holds the review for them, and the phone goes on sending.
 * Waiting with the app open for every upload to finish was what held
 * technicians at a job they had finished. A failed upload still stops End job:
 * nothing will send it until the technician does something.
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
    // Only what is left to do stops End job; a video on its way goes with it.
    if (left.length)
      blockers.push({
        opens: 'INSPECTION',
        title: `Finish the ${inspection?.title.toLowerCase() ?? 'inspection'} first`,
        message: `${plural(left.length, 'required area is', 'required areas are')} not finished: ${names(left)}.${
          sending.length ? ` Still sending their video: ${names(sending)}.` : ''
        }`,
      });
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

/**
 * What the phone says once the job is ended (2026-11-14). With videos still on
 * their way it says they still need sending: they go only while the app is open
 * with signal, and the office's review waits for them.
 */
export function jobEndedMessage(videosStillSending: number): string {
  if (!videosStillSending) return 'It is with the office. Any photos still sending keep uploading.';
  return `It is with the office. ${plural(videosStillSending, 'room video is', 'room videos are')} still sending: keep the app open with signal until ${
    videosStillSending === 1 ? 'it has' : 'they have'
  } gone. The office's review waits for ${videosStillSending === 1 ? 'it' : 'them'}.`;
}
