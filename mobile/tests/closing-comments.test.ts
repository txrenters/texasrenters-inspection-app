import {
  asksClosingComments,
  closingCommentsToSend,
  EMPTY_CLOSING_COMMENTS,
} from '../src/utils/closing-comments';

/**
 * The closing block of the office's HVAC report, written on the final review
 * and sent with the submission. The office can edit it afterwards.
 */
describe('closing comments', () => {
  it('are asked of an HVAC inspection only', () => {
    expect(asksClosingComments('HVAC')).toBe(true);
    for (const type of ['OCCUPIED', 'MOVE_OUT', null, undefined]) expect(asksClosingComments(type)).toBe(false);
  });

  it('send only what was written, trimmed', () => {
    expect(
      closingCommentsToSend({ ...EMPTY_CLOSING_COMMENTS, maintenanceComments: '  Coil guard bent  ', generalComments: ' ' }),
    ).toEqual({ maintenanceComments: 'Coil guard bent' });
  });

  /** An empty field would clear what the office wrote; a technician who wrote nothing asked for no such thing. */
  it('send nothing when nothing was written', () => {
    expect(closingCommentsToSend(EMPTY_CLOSING_COMMENTS)).toBeUndefined();
  });
});
