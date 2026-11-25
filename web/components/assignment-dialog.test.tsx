import type { AdminAssignment } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentDialog } from './assignment-dialog';

/**
 * Who did a finished visit, corrected (the office, 2026-11-25: "it says Kevin
 * but we should have an option to replace it, like Moses"). People invented.
 */

const mutation = () => ({ mutateAsync: vi.fn(), isPending: false, error: null as Error | null });
const mutations = vi.hoisted(() => ({}) as Record<'assign' | 'reassign' | 'changeDoneTechnician', ReturnType<typeof mutation>>);

vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => mutations,
  useTechnicians: () => ({
    isLoading: false,
    data: {
      items: [
        { id: 'tech-jordan', displayName: 'Jordan Field', workload: { current: 4 } },
        { id: 'tech-taylor', displayName: 'Taylor Field', workload: { current: 2 } },
      ],
    },
  }),
}));

beforeEach(() => {
  mutations.assign = mutation();
  mutations.reassign = mutation();
  mutations.changeDoneTechnician = mutation();
  for (const each of Object.values(mutations)) each.mutateAsync.mockResolvedValue({});
});

const jordan = {
  id: 'assignment-1',
  technicianId: 'tech-jordan',
  isCurrent: true,
  technician: { id: 'tech-jordan', displayName: 'Jordan Field' },
} as unknown as AdminAssignment;

function pick(name: string) {
  fireEvent.keyDown(screen.getByLabelText('Who did it'), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('changing who did a finished visit', () => {
  it('says the visit is done, nobody is told and Jobber follows', () => {
    render(<AssignmentDialog afterVisit current={jordan} inspectionId="inspection-1" onClose={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Change technician' })).toBeTruthy();
    expect(screen.getByText(/This visit is done and shows/).textContent).toContain('Jordan Field');
    expect(screen.getByText(/Nobody is notified, and Jobber.s visit is changed to match/)).toBeTruthy();
  });

  it('offers everyone but the technician already on it, without their open work', () => {
    render(<AssignmentDialog afterVisit current={jordan} inspectionId="inspection-1" onClose={() => {}} />);
    fireEvent.keyDown(screen.getByLabelText('Who did it'), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Taylor Field' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Jordan Field/ })).toBeNull();
  });

  it('needs a reason before it changes anything', () => {
    render(<AssignmentDialog afterVisit current={jordan} inspectionId="inspection-1" onClose={() => {}} />);
    pick('Taylor Field');
    const save = screen.getByRole('button', { name: 'Change technician' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Taylor went' } });
    expect(save.disabled).toBe(false);
  });

  it('sends the correction, not a reassignment', async () => {
    const onClose = vi.fn();
    render(<AssignmentDialog afterVisit current={jordan} inspectionId="inspection-1" onClose={onClose} />);
    pick('Taylor Field');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Taylor went, per the office  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change technician' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutations.changeDoneTechnician.mutateAsync).toHaveBeenCalledWith({
      id: 'inspection-1',
      technicianId: 'tech-taylor',
      reason: 'Taylor went, per the office',
    });
    expect(mutations.reassign.mutateAsync).not.toHaveBeenCalled();
    expect(mutations.assign.mutateAsync).not.toHaveBeenCalled();
  });

  it('stays open and says why when the server refuses', async () => {
    mutations.changeDoneTechnician.error = new Error('This visit is not done yet. Use Reassign to send someone else.');
    mutations.changeDoneTechnician.mutateAsync.mockRejectedValue(mutations.changeDoneTechnician.error);
    const onClose = vi.fn();
    render(<AssignmentDialog afterVisit current={jordan} inspectionId="inspection-1" onClose={onClose} />);
    expect(screen.getByText(/not done yet/)).toBeTruthy();
    pick('Taylor Field');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Taylor went' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change technician' }));
    await waitFor(() => expect(mutations.changeDoneTechnician.mutateAsync).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('names a finished visit that has nobody on it, and the job on the same visit', () => {
    render(<AssignmentDialog afterVisit bookedWith="HVAC" inspectionId="inspection-1" onClose={() => {}} />);
    expect(screen.getByText(/This visit is done and shows no technician/)).toBeTruthy();
    expect(screen.getByText('The HVAC inspection on the same Jobber visit changes with it, once it is done.')).toBeTruthy();
  });
});

describe('reassigning a visit still to come', () => {
  it('is unchanged: an optional note, the workload shown, and the reassign call', async () => {
    const onClose = vi.fn();
    render(<AssignmentDialog current={jordan} inspectionId="inspection-1" onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText('Technician'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Taylor Field · 2 current' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutations.reassign.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'inspection-1', technicianId: 'tech-taylor', reason: undefined }),
    );
    expect(mutations.changeDoneTechnician.mutateAsync).not.toHaveBeenCalled();
  });
});
