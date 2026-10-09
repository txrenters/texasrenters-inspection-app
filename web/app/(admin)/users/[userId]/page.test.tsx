import { render, screen } from '@testing-library/react';
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
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ userId: 'user-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null, data: undefined };

beforeEach(() => {
  hooks.useUser.mockReturnValue({
    isError: false,
    data: {
      id: 'user-1',
      displayName: 'Sam Example',
      email: 'sam@example.test',
      createdAt: '2026-09-01T15:00:00.000Z',
      isActive: true,
      isSystemAdmin: false,
      permissions: ['inspections:read'],
      customRoles: [],
    },
  });
  hooks.useAccessMutations.mockReturnValue({
    setUserRoles: idle,
    updateUserStatus: idle,
    deleteUser: idle,
    grantTechnicianAccess: idle,
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
