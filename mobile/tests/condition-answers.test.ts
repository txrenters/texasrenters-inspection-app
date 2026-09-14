import { conditionPromptItems, isStatusItem, withAxes } from '../src/capture/condition-answers';

/**
 * The camera's yes/no condition prompt, on items it has no business asking.
 *
 * Found on an occupied visit: the prompt put "Is it clean?" to "Room condition",
 * a multiple choice, and its answer was written as a whole record -- so it
 * replaced the choice the technician had made on the area screen with blanks.
 */

describe('which items the yes/no prompt may ask', () => {
  const items = [
    { id: 'walls', responseType: 'STATUS' },
    { id: 'legacy' },
    { id: 'room-condition', responseType: 'CHOICE' },
    { id: 'supply-temp', responseType: 'READING' },
    { id: 'notes', responseType: 'TEXT' },
  ];

  it('asks clean / undamaged / working items, including ones the server has not typed', () => {
    expect(conditionPromptItems(items).map((item) => item.id)).toEqual(['walls', 'legacy']);
  });

  it('leaves a choice, a reading and free text to the controls built for them', () => {
    expect(isStatusItem({ responseType: 'CHOICE' })).toBe(false);
    expect(isStatusItem({ responseType: 'READING' })).toBe(false);
    expect(isStatusItem({ responseType: 'TEXT' })).toBe(false);
  });
});

describe('writing the three answers', () => {
  const axes = { isClean: true, isUndamaged: false, isWorking: true };

  it('keeps the comment, reading and choice already stored', () => {
    const stored = {
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      comment: 'Scuff by the door',
      numericValue: 21.5,
      textValue: 'Acceptable',
    };

    expect(withAxes(stored, axes, 42)).toEqual({
      ...axes,
      comment: 'Scuff by the door',
      numericValue: 21.5,
      textValue: 'Acceptable',
      videoTimestampSeconds: 42,
    });
  });

  it('writes explicit nulls for an item never answered, rather than leaving fields out', () => {
    // The API replaces the record, so an absent field and a null one land the
    // same -- but spelling them out keeps the payload honest about it.
    expect(withAxes(undefined, axes, null)).toEqual({
      ...axes,
      comment: null,
      numericValue: null,
      textValue: null,
      videoTimestampSeconds: null,
    });
  });
});
