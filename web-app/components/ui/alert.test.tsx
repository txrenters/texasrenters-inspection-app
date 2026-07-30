import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert, AlertDescription, AlertTitle } from './alert';

describe('Alert', () => {
  it('gives direct message content the full alert width', () => {
    const { container } = render(
      <Alert variant="success">AI detected 10 areas and added 10 new drafts.</Alert>,
    );

    expect(screen.getByText(/AI detected 10 areas/)).toBeVisible();
    expect(container.firstElementChild).not.toHaveClass('grid-cols-[0_1fr]');
    expect(container.firstElementChild).toHaveClass('w-full');
  });

  it('keeps structured alert content readable with an icon', () => {
    const { container } = render(
      <Alert>
        <svg aria-hidden />
        <AlertTitle>Extraction complete</AlertTitle>
        <AlertDescription>Review the detected areas before approval.</AlertDescription>
      </Alert>,
    );

    expect(screen.getByText('Extraction complete')).toBeVisible();
    expect(screen.getByText(/Review the detected areas/)).toBeVisible();
    expect(container.firstElementChild).toHaveClass('has-[>svg]:pl-11');
  });
});
