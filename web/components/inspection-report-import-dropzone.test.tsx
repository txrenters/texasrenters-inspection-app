import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { InspectionReportImport } from './inspection-report-import';
import type { ImportJob } from '@/lib/queries';

/**
 * Dropping a report in, and getting out of the way once it has landed.
 *
 * Seeding a backlog is 134 uploads, so the two costs that matter are the
 * gesture and the wait. Dropping removes a file-picker round trip; minimizing
 * the moment the file lands removes the reason anybody sat watching.
 *
 * The minimize fires on *upload complete*, never earlier. The upload is the one
 * phase that genuinely cannot be walked away from — nothing is stored until the
 * file arrives — so hiding it would be hiding the only part that can still be
 * lost.
 */

const startImport = vi.fn();
const commitImport = vi.fn();
let job: ImportJob | undefined;
let uploading = false;

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/queries', () => ({
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: startImport, isPending: uploading, error: null },
    commitInspectionImport: { mutateAsync: commitImport, isPending: false, error: null },
  }),
  useInspectionImportJob: () => ({ data: job }),
  useActiveInspectionImport: () => ({ data: null }),
  useRunningImports: () => ({ data: [] }),
}));

const pdf = () =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', { type: 'application/pdf' });

const zone = () => screen.getByRole('button', { name: /drop a report|drop the report|uploading/i });

/** A drop carrying files, which jsdom will not synthesise on its own. */
const drop = (node: Element, files: File[]) =>
  fireEvent.drop(node, { dataTransfer: { files, types: ['Files'] } });

beforeEach(() => {
  startImport.mockReset().mockResolvedValue({ jobId: 'job-1', status: 'RUNNING' });
  commitImport.mockReset();
  job = undefined;
  uploading = false;
});

describe('dropping a report onto the dialog', () => {
  it('hands a dropped file over to be uploaded', async () => {
    // The dialog no longer uploads. It takes the file and passes it to the
    // drawer, which is what lets it close immediately instead of holding the
    // reader hostage to a progress bar.
    const onHandOff = vi.fn();
    render(<InspectionReportImport onHandOff={onHandOff} />);

    drop(zone(), [pdf()]);

    await vi.waitFor(() => expect(onHandOff).toHaveBeenCalled());
    expect(onHandOff.mock.calls[0][0].name).toBe('report.pdf');
  });

  it('says so while a file is over it', () => {
    render(<InspectionReportImport />);
    fireEvent.dragOver(zone(), { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText(/drop the report to start/i)).toBeTruthy();
  });

  it('stops saying so when the file leaves', () => {
    render(<InspectionReportImport />);
    const node = zone();
    fireEvent.dragOver(node, { dataTransfer: { types: ['Files'] } });
    fireEvent.dragLeave(node, { relatedTarget: document.body });
    expect(screen.queryByText(/drop the report to start/i)).toBeNull();
  });

  it('still refuses anything that is not a PDF', async () => {
    // The same guard the file picker has. A drop is a different gesture, not a
    // different rule.
    render(<InspectionReportImport />);

    drop(zone(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(await screen.findByText(/not a pdf/i)).toBeTruthy();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('is still a button, so the picker route survives', () => {
    // Dropping is undiscoverable on its own and impossible from a keyboard.
    render(<InspectionReportImport />);
    expect(zone().tagName).toBe('BUTTON');
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe('getting out of the way once the file is chosen', () => {
  it('hands off exactly once', async () => {
    const onHandOff = vi.fn();
    render(<InspectionReportImport onHandOff={onHandOff} />);

    drop(zone(), [pdf()]);

    await vi.waitFor(() => expect(onHandOff).toHaveBeenCalledTimes(1));
  });

  it('does not hand off a file it rejected', async () => {
    // The PDF check happens before anything leaves the dialog, so a wrong file
    // never reaches the drawer and never becomes a row that fails there.
    const onHandOff = vi.fn();
    render(<InspectionReportImport onHandOff={onHandOff} />);

    drop(zone(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(await screen.findByText(/not a pdf/i)).toBeTruthy();
    expect(onHandOff).not.toHaveBeenCalled();
  });

  it('works without anywhere to hand off to', async () => {
    // The panel is exported on its own and rendered outside a dialog in tests
    // and elsewhere; an absent callback must not be a crash.
    render(<InspectionReportImport />);
    expect(() => drop(zone(), [pdf()])).not.toThrow();
  });
});
