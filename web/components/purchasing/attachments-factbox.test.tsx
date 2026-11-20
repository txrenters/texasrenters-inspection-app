import { DEFAULT_FILE_RULES, type RequisitionDetail, type RequisitionFile } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentsFactBox } from './attachments-factbox';

/** The Attachments FactBox (2026-11-20, part 3). Every file, person and size invented. */

const hooks = vi.hoisted(() => ({ useRequisitionFiles: vi.fn(), openRequisitionFile: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const file = (n: number, over: Partial<RequisitionFile> = {}): RequisitionFile => ({
  id: `file-${n}`,
  fileName: `Quote ${n}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 182_000,
  attachedBy: { id: 'user-1', name: 'Sample Requester', code: 'SREQUESTER' },
  attachedAt: '2026-11-19T15:00:00.000Z',
  forVendor: false,
  canRemove: true,
  ...over,
});
/** Only what the FactBox reads of a requisition. */
// The office's rules as they were before Purchasing Setup (2026-11-20): every kind, 20 MB, 20 files.
const requisition = (files: RequisitionFile[], attach = true) => ({ id: 'req-12', files, can: { attach }, settings: { steps: [], files: DEFAULT_FILE_RULES } }) as unknown as RequisitionDetail;
const pdf = (name: string, size = 1000) => {
  const chosen = new File(['%PDF-1.7'], name, { type: 'application/pdf' });
  Object.defineProperty(chosen, 'size', { value: size });
  return chosen;
};

let files: { attach: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }; setForVendor: { mutate: ReturnType<typeof vi.fn>; isPending: boolean }; remove: { mutate: ReturnType<typeof vi.fn>; isPending: boolean } };

beforeEach(() => {
  files = {
    attach: { mutateAsync: vi.fn(async () => ({})), isPending: false },
    setForVendor: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  };
  hooks.useRequisitionFiles.mockReturnValue(files);
  hooks.openRequisitionFile.mockReset();
  hooks.openRequisitionFile.mockResolvedValue('opened');
});

describe('the Attachments FactBox', () => {
  it('says to save first while the requisition has nowhere to keep a file', () => {
    render(<AttachmentsFactBox />);
    expect(screen.getByRole('region', { name: 'Attachments' })).toBeTruthy();
    expect(screen.getByText('Save the requisition first, then attach pictures or files to it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach…' })).toBeNull();
  });

  it('lists each file with its kind, size and who attached it; only whoever may take one off sees the cross', () => {
    render(<AttachmentsFactBox requisition={requisition([file(1), file(2, { fileName: 'December filter list.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 36_000, canRemove: false })])} />);
    const box = screen.getByRole('region', { name: 'Attachments (2)' });
    const rows = within(within(box).getByRole('list', { name: 'Attached files' })).getAllByRole('listitem');

    expect(within(rows[0]!).getByText('PDF')).toBeTruthy();
    expect(within(rows[0]!).getByText(/182 KB · SREQUESTER/)).toBeTruthy();
    expect(within(rows[1]!).getByText('XLSX')).toBeTruthy();
    expect(within(rows[1]!).getByText(/36 KB/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take Quote 1.pdf off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take December filter list.xlsx off' })).toBeNull();
  });

  it('ticks a file to go to the vendor, takes one off, and opens one by its name', async () => {
    render(<AttachmentsFactBox requisition={requisition([file(1)])} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Send Quote 1.pdf to the vendor with the PO' }));
    expect(files.setForVendor.mutate).toHaveBeenCalledWith({ fileId: 'file-1', forVendor: true }, expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Take Quote 1.pdf off' }));
    expect(files.remove.mutate).toHaveBeenCalledWith('file-1', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Quote 1.pdf' }));
    await waitFor(() => expect(hooks.openRequisitionFile).toHaveBeenCalledWith('req-12', 'file-1'));
  });

  it('attaches what is chosen one file after another', async () => {
    render(<AttachmentsFactBox requisition={requisition([])} />);
    const first = pdf('Quote.pdf');
    const second = pdf('Spec sheet.pdf');

    fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [first, second] } });

    await waitFor(() => expect(files.attach.mutateAsync).toHaveBeenCalledTimes(2));
    expect(files.attach.mutateAsync.mock.calls.map(([call]) => (call as { file: File }).file.name)).toEqual(['Quote.pdf', 'Spec sheet.pdf']);
  });

  it('takes a file dropped on it', async () => {
    render(<AttachmentsFactBox requisition={requisition([])} />);
    fireEvent.drop(screen.getByTestId('attachments-drop'), { dataTransfer: { files: [pdf('Shelf.pdf')] } });
    await waitFor(() => expect(files.attach.mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('refuses, before sending anything, a file past 20 MB or more files than there is room for', () => {
    render(<AttachmentsFactBox requisition={requisition(Array.from({ length: 19 }, (_, n) => file(n)))} />);

    fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [pdf('Video.pdf', 25_000_000)] } });
    expect(screen.getByText('Video.pdf is 25 MB; a file is at most 20 MB.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [pdf('a.pdf'), pdf('b.pdf')] } });
    expect(screen.getByText('Only 1 more file fits: a requisition holds at most 20.')).toBeTruthy();
    expect(files.attach.mutateAsync).not.toHaveBeenCalled();
  });

  it('says what the API refused, and stops there', async () => {
    files.attach.mutateAsync.mockRejectedValueOnce(new Error('Attach a PDF, a picture (JPG, PNG or HEIC), or a Word or Excel file.'));
    render(<AttachmentsFactBox requisition={requisition([])} />);

    fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [pdf('notes.pdf'), pdf('second.pdf')] } });

    expect(await screen.findByText('notes.pdf: Attach a PDF, a picture (JPG, PNG or HEIC), or a Word or Excel file.')).toBeTruthy();
    expect(files.attach.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('warns when what is ticked for the vendor will not fit one email', () => {
    render(<AttachmentsFactBox requisition={requisition([file(1, { forVendor: true, sizeBytes: 1_800_000 }), file(2, { forVendor: true, sizeBytes: 1_200_000 })])} />);
    expect(screen.getByText(/Ticked for the vendor: 3 MB. One email carries 2.5 MB beside the PDF/)).toBeTruthy();
  });

  it('once the requisition is finished with, shows its files and takes no more', () => {
    render(<AttachmentsFactBox requisition={requisition([file(1, { canRemove: false })], false)} />);

    expect(screen.getByText('This requisition is finished with, so nothing more is attached to it.')).toBeTruthy();
    expect(screen.queryByLabelText('Choose files to attach')).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Send Quote 1.pdf to the vendor with the PO' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
