import { fireEvent, render, screen } from '@testing-library/react';
import { MAX_EXCEL_OFFICE_ROWS_A_DAY, type ExcelSyncView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDay } from '@/lib/format';

import { ExcelSyncDialog, pullWords, refusedWords } from './excel-sync-dialog';

/** The office's own workbook in Excel (2026-11-17). Everything invented. */

const edits = vi.hoisted(() => ({
  view: null as unknown,
  connect: vi.fn(),
  save: vi.fn(),
  sync: vi.fn(),
  formulas: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('@/lib/actual-vs-budget-queries', () => ({
  useExcelSync: () => ({ isPending: false, isError: false, data: edits.view, refetch: vi.fn() }),
  useExcelSyncEdits: () => ({
    connect: { mutateAsync: edits.connect, isPending: false },
    save: { mutate: edits.save, isPending: false },
    sync: { mutate: edits.sync, isPending: false },
    formulas: { mutate: edits.formulas, isPending: false },
    disconnect: { mutate: edits.disconnect, isPending: false },
  }),
}));

const view = (over: Partial<ExcelSyncView> = {}): ExcelSyncView => ({
  configured: true,
  redirectUri: 'https://api.example.test/callback',
  connection: { status: 'CONNECTED', accountEmail: 'office@example.com', accountName: 'Office', connectedAt: '2026-11-17T15:00:00.000Z', problem: null },
  workbook: {
    shareUrl: 'https://example.sharepoint.com/:x:/p/someone/abc',
    fileName: 'Actual Vs Budget.xlsx',
    webUrl: null,
    enabled: true,
    startDate: '2026-11-18',
    lastPushedAt: null,
    lastPull: null,
    waiting: false,
    problem: null,
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  edits.view = view();
});

describe('the Excel dialog', () => {
  it('opens Microsoft in a tab of its own to connect the account', async () => {
    edits.view = view({ connection: null, workbook: null });
    edits.connect.mockResolvedValue({ authorizationUrl: 'https://login.example.test/authorize' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect((screen.getByLabelText('Workbook link') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('https://login.example.test/authorize', '_blank', 'noopener,noreferrer'));
  });

  it('saves a new link only once it is changed', () => {
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('office@example.com')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Workbook link'), { target: { value: ' https://example.sharepoint.com/:x:/p/someone/other ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(edits.save).toHaveBeenCalledWith({ shareUrl: 'https://example.sharepoint.com/:x:/p/someone/other' }, expect.anything());
  });

  it('turns the sync off, and writes now on request', () => {
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('Not written yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch'));
    expect(edits.save).toHaveBeenCalledWith({ enabled: false }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Write now' }));
    expect(edits.sync).toHaveBeenCalled();
  });

  it('fixes the formulas in Excel with the sync off too (2026-11-18)', () => {
    edits.view = view({ workbook: { ...view().workbook!, enabled: false } });
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect((screen.getByRole('button', { name: 'Write now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Fix formulas' }));
    expect(edits.formulas).toHaveBeenCalled();
  });

  it("says what went wrong on the workbook, and asks for a sign-in Microsoft refused", () => {
    edits.view = view({
      connection: { status: 'REAUTHORIZATION_REQUIRED', accountEmail: 'office@example.com', accountName: null, connectedAt: null, problem: null },
      workbook: { ...view().workbook!, problem: 'The account cannot edit the workbook: share it as Can edit.' },
    });
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('Sign in again')).toBeTruthy();
    expect(screen.getByText('The account cannot edit the workbook: share it as Can edit.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Write now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when the server has no Microsoft app', () => {
    edits.view = view({ configured: false });
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('The server has no Microsoft app settings yet.')).toBeTruthy();
  });
});

describe("the last read of the office's Excel edits", () => {
  it('says what came in, what was left as in Excel, and where both changed', () => {
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(pullWords({ at, taken: 3, putBack: 0, conflicts: 0, kept: 1 })).toMatch(/^Read from Excel .+: 3 cells taken, 1 cell left as in Excel$/);
    expect(pullWords({ at, taken: 1, putBack: 0, conflicts: 2 })).toMatch(/: 1 cell taken, 2 cells changed in both: Excel's kept$/);
    // A read from before v2.5.252 still says what it put back.
    expect(pullWords({ at, taken: 0, putBack: 173, conflicts: 0 })).toMatch(/: 0 cells taken, 173 cells put back$/);
  });

  it('shows under the last write', () => {
    edits.view = view({ workbook: { ...view().workbook!, lastPushedAt: new Date().toISOString(), lastPull: { at: new Date().toISOString(), taken: 2, putBack: 0, conflicts: 0 } } });
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText(/2 cells taken/)).toBeTruthy();
    expect(screen.queryByText(/left in Excel only/)).toBeNull();
  });

  it("names the office's rows it left in Excel only, and why (2026-11-23: the same rows once came in on every run)", () => {
    const at = new Date().toISOString();
    const pull = {
      at,
      taken: 0,
      putBack: 0,
      conflicts: 0,
      refused: 3,
      refusedRows: [
        { tab: 'Moses', date: '2026-11-23', row: 'Job# 20504', why: 'ALREADY_IN_CONSOLE' as const },
        { tab: 'Amy', date: '2026-11-23', row: 'Supply run', why: 'DAY_FULL' as const },
      ],
    };
    expect(refusedWords(pull)).toBe(
      `3 rows left in Excel only: Moses ${formatDay('2026-11-23')}, Job# 20504 (the console has it already); Amy ${formatDay('2026-11-23')}, Supply run (the day holds ${MAX_EXCEL_OFFICE_ROWS_A_DAY} rows already); 1 more`,
    );
    expect(refusedWords({ at, taken: 1, putBack: 0, conflicts: 0 })).toBeNull();

    edits.view = view({ workbook: { ...view().workbook!, lastPushedAt: at, lastPull: pull } });
    render(<ExcelSyncDialog canManage onClose={() => undefined} />);
    expect(screen.getByText(/^3 rows left in Excel only/).className).toContain('text-warning');
  });
});
