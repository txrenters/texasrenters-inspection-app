import { withAxes } from '../src/capture/condition-answers';

/**
 * Writing clean / undamaged / working without erasing the rest of the record.
 *
 * Found on an occupied visit: the camera's yes/no prompt wrote its three answers
 * as a whole record, so it replaced the choice the technician had made on the
 * area screen with blanks. The prompt is gone, and the checklist is answered on
 * the area screen alone, but every axis write still goes through this.
 */

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
