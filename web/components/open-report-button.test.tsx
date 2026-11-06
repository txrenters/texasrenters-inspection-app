import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenReportButton } from './open-report-button';

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/queries', () => ({ useAdminMutations: () => ({ openReport: mutation }) }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

type Answer = { onSuccess: (data: { sharePath: string }) => void; onError: (error: Error) => void };

const press = () => {
  render(<OpenReportButton inspectionId="insp-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open report' }));
  return mutation.mutate.mock.calls[0]?.[1] as Answer;
};

beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = false;
  toastError.mockReset();
});

describe('Open report', () => {
  it('opens the tab on the click, then sends it to the report once the link is back', () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

    const answer = press();

    // Before any answer: a tab opened later is blocked as a popup.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(mutation.mutate.mock.calls[0]?.[0]).toBe('insp-1');
    answer.onSuccess({ sharePath: '/report/abc' });
    expect(tab.location.href).toBe('/report/abc');
  });

  it('closes the empty tab and says so when the report will not open', () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

    press().onError(new Error('Inspection was not found.'));

    expect(tab.close).toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('The report did not open', { description: 'Inspection was not found.' });
  });

  it('waits for the answer before it can be pressed again', () => {
    mutation.isPending = true;
    render(<OpenReportButton inspectionId="insp-1" />);
    expect(screen.getByRole('button', { name: 'Open report' })).toBeDisabled();
  });
});
