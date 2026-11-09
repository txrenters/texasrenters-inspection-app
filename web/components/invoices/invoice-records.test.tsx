import { fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_CLIENT_VIEW, DEFAULT_EMAIL_TEMPLATES, type InvoiceDetail, type InvoiceExtraDetails } from '@texasrenters/shared';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailTemplatesSection } from './email-templates-section';
import { ClientViewFields, InvoiceFilesCard, InvoiceNotesCard } from './invoice-records';

/**
 * The invoice itself (2026-11-10, phase 4 of the invoice gap review): notes
 * and files written in the console beside Jobber's, what the client sees, and
 * the office's email words. Everything invented.
 */

const records = vi.hoisted(() => ({
  addNote: { mutate: vi.fn(), isPending: false },
  removeNote: { mutate: vi.fn(), isPending: false },
  addFile: { mutate: vi.fn(), isPending: false },
  removeFile: { mutate: vi.fn(), isPending: false },
}));
const words = vi.hoisted(() => ({ view: null as unknown, save: { mutate: vi.fn(), isPending: false } }));
vi.mock('@/lib/invoice-record-queries', () => ({
  useInvoiceRecords: () => records,
  useEmailTemplates: () => ({ isLoading: false, data: words.view }),
  useSaveEmailTemplates: () => words.save,
}));
vi.mock('@/lib/invoice-files', () => ({ openInvoiceFile: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const INVOICE = {
  id: 'inv-1',
  details: {
    notes: [
      { id: 'n2', kind: 'INVOICE', message: 'Called the owner.', pinned: false, writtenAt: '2026-11-09T15:00:00.000Z', origin: 'CONSOLE', author: 'Ada Lane' },
      { id: 'n1', kind: 'JOB', message: 'WO submitted', pinned: false, writtenAt: '2026-11-05T15:00:00.000Z', origin: 'JOBBER', author: null },
    ],
    files: [
      { id: 'f2', fileName: 'After.jpg', contentType: 'image/jpeg', sizeBytes: 2048, url: null, uploadedAt: '2026-11-09T15:00:00.000Z', kept: true, copyProblem: null, origin: 'CONSOLE' },
      { id: 'f1', fileName: 'Before.jpg', contentType: 'image/jpeg', sizeBytes: 1024, url: 'https://files.example.com/f1', uploadedAt: '2026-11-01T15:00:00.000Z', kept: true, copyProblem: null, origin: 'JOBBER' },
    ],
  } as unknown as InvoiceExtraDetails,
} as InvoiceDetail;

beforeEach(() => {
  vi.clearAllMocks();
  words.view = { templates: DEFAULT_EMAIL_TEMPLATES, replyTo: null, companyEmail: 'office@example.com', updatedAt: '2026-11-09T15:00:00.000Z' };
});

describe('notes', () => {
  it("lists Jobber's and the office's, and takes off only the office's", () => {
    render(<InvoiceNotesCard invoice={INVOICE} mayWrite />);
    const notes = within(screen.getByRole('list', { name: 'Notes' })).getAllByRole('listitem');
    expect(notes[0]).toHaveTextContent('Ada Lane');
    expect(within(notes[0]!).getByRole('button', { name: 'Take the note off' })).toBeInTheDocument();
    expect(within(notes[1]!).queryByRole('button', { name: 'Take the note off' })).not.toBeInTheDocument();
    fireEvent.click(within(notes[0]!).getByRole('button', { name: 'Take the note off' }));
    expect(records.removeNote.mutate).toHaveBeenCalledWith('n2', expect.anything());
  });

  it('adds one, for whoever makes invoices only', () => {
    const { unmount } = render(<InvoiceNotesCard invoice={INVOICE} mayWrite />);
    fireEvent.change(screen.getByLabelText('A note'), { target: { value: 'Owner pays on the 15th.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(records.addNote.mutate).toHaveBeenCalledWith('Owner pays on the 15th.', expect.anything());
    unmount();

    render(<InvoiceNotesCard invoice={INVOICE} mayWrite={false} />);
    expect(screen.queryByLabelText('A note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take the note off' })).not.toBeInTheDocument();
  });
});

describe('files', () => {
  it('adds a photo or a PDF, and takes off only one added here', () => {
    render(<InvoiceFilesCard invoice={INVOICE} mayWrite />);
    const photo = new File(['photo'], 'Gate.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Choose a file to add'), { target: { files: [photo] } });
    expect(records.addFile.mutate).toHaveBeenCalledWith(photo, expect.anything());

    const files = within(screen.getByRole('list', { name: 'Files' })).getAllByRole('listitem');
    expect(files[0]).toHaveTextContent('Added in the console');
    fireEvent.click(within(files[0]!).getByRole('button', { name: 'Take After.jpg off' }));
    expect(records.removeFile.mutate).toHaveBeenCalledWith('f2', expect.anything());
    expect(within(files[1]!).queryByRole('button', { name: /Take .* off/ })).not.toBeInTheDocument();
  });
});

describe('the client view', () => {
  function Harness() {
    const [view, setView] = useState(DEFAULT_CLIENT_VIEW);
    return (
      <>
        <ClientViewFields onChange={setView} value={view} />
        <output>{JSON.stringify(view)}</output>
      </>
    );
  }

  it("has Jobber's five switches, every one on to start with", () => {
    render(<Harness />);
    for (const name of ['Quantities', 'Unit prices', 'Line item totals', 'Account balance', 'Late stamp (if overdue)'])
      expect(screen.getByRole('switch', { name })).toBeChecked();
    fireEvent.click(screen.getByRole('switch', { name: 'Unit prices' }));
    expect(screen.getByRole('status')).toHaveTextContent('"showUnitPrices":false');
  });
});

describe('the email templates', () => {
  it('say what each can say, refuse a placeholder it does not know, and save against what was read', () => {
    render(<EmailTemplatesSection mayChange />);
    expect(screen.getByLabelText('Subject')).toHaveValue(DEFAULT_EMAIL_TEMPLATES.invoice.subject);
    expect(screen.getByText('{{balance_due}}')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{tenant_name}}' } });
    expect(screen.getByText('{{tenant_name}} is not something the invoice email knows.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save email templates' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{client_name}}, {{balance_due}} is due.' } });
    fireEvent.change(screen.getByLabelText('Replies go to'), { target: { value: 'billing@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email templates' }));
    const [input] = words.save.mutate.mock.calls[0]!;
    expect(input).toMatchObject({ replyTo: 'billing@example.com', expectedUpdatedAt: '2026-11-09T15:00:00.000Z' });
    expect(input.templates.invoice.message).toBe('Hi {{client_name}}, {{balance_due}} is due.');
    expect(input.templates.receipt).toEqual(DEFAULT_EMAIL_TEMPLATES.receipt);
  });

  it('send replies to the company email when none is chosen', () => {
    render(<EmailTemplatesSection mayChange={false} />);
    expect(screen.getByLabelText('Replies go to')).toHaveAttribute('placeholder', 'office@example.com');
    expect(screen.queryByRole('button', { name: 'Save email templates' })).not.toBeInTheDocument();
  });
});
