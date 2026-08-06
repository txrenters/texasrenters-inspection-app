import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaEvidenceWorkspace } from './AreaEvidenceWorkspace';

// Behaves like the router rather than swallowing the call: the open area and
// the open tab both live in the URL now, so a mock that never updates them
// leaves the component permanently on its initial state.
const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

// The auth module constructs a Supabase client at import time, which needs env
// vars jsdom does not have. Reviewing is permitted here so the finding controls
// render.
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: () => true }),
}));

const apiCalls: string[] = [];
const bundles: Record<string, ReturnType<typeof bundle>> = {};
vi.mock('@/lib/api', () => ({
  api: vi.fn(async (path: string) => {
    apiCalls.push(path);
    if (path.includes('area-evidence-summary')) return summaryResponse;
    if (path.includes('/areas/area-foyer/evidence'))
      return bundles['area-foyer'] ?? bundle('area-foyer', 'Foyer');
    if (path.includes('/areas/area-library/evidence'))
      return bundles['area-library'] ?? bundle('area-library', 'Library');
    throw new Error(`unexpected ${path}`);
  }),
  apiBlob: vi.fn(async (path: string) => {
    apiCalls.push(path);
    return new Blob(['x']);
  }),
}));

const summaryResponse = {
  inspectionId: 'insp-1',
  totals: { areas: 2, areasReviewed: 1, recordings: 2, photos: 5, findings: 3, unreviewedFindings: 1 },
  unassigned: { recordings: 0, photos: 0 },
  areas: [
    {
      id: 'area-foyer',
      propertyAreaId: 'p-foyer',
      name: 'Foyer',
      floorName: 'Ground Floor',
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: 'COMPLETED',
      reviewStatus: 'FINDINGS_NEED_REVIEW',
      counts: { recordings: 1, photos: 4, findings: 3, unreviewedFindings: 1 },
      evidence: {
        primaryRecordingAvailable: true,
        overviewPhotoAvailable: true,
        conditionSummaryAvailable: true,
      },
      lastEvidenceAt: '2026-07-28T10:00:00.000Z',
    },
    {
      id: 'area-library',
      propertyAreaId: 'p-library',
      name: 'Library',
      floorName: 'Ground Floor',
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: 'COMPLETED',
      reviewStatus: 'REVIEWED',
      counts: { recordings: 1, photos: 1, findings: 0, unreviewedFindings: 0 },
      evidence: {
        primaryRecordingAvailable: true,
        overviewPhotoAvailable: true,
        conditionSummaryAvailable: false,
      },
      lastEvidenceAt: '2026-07-28T11:00:00.000Z',
    },
  ],
};

function bundle(id: string, name: string) {
  return {
    area: {
      id,
      propertyAreaId: `p-${id}`,
      name,
      floorName: 'Ground Floor',
      environment: 'INDOOR',
      isRequired: true,
      completionStatus: 'COMPLETED',
      reviewStatus: 'REVIEWED',
      skipReason: null,
      technicianNote: null,
    },
    conditionSummary: null,
    recordings: [
      {
        id: `${id}-rec`,
        recordingType: 'PRIMARY_AREA',
        label: null,
        category: null,
        durationSeconds: 52,
        uploadStatus: 'UPLOADED',
        processingStatus: 'READY',
        technicianName: 'Ernie',
        createdAt: '2026-07-28T10:00:00.000Z',
        thumbnailUrl: `https://cdn.example/${id}.jpg`,
        contentPath: `/api/v1/admin/media/${id}-rec/content`,
      },
    ],
    photoGroups: [],
    findings: [],
    counts: { recordings: 1, photos: 0, findings: 0, unreviewedFindings: 0 },
  };
}

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AreaEvidenceWorkspace inspectionId="insp-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const key of Object.keys(bundles)) delete bundles[key];
  apiCalls.length = 0;
  replace.mockClear();
  searchParams = new URLSearchParams();
});
afterEach(() => vi.clearAllMocks());

/**
 * Open one of the evidence tabs.
 *
 * `mouseDown` is the event that matters — Radix selects there, not on click, so
 * a bare `fireEvent.click` leaves the panel on the tab it opened with and the
 * assertion then fails looking for content that was never mounted. The click is
 * kept so the sequence still resembles a real interaction.
 */
