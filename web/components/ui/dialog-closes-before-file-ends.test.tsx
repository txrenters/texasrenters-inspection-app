import * as DialogPrimitive from '@radix-ui/react-dialog';
import { render, screen } from '@testing-library/react';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A dialog open when a file's last test ends hands focus back before jsdom goes.
 *
 * Radix hands focus back from a `setTimeout(0)` after the dialog unmounts. The
 * shared `afterEach` unmounts it, and if that was the file's last test, jsdom
 * used to be torn down before the timer ran: Radix then built its event from
 * Node's `CustomEvent`, jsdom refused it ("parameter 1 is not of type
 * 'Event'"), and the unhandled error failed the whole web run though every test
 * passed (CI on #440, 2026-10-08). `onCloseAutoFocus` is that same timer.
 */

let handedBack = false;

describe('a dialog left open by the last test', () => {
  it('is open when the test ends', () => {
    render(
      <DialogPrimitive.Root defaultOpen>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onCloseAutoFocus={() => {
              handedBack = true;
            }}
          >
            <DialogPrimitive.Title>Take this visit off the day?</DialogPrimitive.Title>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

afterAll(() => {
  // Read after the shared cleanup has unmounted the dialog, and before jsdom goes.
  expect(handedBack).toBe(true);
});
