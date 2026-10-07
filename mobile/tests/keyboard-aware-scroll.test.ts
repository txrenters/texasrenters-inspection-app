import { KEYBOARD_CLEARANCE, revealScrollTarget } from '../src/components/KeyboardAwareScrollView';

/**
 * The field being typed in stays above the keyboard (2026-10-08).
 *
 * Moses typed an area's note into a box the keyboard covered, and sliding the
 * screen up only sprang back. The scroll view now makes room for the keyboard
 * and scrolls the whole field above it.
 */

// An iPhone-sized screen: the list starts under the header, the keyboard's top
// is at 520 points.
const SCROLL_TOP = 60;
const KEYBOARD_TOP = 520;

describe('where the screen scrolls when the keyboard opens', () => {
  it('lifts a field the keyboard covers until all of it shows, with room to spare', () => {
    // A note box 80 points tall whose top is at 600 on screen, 1,400 into the
    // content: the list is scrolled 860 down.
    const target = revealScrollTarget({
      inContent: 1_400,
      inWindow: 600,
      height: 80,
      scrollTop: SCROLL_TOP,
      keyboardTop: KEYBOARD_TOP,
    });
    // Its bottom (680) must come up to 520 - clearance: 160 + clearance more.
    expect(target).toBe(860 + 160 + KEYBOARD_CLEARANCE);
  });

  it('leaves a field that already shows where it is', () => {
    expect(
      revealScrollTarget({ inContent: 300, inWindow: 200, height: 48, scrollTop: SCROLL_TOP, keyboardTop: KEYBOARD_TOP }),
    ).toBeNull();
  });

  it('follows a note as it grows a line past the keyboard', () => {
    const before = { inContent: 1_400, inWindow: 400, height: 80, scrollTop: SCROLL_TOP, keyboardTop: KEYBOARD_TOP };
    expect(revealScrollTarget(before)).toBeNull();
    // One more line: 20 points taller, and now 4 points under the clearance.
    expect(revealScrollTarget({ ...before, height: 100 })).toBe(1_060 + 4);
  });

  it('never pushes the top of a field taller than the room off the top of the list', () => {
    // A long note, 600 points tall, starting just under the header.
    const target = revealScrollTarget({
      inContent: 900,
      inWindow: 100,
      height: 600,
      scrollTop: SCROLL_TOP,
      keyboardTop: KEYBOARD_TOP,
    });
    // Scrolled until its top meets the top of the list, and no further.
    expect(target).toBe(900);
  });

  it('never asks for a position above the start of the list', () => {
    expect(
      revealScrollTarget({ inContent: 10, inWindow: 500, height: 80, scrollTop: 490, keyboardTop: 520 }),
    ).toBeGreaterThanOrEqual(0);
  });
});
