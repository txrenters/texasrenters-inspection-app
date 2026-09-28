import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DemoPropertyDeleteDialog } from './demo-property-delete-dialog';

const mutation = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue({}),
  isPending: false,
  error: null as { message: string } | null,
}));
vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({ deleteDemoProperty: mutation }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }),
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const onClose = vi.fn();

function mount(inspectionCount: number, redirectTo?: string) {
  return render(
    <DemoPropertyDeleteDialog
      onClose={onClose}
      property={{ id: 'demo-1', name: 'Demo Property 1', inspectionCount }}
      redirectTo={redirectTo}
    />,
  );
}

const deleteButton = () => screen.getByRole('button', { name: 'Delete permanently' });

beforeEach(() => {
  mutation.mutateAsync.mockClear().mockResolvedValue({});
  mutation.isPending = false;
  mutation.error = null;
  permissions.granted = new Set();
  router.replace.mockClear();
  onClose.mockClear();
});

/**
 * The confirmation is proportionate to what is actually being destroyed.
 *
 * A demo property nobody walked holds a row, an address and fifteen guessed
 * rooms. Making somebody type its name to delete that teaches them to type
 * names without reading, which is the habit that makes the *inspection*
 * dialog's confirmation worthless. The moment it holds an inspection it is a
 * different act, and the name is required exactly then.
 */
describe('deleting a demo property nobody has walked', () => {
  it('deletes on one press, with nothing to type', () => {
    mount(0);
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
    expect(deleteButton().hasAttribute('disabled')).toBe(false);
  });

  it('says plainly that nothing real is at stake', () => {
    mount(0);
    expect(screen.getByText(/no recordings or reports to lose/)).toBeTruthy();
  });

  it('closes itself rather than navigating, so filters survive', async () => {
    // Called from the list, which is not *about* the deleted property.
    mount(0);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(mutation.mutateAsync).toHaveBeenCalledWith('demo-1'));
    expect(router.replace).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('leaves the page it is about, when it is called from that page', async () => {
    mount(0, '/properties');
    fireEvent.click(deleteButton());

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/properties'));
  });
});

describe('deleting one that holds a demonstration', () => {
  beforeEach(() => {
    permissions.granted = new Set(['inspections:delete']);
  });

  it('will not delete until the name is typed', () => {
    mount(2);
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
  });

  it('enumerates what goes, rather than summarising it', () => {
    mount(2);
    expect(screen.getByText('This cannot be undone')).toBeTruthy();
    expect(screen.getByText(/All 2 of its inspections are deleted/)).toBeTruthy();
    expect(screen.getByText(/Cloudflare Stream/)).toBeTruthy();
  });

  it('accepts the name whatever case it is typed in', async () => {
    mount(1);
    fireEvent.change(screen.getByLabelText(/to confirm/), {
      target: { value: '  demo property 1 ' },
    });

    await waitFor(() => expect(deleteButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(deleteButton());
    await waitFor(() => expect(mutation.mutateAsync).toHaveBeenCalledWith('demo-1'));
  });

  it('refuses a different demo property’s name', () => {
    // The mistake this exists for: several demo properties, and the wrong one
    // about to go.
    mount(1);
    fireEvent.change(screen.getByLabelText(/to confirm/), {
      target: { value: 'Demo Property 2' },
    });
    expect(deleteButton().hasAttribute('disabled')).toBe(true);
  });
});

describe('when the reader cannot erase inspections', () => {
  it('offers no delete button at all, and says why', () => {
    // `properties:manage` is not a way around `inspections:delete`. A disabled
    // button with no explanation would send somebody to support.
    mount(2);

    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    expect(screen.getByText(/It holds 2 inspections/)).toBeTruthy();
    expect(screen.getByText(/inspections:delete/)).toBeTruthy();
  });

  it('still deletes a clean demo property', () => {
    // The permission only gates the cascade. Somebody who created a demo
    // property must be able to remove it again.
    mount(0);
    expect(deleteButton().hasAttribute('disabled')).toBe(false);
  });

  it('counts one inspection in the singular', () => {
    mount(1);
    expect(screen.getByText('It holds an inspection')).toBeTruthy();
  });
});

describe('when the request fails', () => {
  it('keeps the dialog open with the server’s reason on screen', async () => {
    mutation.mutateAsync.mockRejectedValue(new Error('Something still references this.'));
    mutation.error = { message: 'Something still references this.' };
    mount(0);
    fireEvent.click(deleteButton());

    await waitFor(() => expect(screen.getByText('Something still references this.')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
