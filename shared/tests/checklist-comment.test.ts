import { describe, expect, it } from 'vitest';

import { choiceInvitesComment } from '../src/contracts/checklist-comment.js';
import { HVAC_CONDITION_CHOICES } from '../src/contracts/hvac-checklist.js';

/**
 * From the 2026-09-09 field feedback: "Comments: Required only when an issue is
 * identified." The half that matters is the second — a comment box on every row
 * is a toll, and a toll is paid with whatever clears it.
 *
 * The direction of the rule is the thing to protect. Everything that is not
 * explicitly reassuring invites an explanation, so an option the office adds or
 * rewords later defaults to asking rather than silently suppressing.
 */
describe('which answers invite the technician to explain', () => {
  it.each([['Damaged'], ['Needs attention'], ['Fair'], ['Poor']])(
    'asks after %s',
    (choice) => {
      expect(choiceInvitesComment(choice)).toBe(true);
    },
  );

  it.each([['Clean'], ['Acceptable'], ['Good']])('does not ask after %s', (choice) => {
    expect(choiceInvitesComment(choice)).toBe(false);
  });

  it('asks nothing of an unanswered item', () => {
    // A box that appears before anything is chosen is the every-row comment
    // field this exists to avoid.
    expect(choiceInvitesComment(null)).toBe(false);
    expect(choiceInvitesComment(undefined)).toBe(false);
    expect(choiceInvitesComment('')).toBe(false);
  });

  it('reads the office’s capitalisation and spacing as written', () => {
    // These are stored verbatim as the office's own words, and the office's
    // capitalisation moves.
    expect(choiceInvitesComment('  clean  ')).toBe(false);
    expect(choiceInvitesComment('GOOD')).toBe(false);
    expect(choiceInvitesComment('  Damaged ')).toBe(true);
  });

  it('treats an unknown option as one worth explaining', () => {
    // The safe direction. Offering a box nobody needed costs a glance; the
    // other way round loses the account of a defect.
    expect(choiceInvitesComment('Something the office added later')).toBe(true);
  });

  describe('against the HVAC form, which already ships these choices', () => {
    it('asks after every option except the one that means no action', () => {
      const asked = HVAC_CONDITION_CHOICES.filter((choice) => choiceInvitesComment(choice));
      expect(asked).toEqual([
        'Maintenance recommended',
        'Repair recommended',
        'Immediate repair required',
        'Replacement recommended',
      ]);
    });

    it('matches the em dash the printed form uses', () => {
      // Written with an em dash in `HVAC_CONDITION_CHOICES`. A hyphen is
      // accepted too, because the two spellings are exactly the kind of thing
      // that drifts when somebody retypes a form.
      expect(choiceInvitesComment('Good — no action required')).toBe(false);
      expect(choiceInvitesComment('Good - no action required')).toBe(false);
    });
  });
});
