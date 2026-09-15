import { describe, expect, it } from 'vitest';

import {
  CHOICE_SEPARATOR,
  HVAC_CHECKLIST,
  OCCUPIED_CHECKLIST,
  OCCUPIED_ROOM_CONDITION_CHOICES,
  answerAfterToggle,
  answerWithChoices,
  choiceInvitesComment,
  choicesInAnswer,
} from '../src/index.js';

/**
 * The occupied condition questions became checkboxes on 2026-09-15, at the
 * office's request: a room can be clean and still need attention. Several ticks
 * are stored as the one answer the question always had.
 */

const room = [...OCCUPIED_ROOM_CONDITION_CHOICES];

describe('several ticks in one answer', () => {
  it('adds a tick, keeps the others, and removes it again', () => {
    let answer: string | null = null;
    answer = answerAfterToggle(answer, 'Needs attention', room);
    answer = answerAfterToggle(answer, 'Clean', room);
    expect(answer).toBe('Clean, Needs attention');
    expect(answerAfterToggle(answer, 'Needs attention', room)).toBe('Clean');
    expect(answerAfterToggle('Clean', 'Clean', room)).toBeNull();
  });

  it('stores the ticks in the order the question offers them, whichever came first', () => {
    expect(answerWithChoices(['Needs attention', 'Damaged', 'Clean'], room)).toBe('Clean, Damaged, Needs attention');
    expect(answerWithChoices([], room)).toBeNull();
  });

  it('reads an answer written before checkboxes as one tick', () => {
    expect(choicesInAnswer('Acceptable')).toEqual(['Acceptable']);
    expect(choicesInAnswer(null)).toEqual([]);
    expect(answerAfterToggle('Acceptable', 'Damaged', room)).toBe('Acceptable, Damaged');
  });

  it('drops anything not offered rather than printing it', () => {
    expect(answerAfterToggle('Spotless', 'Clean', room)).toBe('Clean');
  });

  it('has no offered option containing the separator, on any form', () => {
    // If one did, "Good, but dusty" would read back as two answers.
    for (const item of [...OCCUPIED_CHECKLIST, ...HVAC_CHECKLIST]) {
      for (const choice of item.choices ?? []) expect(choice).not.toContain(CHOICE_SEPARATOR.trim());
    }
  });
});

describe('asking what was found when several are ticked', () => {
  it('asks when any tick is a concern', () => {
    expect(choiceInvitesComment('Clean, Needs attention')).toBe(true);
    expect(choiceInvitesComment('Good, Poor')).toBe(true);
  });

  it('does not ask when every tick is reassuring', () => {
    expect(choiceInvitesComment('Clean, Acceptable')).toBe(false);
    expect(choiceInvitesComment('Good — no action required')).toBe(false);
    expect(choiceInvitesComment(null)).toBe(false);
  });
});
