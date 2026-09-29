import type { QueryClient, QueryKey } from '@tanstack/react-query';

import type { ChecklistAssessment, ChecklistItemWithAssessment } from '../domain/models';

/**
 * A checklist answer, from the tap to the server, without ever being taken back.
 *
 * The office (2026-09-30), on the AC filters checklist: a Y or N "sometimes
 * cleared out by itself as if it is always listens to the server", and answers
 * that highlighted "are gone" after leaving the screen or closing the app. Three
 * faults, each fixed here or beside it:
 *
 * 1. **Every reply redrew the whole list.** Each save re-read the checklist and
 *    put the server's copy on screen -- a copy taken before any tap still being
 *    sent, which it undid. Replies are no longer drawn at all: the screen is the
 *    technician's answers, and a later read agrees with it (`withPendingAnswers`).
 * 2. **Each tap sent the row as it was drawn before it.** Clean Y then Working N
 *    in quick succession sent Working with Clean still blank, and the server kept
 *    that. Now a tap carries only what it changed, is folded into the row in
 *    `onMutate`, and the send reads the row as it stands when its turn comes --
 *    the same shape `saveServices` takes for the job's checklist.
 * 3. **A save the app was closed on was lost** -- fixed in the repository, which
 *    saves each answer before sending it (`sendSavedFirst`) and reads saved ones
 *    back into the list.
 *
 * One area's answers go out one at a time (`scope`), so the last tap on a row is
 * always the last thing the server hears about it.
 */

/** What one tap changes on a row: an axis, a choice, a reading, a comment. */
export type ChecklistAnswerPatch = Partial<ChecklistAssessment>;

export interface ChecklistAnswer {
  itemId: string;
  patch: ChecklistAnswerPatch;
}

/** The scope one area's answers are sent in, one at a time. */
export const checklistAnswerScope = (roomId: string) => `checklist:${roomId}`;

/** The whole assessment the API takes, from a row as it now stands. */
export function assessmentOf(item: ChecklistItemWithAssessment): ChecklistAssessment {
  return {
    isClean: item.isClean ?? null,
    isUndamaged: item.isUndamaged ?? null,
    isWorking: item.isWorking ?? null,
    comment: item.comment ?? null,
    numericValue: item.numericValue ?? null,
    textValue: item.textValue ?? null,
    videoTimestampSeconds: item.videoTimestampSeconds ?? null,
  };
}

const applyPatch = (items: readonly ChecklistItemWithAssessment[], answer: ChecklistAnswer) =>
  items.map((item) => (item.id === answer.itemId ? { ...item, ...answer.patch } : item));

/**
 * The mutation options for one area's answers.
 *
 * Built here rather than inline so a test can drive the real `MutationCache`
 * with them. `send` and `onRefused` are injected: the repository and the alert
 * belong to the app, not to this logic.
 */
export function checklistAnswerOptions({
  client,
  key,
  roomId,
  send,
  onRefused,
}: {
  client: QueryClient;
  key: QueryKey;
  roomId: string;
  send: (itemId: string, assessment: ChecklistAssessment) => Promise<unknown>;
  onRefused?: (error: unknown) => void;
}) {
  return {
    scope: { id: checklistAnswerScope(roomId) },
    /**
     * Drawn now, before anything is sent -- and before the scope makes this
     * tap wait for the one before it, which is why it is here and not in
     * `mutationFn` (see `filter-add-mutation-scope.test.ts`).
     */
    onMutate: async (answer: ChecklistAnswer) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<ChecklistItemWithAssessment[]>(key, (current) =>
        current ? applyPatch(current, answer) : current,
      );
    },
    /** The row as it stands when this tap's turn comes: every earlier tap included. */
    mutationFn: async ({ itemId }: ChecklistAnswer) => {
      const item = client.getQueryData<ChecklistItemWithAssessment[]>(key)?.find((entry) => entry.id === itemId);
      if (!item) throw new Error('That checklist is not loaded, so the answer was not saved.');
      await send(itemId, assessmentOf(item));
    },
    onError: (error: unknown) => {
      // Held on the phone is saved: it is sent when it can, and stays drawn.
      if (error instanceof Error && error.name === 'QueuedOfflineError') return;
      // Refused -- the server's copy, with every other pending answer on top.
      void client.invalidateQueries({ queryKey: key });
      onRefused?.(error);
    },
  };
}

/**
 * The server's list with every answer still on its way laid over it, in the
 * order they were tapped.
 *
 * A read that lands while answers are being sent -- a pull to refresh, the
 * screen opened again, the refetch a refusal asks for -- would otherwise draw
 * the server's copy from before them, which is the same undoing as fault 1.
 */
export function withPendingAnswers(
  client: QueryClient,
  roomId: string,
  items: readonly ChecklistItemWithAssessment[],
): ChecklistItemWithAssessment[] {
  const pending = client
    .getMutationCache()
    .getAll()
    .filter(
      (mutation) =>
        mutation.options.scope?.id === checklistAnswerScope(roomId) && mutation.state.status === 'pending',
    )
    .sort((left, right) => left.mutationId - right.mutationId);
  return pending.reduce(
    (current, mutation) => applyPatch(current, mutation.state.variables as ChecklistAnswer),
    [...items],
  );
}
