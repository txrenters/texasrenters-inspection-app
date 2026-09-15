import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HVAC_CHECKLIST,
  OCCUPIED_CHECKLIST,
  answerAfterToggle,
  choiceInvitesComment,
} from '@texasrenters/shared';

import { choiceAfterTap } from '../src/capture/ChecklistAnswerFields';

/**
 * The occupied condition questions are checkboxes, and have to look it.
 *
 * Demoed to the product owner on 2026-09-14, separate bordered buttons read as
 * though several could be picked when only one could, so they became a radio
 * list. On 2026-09-15 the office asked for checkboxes that do tick several: a
 * room can be clean and still need attention. The HVAC form's single choices
 * stay radios.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

describe('answering an occupied condition question', () => {
  const roomCondition = OCCUPIED_CHECKLIST.find((item) => item.label === 'Room condition')!;
  const offered = roomCondition.choices;

  it('keeps every option ticked until it is unticked', () => {
    // Replayed the way the card sees it: each answer is what the next tap starts from.
    let answer: string | null = null;
    for (const tap of ['Clean', 'Needs attention', 'Damaged']) answer = answerAfterToggle(answer, tap, offered);
    expect(answer).toBe('Clean, Damaged, Needs attention');
    expect(answerAfterToggle(answer, 'Damaged', offered)).toBe('Clean, Needs attention');
  });

  it('clears the answer when the last tick is removed', () => {
    // So "not assessed" stays reachable.
    expect(answerAfterToggle('Damaged', 'Damaged', offered)).toBeNull();
  });

  it('asks what was found once anything ticked is a concern, and not before', () => {
    expect(choiceInvitesComment(answerAfterToggle('Clean', 'Damaged', offered))).toBe(true);
    expect(choiceInvitesComment(answerAfterToggle('Clean, Damaged', 'Damaged', offered))).toBe(false);
  });

  it('can tick each option on its own, because no question repeats an option', () => {
    const questions = [...OCCUPIED_CHECKLIST, ...HVAC_CHECKLIST].filter(
      (item) => item.responseType === 'CHOICE',
    );
    expect(offered).toEqual(['Clean', 'Acceptable', 'Damaged', 'Needs attention']);
    for (const question of questions) {
      const choices = question.choices ?? [];
      expect(new Set(choices).size).toBe(choices.length);
    }
  });

  it('still moves a single-choice answer rather than adding to it, for the HVAC form', () => {
    expect(choiceAfterTap('Clean', 'Dirty')).toBe('Dirty');
    expect(choiceAfterTap('Dirty', 'Dirty')).toBeNull();
  });
});

describe('how the options are drawn', () => {
  const fields = read('src/capture/ChecklistAnswerFields.tsx');
  const choicesField = fields.slice(
    fields.indexOf('export function ChoicesField'),
    fields.indexOf('export function CommentField'),
  );
  const choiceField = fields.slice(
    fields.indexOf('export function ChoiceField'),
    fields.indexOf('export function ChoicesField'),
  );

  it('draws the occupied questions as checkboxes that tick several', () => {
    expect(choicesField).toContain('accessibilityRole="checkbox"');
    expect(choicesField).toContain('accessibilityState={{ checked: active }}');
    expect(choicesField).toContain('onChange(answerAfterToggle(value, choice, offered))');
    expect(choicesField).not.toContain('radio');
  });

  it('keeps the single choice a radio list', () => {
    expect(choiceField).toContain('accessibilityRole="radiogroup"');
    expect(choiceField).toContain('onChange(choiceAfterTap(value, choice))');
  });

  it('is what the occupied condition card asks each question with', () => {
    const card = read('src/areas/OccupiedConditionCard.tsx');
    expect(card).toContain('<ChoicesField');
    expect(card).not.toContain('<ChoiceField');
  });
});
