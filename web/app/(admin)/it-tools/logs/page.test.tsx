import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '@/lib/format';

import ClientErrorLogPage from './page';

/**
 * The error log on the console's design system (console-development): a failed
 * request is said, not drawn as "Nothing reported yet", and times are Texas
 * time like every other screen.
 */
const hooks = vi.hoisted(() => ({
  useClientErrors: vi.fn(),
  useClientErrorSummary: vi.fn(),
}));

vi.mock('@/lib/queries', () => hooks);

// 03:30 UTC on the 10th is 10:30 PM on the 9th in Texas.
const RECEIVED = '2026-10-10T03:30:00.000Z';

const REPORT = {
  id: 'report-1',
  source: 'MOBILE',
  fatal: true,
  message: 'Upload stalled',
  context: 'area-upload',
  platform: 'android',
  appVersion: '1.4.0',
  buildId: 'build-7',
  apiBaseUrl: 'https://api.example.test',
  receivedAt: RECEIVED,
  occurredAt: RECEIVED,
  installId: 'install-1',
  authUserId: null,
  stack: null,
};

beforeEach(() => {
  hooks.useClientErrorSummary.mockReturnValue({
    isLoading: false,
    data: { lastDay: 3, fatalLastDay: 1, mobileLastDay: 2, consoleLastDay: 1 },
  });
});

describe('the error log', () => {
  it('says the reports could not be loaded instead of "nothing reported"', () => {
    hooks.useClientErrors.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error('The log could not be read.'),
      data: undefined,
      refetch: vi.fn(),
    });
    render(<ClientErrorLogPage />);

    expect(screen.getByText('This data could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing reported/)).toBeNull();
  });

  it('prints when a report arrived in Texas time', () => {
    hooks.useClientErrors.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { items: [REPORT] },
    });
    render(<ClientErrorLogPage />);

    const texas = formatDateTime(RECEIVED);
    expect(texas).toMatch(/^Oct 9, 2026/);
    expect(screen.getByText(texas)).toBeInTheDocument();
  });

  it('opens a report from a real button that says whether it is open', () => {
    hooks.useClientErrors.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { items: [REPORT] },
    });
    render(<ClientErrorLogPage />);

    const toggle = screen.getByRole('button', { name: 'Show details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('https://api.example.test')).toBeInTheDocument();
  });

  it('filters to crashes with a toggle that says whether it is on', () => {
    hooks.useClientErrors.mockReturnValue({ isLoading: false, isError: false, data: { items: [] } });
    render(<ClientErrorLogPage />);

    const crashesOnly = screen.getByRole('button', { name: 'Crashes only' });
    expect(crashesOnly).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(crashesOnly);
    expect(crashesOnly).toHaveAttribute('aria-pressed', 'true');
    expect(hooks.useClientErrors).toHaveBeenLastCalledWith(
      expect.objectContaining({ fatalOnly: true }),
    );
  });
});
