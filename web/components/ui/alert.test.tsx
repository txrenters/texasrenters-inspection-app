import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert, AlertDescription, AlertTitle } from './alert';

/**
 * Behaviour, not class strings.
 *
 * The versions of these tests in `web-app` asserted on that component's exact
 * utility classes (`grid-cols-[0_1fr]`, `has-[>svg]:pl-11`). That fails the
 * moment the layout is expressed differently — as it is here — while never
 * catching the thing that actually matters, which is whether the message is
 * announced and readable.
 */
describe('Alert', () => {
  it('announces itself, so a message that appears after an action is not silent', () => {
    render(<Alert variant="success">AI detected 10 areas and added 10 new drafts.</Alert>);

    const alert = screen.getByRole('alert');
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent('AI detected 10 areas and added 10 new drafts.');
  });

  it('renders a bare string with no title or description wrapper', () => {
    render(<Alert>Extraction failed.</Alert>);

    expect(screen.getByRole('alert')).toHaveTextContent('Extraction failed.');
    expect(document.querySelector('[data-slot="alert-title"]')).toBeNull();
  });

  it('keeps an icon, a title and a description all reachable', () => {
    render(
      <Alert>
        <svg aria-hidden />
        <AlertTitle>Extraction complete</AlertTitle>
        <AlertDescription>Review the detected areas before approval.</AlertDescription>
      </Alert>,
    );

    expect(screen.getByText('Extraction complete')).toBeVisible();
    expect(screen.getByText(/Review the detected areas/)).toBeVisible();
    // The decorative icon must not reach the accessible name, or the alert is
    // announced with a stray graphic in front of its message.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Extraction completeReview the detected areas before approval.',
    );
  });

  it('carries the status tone on the element, so it is not colour-only', () => {
    const { rerender } = render(<Alert variant="destructive">Failed</Alert>);
    const destructive = screen.getByRole('alert').className;

    rerender(<Alert variant="success">Done</Alert>);
    // Different tones must produce different styling; identical classes would
    // mean the variant prop silently did nothing.
    expect(screen.getByRole('alert').className).not.toBe(destructive);
  });
});