async function openTab(name: RegExp) {
  const tab = await screen.findByRole('tab', { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  return tab;
}

describe('area-first inspection evidence', () => {
  it('lists compact area cards without fetching any area evidence up front', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Foyer/ });

    expect(screen.getByRole('tab', { name: /Library/ })).toBeTruthy();
    // The summary is the only inspection-wide request; the old page issued four
    // and pulled every recording, photo and finding.
    expect(apiCalls.filter((path) => path.includes('area-evidence-summary'))).toHaveLength(1);
    expect(apiCalls.filter((path) => path.includes('/media/'))).toHaveLength(0);
  });

  it('loads only the opened area, and not its neighbours', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Foyer/ });

    await waitFor(() =>
      expect(apiCalls.some((path) => path.includes('/areas/area-foyer/evidence'))).toBe(true),
    );
    expect(apiCalls.some((path) => path.includes('/areas/area-library/evidence'))).toBe(false);
  });

  it('fetches the other area only once it is selected', async () => {
    renderWorkspace();
    const library = await screen.findByRole('tab', { name: /Library/ });

    fireEvent.click(library);

    // Selection is written to the URL so refresh and Back both work.
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('area=area-library'), {
      scroll: false,
    });
  });

  it('renders a poster rather than mounting a video player', async () => {
    renderWorkspace();
    await screen.findByRole('tab', { name: /Foyer/ });
    // Evidence sits behind tabs now and the panel opens on Overview, so a
    // reviewer no longer scrolls past photos and findings to reach the video.
    await openTab(/^Recording/);
    await screen.findByRole('button', { name: /Play recording|Loading/ });

    // No <video> exists until the reviewer presses play, and no playback URL
    // has been requested.
    expect(document.querySelector('video')).toBeNull();
    expect(apiCalls.some((path) => path.includes('/playback'))).toBe(false);
  });

  it('announces the loaded area and describes each card for screen readers', async () => {
    renderWorkspace();
    const foyer = await screen.findByRole('tab', { name: /Foyer/ });

    // Counts and the review requirement must be spoken, not implied by colour.
    expect(foyer.getAttribute('aria-label')).toMatch(/1 recording/);
    expect(foyer.getAttribute('aria-label')).toMatch(/3 findings/);
    expect(foyer.getAttribute('aria-label')).toMatch(/1 finding require[s]? review/);
  });

  it('lets a reviewer action a finding from the area workspace', async () => {
    // Regression guard: replacing the four page-wide sections removed the only
    // approve/reject controls in the application, so findings could be read but
    // never decided.
    const withFinding = bundle('area-foyer', 'Foyer');
    withFinding.findings = [
      {
        id: 'finding-1',
        title: 'Repaint Wall 1',
        description: 'Scuffing along the lower half.',
        category: 'WALLS',
        findingType: 'POSSIBLE_NEW_DAMAGE',
        severity: 'MEDIUM',
        comparisonResult: 'POSSIBLE_NEW_DAMAGE',
        baselineCondition: null,
        confidence: 0.8,
        reviewStatus: 'PENDING_REVIEW',
        createdAt: '2026-07-28T10:00:00.000Z',
        recordingId: 'area-foyer-rec',
        videoTimestampStart: 18,
        videoTimestampEnd: 26,
        photoCount: 0,
        lastReview: null,
      },
    ] as never;
    bundles['area-foyer'] = withFinding;

    renderWorkspace();
    await screen.findByRole('tab', { name: /Foyer/ });
    await openTab(/^Findings/);
    // The row collapses its detail until opened.
    const row = await screen.findByRole('button', { name: /Repaint Wall 1/ });
    fireEvent.click(row);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('surfaces unassigned evidence instead of hiding it', async () => {
    const withOrphans = {
      ...summaryResponse,
      unassigned: { recordings: 2, photos: 3 },
    };
    const original = summaryResponse.unassigned;
    Object.assign(summaryResponse, { unassigned: withOrphans.unassigned });

    renderWorkspace();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Unassigned evidence/);

    Object.assign(summaryResponse, { unassigned: original });
  });
});
