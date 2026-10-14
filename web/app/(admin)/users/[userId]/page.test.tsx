import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserDetailPage from './page';

/**
 * A failed list is not an empty one (console-development).
 *
 * The role picker said "No custom roles exist yet." whenever the roles request
 * failed, which sent administrators off to create roles that already existed.
 */
const hooks = vi.hoisted(() => ({
  useUser: vi.fn(),
  useRoles: vi.fn(),
  useAccessMutations: vi.fn(),
  useAccountDeletionPreflight: vi.fn(),
}));

vi.mock('@/lib/queries', () => hooks);
const auth = vi.hoisted(() => ({ me: { id: 'admin-1' } as { id: string } | null }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => true }),
  useAuth: () => ({ profile: auth.me, refresh: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'user-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const idle = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  error: null,
  data: undefined,
};

const SAM = {
  id: 'user-1',
  displayName: 'Sam Example',
  email: 'sam@example.test',
  createdAt: '2026-09-01T15:00:00.000Z',
  isActive: true,
  isSystemAdmin: false,
  permissions: ['inspections:read'],
  customRoles: [],
};

beforeEach(() => {
  auth.me = { id: 'admin-1' };
  hooks.useUser.mockReturnValue({ isError: false, data: SAM });
  hooks.useAccessMutations.mockReturnValue({
    setUserRoles: idle,
    updateUserStatus: idle,
    deleteUser: idle,
    grantTechnicianAccess: idle,
    updateUserProfile: idle,
    sendUserPasswordReset: idle,
  });
  hooks.useAccountDeletionPreflight.mockReturnValue({ isLoading: false, data: undefined });
});

describe('the role assignment on a user', () => {
  it('says the roles could not be loaded, rather than that none exist', () => {
    hooks.useRoles.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('The roles service is down.'),
      data: undefined,
      refetch: vi.fn(),
    });
    render(<UserDetailPage />);

    expect(screen.getByText('This data could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The roles service is down.')).toBeInTheDocument();
    expect(screen.queryByText('No custom roles exist yet.')).toBeNull();
  });

  it('still says so when the list really is empty', () => {
    hooks.useRoles.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { items: [], total: 0, page: 1, pageSize: 100, totalPages: 1 },
    });
    render(<UserDetailPage />);

    expect(screen.getByText('No custom roles exist yet.')).toBeInTheDocument();
  });

  it('puts the account status beside the name and keeps the rarer actions in one menu', () => {
    hooks.useRoles.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { items: [], total: 0, page: 1, pageSize: 100, totalPages: 1 },
    });
    render(<UserDetailPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Sam Example' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    // Delete is in the menu, not a second red button beside Deactivate.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

/**
 * Editing a person's profile and sending them a reset link, from the user page
 * (2026-10-14). Before, the rename existed only as an endpoint nothing called.
 */
describe('the profile on a user', () => {
  const emptyRoles = {
    isLoading: false,
    isError: false,
    data: { items: [], total: 0, page: 1, pageSize: 100, totalPages: 1 },
  };

  function openMenu() {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });
  }

  it('shows the phone number as a link to call', () => {
    hooks.useRoles.mockReturnValue(emptyRoles);
    hooks.useUser.mockReturnValue({
      isError: false,
      data: { ...SAM, phone: '+17135550100' },
    });
    render(<UserDetailPage />);

    expect(screen.getByRole('link', { name: '(713) 555-0100' })).toHaveAttribute(
      'href',
      'tel:+17135550100',
    );
  });

  it('opens the editor with the saved details', () => {
    hooks.useRoles.mockReturnValue(emptyRoles);
    render(<UserDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Full name')).toHaveValue('Sam Example');
    expect(screen.getByLabelText('Sign-in email')).toHaveValue('sam@example.test');
    expect(screen.getByLabelText('Sign-in email')).toBeEnabled();
  });

  it('keeps an administrator from moving their own sign-in email', () => {
    hooks.useRoles.mockReturnValue(emptyRoles);
    auth.me = { id: 'user-1' };
    render(<UserDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Sign-in email')).toBeDisabled();
    expect(screen.getByText(/can’t change your own sign-in email/)).toBeInTheDocument();
  });

  it('offers a password reset from the menu', () => {
    hooks.useRoles.mockReturnValue(emptyRoles);
    render(<UserDetailPage />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Send password reset…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Grant mobile access…' })).toBeInTheDocument();
  });

  it('links to the technician page instead of offering access they already have', () => {
    hooks.useRoles.mockReturnValue(emptyRoles);
    hooks.useUser.mockReturnValue({
      isError: false,
      data: { ...SAM, hasTechnicianAccess: true },
    });
    render(<UserDetailPage />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Open technician page' })).toHaveAttribute(
      'href',
      '/technicians/user-1',
    );
    expect(screen.queryByRole('menuitem', { name: 'Grant mobile access…' })).toBeNull();
  });
});
