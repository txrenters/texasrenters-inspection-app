import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TechnicianDetailPage from './page';

/**
 * Editing a technician's profile (2026-10-14). One account with the user page,
 * so an account that also signs in to the console keeps its email out of reach
 * of somebody who only manages technicians -- the server refuses it too
 * (`AccountProfileService`); the page says so before anybody types.
 */
const hooks = vi.hoisted(() => ({
  useTechnician: vi.fn(),
  useAssignments: vi.fn(),
  useTechnicianRoute: vi.fn(),
  useAdminMutations: vi.fn(),
  useAccountDeletionPreflight: vi.fn(),
}));
const access = vi.hoisted(() => ({ granted: new Set<string>() }));

vi.mock('@/lib/queries', () => hooks);
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => access.granted.has(permission) }),
  useAuth: () => ({ profile: { id: 'admin-1' }, refresh: vi.fn() }),
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [{ page: 1 }, vi.fn(), vi.fn()] }));
vi.mock('@/components/technician-route-card', () => ({ TechnicianRouteCard: () => null }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ technicianId: 'tech-1' }),
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
  id: 'tech-1',
  displayName: 'Smauel Upchurch',
  email: 'sam@texasrenters.com',
  phone: '+17135550100',
  isActive: true,
  createdAt: '2026-08-25T21:00:00.000Z',
  hasConsoleAccess: false,
  workload: { current: 2, inProgress: 1, completed: 40 },
};

beforeEach(() => {
  access.granted = new Set(['technicians:manage', 'technicians:provision', 'users:manage', 'users:read']);
  hooks.useTechnician.mockReturnValue({ isError: false, data: SAM });
  hooks.useAssignments.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 },
  });
  hooks.useTechnicianRoute.mockReturnValue({ isError: false, data: undefined });
  hooks.useAdminMutations.mockReturnValue({
    updateTechnician: idle,
    updateTechnicianProfile: idle,
    deleteTechnician: idle,
    sendTechnicianPasswordReset: idle,
    grantTechnicianConsoleAccess: idle,
  });
  hooks.useAccountDeletionPreflight.mockReturnValue({ isLoading: false, data: undefined });
});

function openMenu() {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  });
}

describe('the profile on a technician', () => {
  it('shows the phone number as a link to call', () => {
    render(<TechnicianDetailPage />);

    expect(screen.getByRole('link', { name: '(713) 555-0100' })).toHaveAttribute(
      'href',
      'tel:+17135550100',
    );
  });

  it('opens the editor with the saved details, the email open to change', () => {
    render(<TechnicianDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Full name')).toHaveValue('Smauel Upchurch');
    expect(screen.getByLabelText('Sign-in email')).toBeEnabled();
    expect(screen.getByLabelText('Phone (optional)')).toHaveValue('(713) 555-0100');
  });

  it('keeps the email of a console user to whoever manages users', () => {
    access.granted = new Set(['technicians:manage']);
    hooks.useTechnician.mockReturnValue({
      isError: false,
      data: { ...SAM, hasConsoleAccess: true },
    });
    render(<TechnicianDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Sign-in email')).toBeDisabled();
    expect(screen.getByText(/only someone who manages users can change this/)).toBeInTheDocument();
  });

  it('lets somebody who manages users change that email', () => {
    hooks.useTechnician.mockReturnValue({
      isError: false,
      data: { ...SAM, hasConsoleAccess: true },
    });
    render(<TechnicianDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(screen.getByLabelText('Sign-in email')).toBeEnabled();
  });

  it('has no editor for somebody who cannot manage technicians', () => {
    access.granted = new Set(['technicians:provision']);
    render(<TechnicianDetailPage />);

    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  });

  it('links to the user page instead of offering access they already have', () => {
    hooks.useTechnician.mockReturnValue({
      isError: false,
      data: { ...SAM, hasConsoleAccess: true },
    });
    render(<TechnicianDetailPage />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Open user page' })).toHaveAttribute(
      'href',
      '/users/tech-1',
    );
    expect(screen.queryByRole('menuitem', { name: 'Grant console access…' })).toBeNull();
  });

  it('offers console access to a technician who has none', () => {
    render(<TechnicianDetailPage />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Grant console access…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open user page' })).toBeNull();
  });
});
