import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaEvidenceWorkspace } from './AreaEvidenceWorkspace';

/**
 * What the Areas card's header offers.
 *
 * The import was filed as the last line of the "Manage areas" menu in the
 * console redesign (#443), and the office reported it gone. On a move-in Jobber
 * closed with nothing recorded -- the inspection that most needs its report --
 * nothing about a menu named for areas says an import is inside it. So the
 * import is a button of its own again, reachable without opening anything.
 */

let permissions: string[] = [];
let inspection: Record<string, unknown> | undefined;
let manageableAreas: Array<{ id: string }> = [];
let activeImport: Record<string, unknown> | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (permission: string) => permissions.includes(permission) }),
}));
vi.mock('@/lib/queries', () => ({
  useAreaEvidenceSummary: () => ({
    isLoading: false,
    isError: false,
    data: {
      // No areas listed, so the per-area panels never mount: this is about the
      // header, which does not depend on them.
      areas: [],
      totals: { areas: 15, recordings: 0, photos: 0, findings: 0 },
      unassigned: { recordings: 0, photos: 0 },
    },
  }),
  useInspection: () => ({ data: inspection }),
  useInspectionAreas: () => ({ data: manageableAreas }),
  useActiveInspectionImport: () => ({ data: activeImport }),
  useInspectionImportJob: () => ({ data: undefined }),
  useAdminMutations: () => ({
    startInspectionImport: { mutateAsync: vi.fn(), isPending: false, error: null },
    commitInspectionImport: { mutateAsync: vi.fn(), isPending: false, error: null },
  }),
}));
vi.mock('@/components/inspection-workflow', () => ({
  AddAreasDialog: () => null,
  MergeAreasDialog: () => null,
}));
vi.mock('./AreaDetailPanel', () => ({ AreaDetailPanel: () => null }));
vi.mock('./AreaPhotoViewer', () => ({ AreaPhotoViewer: () => null }));
vi.mock('./PhotoSheet', () => ({ PhotoSheet: () => null }));

/** A move-in Jobber closed, with nothing recorded against it. */
const closedMoveIn = {
  id: 'inspection-1',
  inspectionType: 'MOVE_IN',
  status: 'COMPLETED',
  finalizedAt: '2026-10-08T20:00:00.000Z',
  propertywareBuilding: { id: 'building-1' },
  evidence: { areas: 15, photos: 0, findings: 0, media: 0, responses: 0 },
};

beforeEach(() => {
  permissions = ['inspections:manage'];
  inspection = closedMoveIn;
  manageableAreas = [{ id: 'area-1' }, { id: 'area-2' }];
  activeImport = null;
});

describe('the Areas card header', () => {
  it('offers the import as a button of its own, not inside "Manage areas"', () => {
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    // Reachable without opening any menu.
    expect(screen.getByRole('button', { name: 'Import a report' })).toBeTruthy();
    // The menu is still there for what it is named for.
    expect(screen.getByRole('button', { name: /manage areas/i })).toBeTruthy();
  });

  it('keeps the import when there are no areas to manage', () => {
    // A completed inspection cannot gain an area, and one area cannot be
    // merged: the menu would be empty, so it is not drawn. The import still is.
    manageableAreas = [{ id: 'area-1' }];
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    expect(screen.getByRole('button', { name: 'Import a report' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /manage areas/i })).toBeNull();
  });

  it('says when an import is already running, on the button itself', () => {
    activeImport = { id: 'job-1', status: 'RUNNING', committedAt: null, errorCode: null };
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    expect(screen.getByRole('button', { name: /import in progress/i })).toBeTruthy();
  });

  it('is not offered to someone who cannot manage inspections', () => {
    permissions = [];
    render(<AreaEvidenceWorkspace inspectionId="inspection-1" />);

    expect(screen.queryByRole('button', { name: /import a report/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage areas/i })).toBeNull();
  });
});
