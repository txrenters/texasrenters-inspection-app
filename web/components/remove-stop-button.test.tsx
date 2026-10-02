import type { AssignedStop } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MAP_REMOVAL_REASON, RemoveStopButton } from './remove-stop-button';

/**
 * The "x" on a visit in the technician map's roster (the office, 2026-10-02).
 * It unassigns, and only where the API said that would stick.
 */

const stop = (over: Partial<AssignedStop> = {}): AssignedStop => ({
  inspectionId: 'inspection-1',
  buildingId: 'building-1',
  propertyName: '100 Example Way',
  inspectionType: 'MOVE_OUT',
  status: 'SCHEDULED',
  finishedAt: null,
  removable: true,
  notRemovableBecause: null,
  ...over,
});

describe('the x on a visit', () => {
  it('asks first, then takes the visit off the day with the reason given', async () => {
    const onRemove = vi.fn(async () => undefined);
    render(<RemoveStopButton onRemove={onRemove} stop={stop()} technicianName="A Technician" />);

    fireEvent.click(screen.getByRole('button', { name: "Take 100 Example Way off A Technician's day" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText(/stays booked for this day with nobody on it/)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue(MAP_REMOVAL_REASON), { target: { value: 'Tenant asked to move it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ inspectionId: 'inspection-1' }), 'Tenant asked to move it'));
  });

  it('keeps the visit when the reader changes their mind', () => {
    const onRemove = vi.fn(async () => undefined);
    render(<RemoveStopButton onRemove={onRemove} stop={stop()} technicianName="A Technician" />);

    fireEvent.click(screen.getByRole('button', { name: "Take 100 Example Way off A Technician's day" }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(onRemove).not.toHaveBeenCalled();
  });

  it('records the standard reason when the reason is cleared', async () => {
    const onRemove = vi.fn(async () => undefined);
    render(<RemoveStopButton onRemove={onRemove} stop={stop()} technicianName="A Technician" />);

    fireEvent.click(screen.getByRole('button', { name: "Take 100 Example Way off A Technician's day" }));
    fireEvent.change(screen.getByDisplayValue(MAP_REMOVAL_REASON), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith(expect.anything(), MAP_REMOVAL_REASON));
  });

  it('says why when the API refuses', async () => {
    const onRemove = vi.fn(async () => {
      throw new Error('The inspection is not assigned.');
    });
    render(<RemoveStopButton onRemove={onRemove} stop={stop()} technicianName="A Technician" />);

    fireEvent.click(screen.getByRole('button', { name: "Take 100 Example Way off A Technician's day" }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('The inspection is not assigned.')).toBeInTheDocument();
  });

  it('is greyed out, with the reason, on a Jobber visit the next sync would put back', () => {
    render(
      <RemoveStopButton
        onRemove={vi.fn()}
        stop={stop({ removable: false, notRemovableBecause: 'JOBBER_EDITS_OFF' })}
        technicianName="A Technician"
      />,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '100 Example Way cannot be taken off the day here' })).toHaveAttribute(
      'title',
      expect.stringMatching(/change it in Jobber/i),
    );
  });

  it('is not there at all for a visit already started, or from an API that does not say', () => {
    const { container, rerender } = render(
      <RemoveStopButton
        onRemove={vi.fn()}
        stop={stop({ removable: false, notRemovableBecause: 'STARTED', status: 'IN_PROGRESS' })}
        technicianName="A Technician"
      />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(
      <RemoveStopButton
        onRemove={vi.fn()}
        stop={stop({ removable: undefined, notRemovableBecause: undefined })}
        technicianName="A Technician"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
