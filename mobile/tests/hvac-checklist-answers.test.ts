import { isAnswered } from '../src/capture/ChecklistAnswerFields';
import type { ChecklistItem } from '../src/capture/area-checklist';
import type { ChecklistAssessment } from '../src/domain/models';

const item = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: 'i1',
  label: 'Temperature split',
  keywords: [],
  ...over,
});

const blank: ChecklistAssessment = {
  isClean: null,
  isUndamaged: null,
  isWorking: null,
  comment: null,
};

/**
 * The header counts covered items, and coverage used to look only at the three
 * yes/no axes. On the HVAC checklist a technician could fill in all eight
 * measurements and still be told nothing was covered.
 */
describe('what counts as an answered checklist item', () => {
  it('counts a measurement of zero, because zero is a reading', () => {
    // `!= null`, not truthiness. 0 °F is a temperature somebody stood outside
    // and measured.
    expect(isAnswered(item({ responseType: 'READING' }), { ...blank, numericValue: 0 })).toBe(true);
  });

  it('does not count a reading nobody entered', () => {
    expect(isAnswered(item({ responseType: 'READING' }), blank)).toBe(false);
  });

  it('counts a chosen option and ignores an empty one', () => {
    const choice = item({ responseType: 'CHOICE', choices: ['Clean', 'Dirty'] });
    expect(isAnswered(choice, { ...blank, textValue: 'Dirty' })).toBe(true);
    expect(isAnswered(choice, { ...blank, textValue: '' })).toBe(false);
  });

  it('still counts a status item answered on any single axis', () => {
    // Unchanged behaviour for the 47 items that are ticks, and for every room
    // checklist in the app.
    expect(isAnswered(item(), { ...blank, isWorking: false })).toBe(true);
    expect(isAnswered(item(), blank)).toBe(false);
  });

  it('treats an item with no declared type as a status item', () => {
    // Room checklists send no responseType, and neither does the generated
    // offline fallback.
    expect(isAnswered(item({ responseType: undefined }), { ...blank, isClean: true })).toBe(true);
  });

  it('counts nothing when there is no assessment at all', () => {
    expect(isAnswered(item({ responseType: 'READING' }), undefined)).toBe(false);
  });
});
