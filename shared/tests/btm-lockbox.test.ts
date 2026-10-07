import { describe, expect, it } from 'vitest';

import {
  BTM_LOCKBOX_AREA_NAME,
  BTM_LOCKBOX_CHECKLIST,
  isBtmLockboxArea,
  lockboxUnansweredMessage,
  unansweredLockboxQuestions,
} from '../src/contracts/btm-lockbox.js';
import { asksLockboxQuestions, isInspectedArea } from '../src/contracts/inspection-scope.js';
import { OCCUPIED_CHECKLIST } from '../src/contracts/occupied-checklist.js';

/**
 * The sign, supra and lockbox on every back-to-market visit (Moses, 2026-10-08):
 * "Installed?", "Key functioning?" and a box for notes.
 */

describe('the sign, supra and lockbox questions', () => {
  it('asks what Moses asked, in his order, Yes before No', () => {
    expect(BTM_LOCKBOX_CHECKLIST.map((item) => [item.label, item.responseType, item.choices, item.required])).toEqual([
      ['Installed?', 'CHOICE', ['Yes', 'No'], true],
      ['Key functioning?', 'CHOICE', ['Yes', 'No'], true],
      ['Notes on installation or the key', 'TEXT', [], false],
    ]);
  });

  it('never shares a label with the condition questions, which are found by label too', () => {
    const condition = new Set(OCCUPIED_CHECKLIST.map((item) => item.label));
    for (const item of BTM_LOCKBOX_CHECKLIST) expect(condition.has(item.label)).toBe(false);
  });
});

describe('which area is the sign, supra and lockbox', () => {
  it.each([
    BTM_LOCKBOX_AREA_NAME,
    'Sign, Supra, and Lockbox', // Jobber's completion step
    'sign supra lockbox',
    ' Sign / Supra / Lockbox ',
  ])('recognises %s', (name) => {
    expect(isBtmLockboxArea(name)).toBe(true);
  });

  it.each(['Lockbox', 'Sign', 'Front yard', 'Supra lockbox', '', null])('does not take %s for it', (name) => {
    expect(isBtmLockboxArea(name)).toBe(false);
  });

  it('asks its questions on a back-to-market or occupied visit, where the area is walked like a room', () => {
    expect(asksLockboxQuestions('BACK_TO_MARKET', BTM_LOCKBOX_AREA_NAME)).toBe(true);
    // A technician's hand-made one on an occupied visit answers the same rows.
    expect(asksLockboxQuestions('OCCUPIED', 'Sign, supra and lockbox')).toBe(true);
    expect(asksLockboxQuestions('BACK_TO_MARKET', 'Kitchen')).toBe(false);
    expect(asksLockboxQuestions('MOVE_OUT', BTM_LOCKBOX_AREA_NAME)).toBe(false);
  });

  it('is the one system area a back-to-market visit inspects', () => {
    const area = { name: BTM_LOCKBOX_AREA_NAME, source: 'SYSTEM' };
    expect(isInspectedArea('BACK_TO_MARKET', area)).toBe(true);
    expect(isInspectedArea('OCCUPIED', area)).toBe(false);
    expect(isInspectedArea('MOVE_IN', area)).toBe(false);
  });
});

describe('before the area can be submitted', () => {
  it('needs both questions answered, and never the notes', () => {
    expect(unansweredLockboxQuestions([])).toEqual(['Installed?', 'Key functioning?']);
    expect(
      unansweredLockboxQuestions([
        { label: 'Installed?', textValue: 'No' },
        { label: 'Notes on installation or the key', textValue: null },
      ]),
    ).toEqual(['Key functioning?']);
    expect(
      unansweredLockboxQuestions([
        { label: 'Installed?', textValue: 'Yes' },
        { label: 'Key functioning?', textValue: 'No' },
      ]),
    ).toEqual([]);
  });

  it('does not count a blank answer as one', () => {
    expect(unansweredLockboxQuestions([{ label: 'Installed?', textValue: '  ' }])).toContain('Installed?');
  });

  it('names what is missing', () => {
    expect(lockboxUnansweredMessage(['Installed?', 'Key functioning?'])).toBe(
      'Answer "Installed?" and "Key functioning?" before submitting this area.',
    );
  });
});
