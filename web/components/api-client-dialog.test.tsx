import type { ApiClientSummary } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientDialog } from './api-client-dialog';

const client: ApiClientSummary = {
  id: 'client-1',
  name: 'Testing',
  description: null,
  environment: 'TEST',
  permissions: ['technicians:locate'],
  rateLimitPerMinute: 60,
  requireSignature: true,
  allowedIps: [],
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  revokedAt: null,
  keys: [],
};

function renderDialog(props: Partial<Parameters<typeof ApiClientDialog>[0]> = {}) {
  return render(
    <ApiClientDialog
      onClose={() => {}}
      onSubmit={() => {}}
      open
      pending={false}
      {...props}
    />,
  );
}

describe('ApiClientDialog', () => {
  it('offers the environment only while registering', () => {
    renderDialog();

    expect(screen.getByRole('combobox', { name: /environment/i })).toBeInTheDocument();
  });

  it('fixes the environment once the client exists', () => {
    renderDialog({ client });

    // Every key encodes the environment, and the guard refuses a key whose
    // environment disagrees with its client. Editing it here would invalidate
    // every issued key at once without revoking one — they would still exist,
    // still look right, and simply stop working.
    expect(screen.queryByRole('combobox', { name: /environment/i })).toBeNull();
    expect(screen.getByText(/fixed at creation/i)).toBeInTheDocument();
    expect(screen.getByText(/register a separate client/i)).toBeInTheDocument();
  });

  it('shows a failed save rather than leaving the dialog silent', () => {
    // The reported bug: PATCH answered 400, the dialog sat there unchanged, and
    // the only evidence was in the network tab.
    renderDialog({ client, error: new Error('The client could not be saved.') });

    expect(screen.getByText(/could not be saved/i)).toBeInTheDocument();
  });

  it('submits without an environment when editing, since the API refuses it', () => {
    const onSubmit = vi.fn();
    renderDialog({ client, onSubmit });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // The caller strips it, but the dialog must not require it either: sending
    // `environment` to the update endpoint is what produced the bare 400.
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Testing' }));
  });
});
