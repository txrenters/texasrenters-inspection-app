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
  it('starts the import from a dropped file', async () => {
    render(<InspectionReportImport inspectionId="inspection-1" />);

    drop(zone(), [pdf()]);

    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
    expect(startImport.mock.calls[0][0].file.name).toBe('report.pdf');
  });

  it('says so while a file is over it', () => {
    render(<InspectionReportImport inspectionId="inspection-1" />);
    fireEvent.dragOver(zone(), { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText(/drop the report to start/i)).toBeTruthy();
  });

  it('stops saying so when the file leaves', () => {
    render(<InspectionReportImport inspectionId="inspection-1" />);
    const node = zone();
    fireEvent.dragOver(node, { dataTransfer: { types: ['Files'] } });
    fireEvent.dragLeave(node, { relatedTarget: document.body });
    expect(screen.queryByText(/drop the report to start/i)).toBeNull();
  });

  it('still refuses anything that is not a PDF', async () => {
    // The same guard the file picker has. A drop is a different gesture, not a
    // different rule.
    render(<InspectionReportImport inspectionId="inspection-1" />);

    drop(zone(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(await screen.findByText(/not a pdf/i)).toBeTruthy();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('is still a button, so the picker route survives', () => {
    // Dropping is undiscoverable on its own and impossible from a keyboard.
    render(<InspectionReportImport inspectionId="inspection-1" />);
    expect(zone().tagName).toBe('BUTTON');
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe('getting out of the way once the file has landed', () => {
  it('reports the upload as finished so the dialog can minimize', async () => {
    const onUploaded = vi.fn();
    render(<InspectionReportImport inspectionId="inspection-1" onUploaded={onUploaded} />);

    drop(zone(), [pdf()]);

    await vi.waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
  });

  it('does not minimize when the upload fails', async () => {
    // Minimizing on failure would hide the error into a dock that shows no
    // failures, and the person would never learn the import never started.
    const onUploaded = vi.fn();
    startImport.mockRejectedValue(new Error('The API could not be reached.'));
    render(<InspectionReportImport inspectionId="inspection-1" onUploaded={onUploaded} />);

    drop(zone(), [pdf()]);

    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('does not minimize when the file was rejected before it was sent', async () => {
    const onUploaded = vi.fn();
    render(<InspectionReportImport inspectionId="inspection-1" onUploaded={onUploaded} />);

    drop(zone(), [new File(['x'], 'notes.txt', { type: 'text/plain' })]);

    expect(await screen.findByText(/not a pdf/i)).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('works without a dialog to minimize', async () => {
    // The panel is exported on its own and rendered outside a dialog in tests
    // and elsewhere; an absent callback must not be a crash.
    render(<InspectionReportImport inspectionId="inspection-1" />);
    drop(zone(), [pdf()]);
    await vi.waitFor(() => expect(startImport).toHaveBeenCalled());
  });
});
