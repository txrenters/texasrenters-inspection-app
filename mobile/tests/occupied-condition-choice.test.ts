import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HVAC_CHECKLIST, OCCUPIED_CHECKLIST, choiceInvitesComment } from '@texasrenters/shared';

import { choiceAfterTap } from '../src/capture/ChecklistAnswerFields';

/**
 * The occupied condition questions are radio buttons: one answer each.
 *
 * Demoed to the product owner on 2026-09-14, separate bordered buttons read as
 * though several could be picked when only one could, so they became a radio
 * list. On 2026-09-15 the office asked for checkboxes that tick several; on
 * 2026-09-29 the technicians asked for the radio buttons back.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('answering an occupied condition question', () => {
  const roomCondition = OCCUPIED_CHECKLIST.find((item) => item.label === 'Room condition')!;

  it('offers the room conditions', () => {
    expect(roomCondition.choices).toEqual(['Clean', 'Acceptable', 'Damaged', 'Needs attention']);
  });

  it('moves the answer to the option tapped, rather than adding to it', () => {
    expect(choiceAfterTap('Clean', 'Damaged')).toBe('Damaged');
  });

  it('clears the answer when the chosen option is tapped again', () => {
    // So "not assessed" stays reachable.
    expect(choiceAfterTap('Damaged', 'Damaged')).toBeNull();
  });

  it('turns an answer saved with several ticks into the one tapped', () => {
    // Saved while the questions were checkboxes (2026-09-15 to 09-29).
    expect(choiceAfterTap('Clean, Needs attention', 'Clean')).toBe('Clean');
  });

  it('asks what was found when the answer is a concern, and not before', () => {
    expect(choiceInvitesComment('Damaged')).toBe(true);
    expect(choiceInvitesComment('Clean')).toBe(false);
  });

  it('never repeats an option within a question', () => {
    const questions = [...OCCUPIED_CHECKLIST, ...HVAC_CHECKLIST].filter(
      (item) => item.responseType === 'CHOICE',
    );
    for (const question of questions) {
      const choices = question.choices ?? [];
      expect(new Set(choices).size).toBe(choices.length);
    }
  });
});

describe('how the options are drawn', () => {
  const fields = read('src/capture/ChecklistAnswerFields.tsx');
  const choiceField = fields.slice(
    fields.indexOf('export function ChoiceField'),
    fields.indexOf('export function CommentField'),
  );

  it('is a radio list that holds one answer', () => {
    expect(choiceField).toContain('accessibilityRole="radiogroup"');
    expect(choiceField).toContain('accessibilityRole="radio"');
    expect(choiceField).toContain('onChange(choiceAfterTap(value, choice))');
  });

  it('is what the occupied condition card asks each question with', () => {
    const card = read('src/areas/OccupiedConditionCard.tsx');
    expect(card).toContain('<ChoiceField');
    expect(card).not.toContain('<ChoicesField');
  });
});
