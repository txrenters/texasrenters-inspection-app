import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HVAC_CHECKLIST, OCCUPIED_CHECKLIST, choiceInvitesComment } from '@texasrenters/shared';

import { choiceAfterTap } from '../src/capture/ChecklistAnswerFields';

/**
 * The occupied condition questions take one answer each, and have to look it.
 *
 * Demoed to the product owner, the options -- drawn as separate bordered
 * buttons -- read as though several could be picked at once. One value was
 * always stored. The options are a radio list now, with a tick on the one
 * chosen, and the rule behind a tap is `choiceAfterTap`.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('answering an occupied condition question', () => {
  const roomCondition = OCCUPIED_CHECKLIST.find((item) => item.label === 'Room condition');

  it('selects the option tapped when nothing was chosen', () => {
    expect(choiceAfterTap(null, 'Clean')).toBe('Clean');
  });

  it('moves the selection to the next option tapped rather than adding to it', () => {
    // Replayed the way the card sees it: each answer is what the next tap
    // starts from, and what is stored is always a single option.
    let answer: string | null = null;
    for (const tap of ['Clean', 'Damaged', 'Acceptable']) answer = choiceAfterTap(answer, tap);
    expect(answer).toBe('Acceptable');
  });

  it('clears the answer when the chosen option is tapped again', () => {
    // So "not assessed" stays reachable: a question that cannot be un-answered
    // records a mistap as the room's condition.
    expect(choiceAfterTap('Damaged', 'Damaged')).toBeNull();
  });

  it('can draw only one option as chosen, because no question repeats an option', () => {
    // An option is drawn ticked when it equals the stored answer, so two
    // options with the same words would tick together.
    const questions = [...OCCUPIED_CHECKLIST, ...HVAC_CHECKLIST].filter(
      (item) => item.responseType === 'CHOICE',
    );
    expect(roomCondition?.choices).toEqual(['Clean', 'Acceptable', 'Damaged', 'Needs attention']);
    for (const question of questions) {
      const choices = question.choices ?? [];
      expect(new Set(choices).size).toBe(choices.length);
    }
  });

  it('keeps the what-did-you-find prompt in step with where the selection moved', () => {
    // The comment is asked after a concern and not after a reassuring answer;
    // moving the selection has to move that with it, and clearing asks nothing.
    expect(choiceInvitesComment(choiceAfterTap('Clean', 'Damaged'))).toBe(true);
    expect(choiceInvitesComment(choiceAfterTap('Damaged', 'Clean'))).toBe(false);
    expect(choiceInvitesComment(choiceAfterTap('Damaged', 'Damaged'))).toBe(false);
  });
});

describe('how the options are drawn', () => {
  const fields = read('src/capture/ChecklistAnswerFields.tsx');
  const choiceField = fields.slice(
    fields.indexOf('export function ChoiceField'),
    fields.indexOf('export function CommentField'),
  );

  it('is one radio group of radios, not a row of toggles or checkboxes', () => {
    expect(choiceField).toContain('accessibilityRole="radiogroup"');
    expect(choiceField).toContain('accessibilityRole="radio"');
    expect(choiceField).toContain('accessibilityState={{ checked: active }}');
    expect(choiceField).not.toContain('checkbox');
  });

  it('decides a tap by the single-choice rule', () => {
    expect(choiceField).toContain('onChange(choiceAfterTap(value, choice))');
  });

  it('is what the occupied condition card asks each question with', () => {
    expect(read('src/areas/OccupiedConditionCard.tsx')).toContain('<ChoiceField');
  });
});
