import type { AreaFinding } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiFrameSuggestion } from './AiFrameSuggestion';

/**
 * The AI's suggested photograph for a finding. A suggestion until a person
 * files it; the box is the AI's estimate and is drawn as one.
 */

const state = vi.hoisted(() => ({ mutate: vi.fn(), seek: vi.fn() }));

vi.mock('@/lib/queries', () => ({
  useVideoPlayback: (mediaId: string) => ({
    data: {
      videoId: mediaId,
      provider: 'cloudflare_stream',
      status: 'ready',
      thumbnailUrl: `https://customer-x.cloudflarestream.com/${mediaId}.tok/thumbnails/thumbnail.jpg`,
    },
  }),
  useAdminMutations: () => ({
    decideFrameSuggestion: {
      mutate: state.mutate,
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
    },
  }),
}));
// Compact photographs fetch through the API; their contents are not the point here.
vi.mock('./LazyPhoto', () => ({
  LazyPhoto: ({ photo }: { photo: { id: string } }) => <span data-testid={`move-in-${photo.id}`} />,
}));

function finding(overrides: Partial<AreaFinding> = {}): AreaFinding {
  return {
    id: 'finding-door',
    title: 'Door hole and trim require repair',
    description: 'Two holes below the handle.',
    category: 'Door',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    severity: 'MEDIUM',
    comparisonResult: 'POSSIBLE_NEW_DAMAGE',
    confidence: 0.9,
    reviewStatus: 'PENDING_REVIEW',
    createdAt: '2026-10-02T00:33:00.000Z',
    recordingId: 'media-1',
    videoTimestampStart: 18,
    videoTimestampEnd: 24,
    photoCount: 0,
    frameSuggestions: [
      {
        id: 'suggestion-2',
        recordingId: 'media-1',
        atMs: 25_000,
        rank: 1,
        box: null,
        observation: null,
        status: 'SUGGESTED',
      },
      {
        id: 'suggestion-1',
        recordingId: 'media-1',
        atMs: 21_500,
        rank: 0,
        box: { x: 0.36, y: 0.6, width: 0.1, height: 0.06 },
        observation: 'Two small holes below the handle.',
        status: 'SUGGESTED',
      },
    ],
    ...overrides,
  };
}

function show(data: AreaFinding, canDecide = true) {
  render(
    <AiFrameSuggestion
      areaId="area-1"
      areaName="Entrance"
      canDecide={canDecide}
      finding={data}
      inspectionId="inspection-1"
      onSeek={state.seek}
    />,
  );
}

beforeEach(() => {
  state.mutate.mockReset();
  state.seek.mockReset();
});

describe("the AI's suggested photo", () => {
  it("shows its best frame, outlined where it sees the condition, with what it sees", () => {
    show(finding());

    const image = screen.getByRole('img', { name: /Frame at 0:21 suggested/ });
    expect(image.getAttribute('src')).toBe(
      'https://customer-x.cloudflarestream.com/media-1.tok/thumbnails/thumbnail.jpg?time=21.5s&height=720',
    );
    const box = image.parentElement!.querySelector('span[aria-hidden]') as HTMLElement;
    expect(box.style.left).toBe('36%');
    expect(box.style.top).toBe('60%');
    expect(screen.getByText('Two small holes below the handle.')).toBeTruthy();
  });

  it('files it, or sets it aside, as the reviewer decides', () => {
    show(finding());

    fireEvent.click(screen.getByRole('button', { name: 'Use this photo' }));
    expect(state.mutate).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      decision: 'accept',
      inspectionId: 'inspection-1',
      areaId: 'area-1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Not this one' }));
    expect(state.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'dismiss' }));
  });

  it('offers the next frame once the best one is set aside', () => {
    const [second, first] = finding().frameSuggestions!;
    show(finding({ frameSuggestions: [{ ...first, status: 'DISMISSED' }, second] }));
    expect(screen.getByRole('img', { name: /Frame at 0:25 suggested/ })).toBeTruthy();
  });

  it('says so once a person filed the frame, and offers nothing more to decide', () => {
    const [second, first] = finding().frameSuggestions!;
    show(finding({ frameSuggestions: [{ ...first, status: 'ACCEPTED', photoId: 'photo-1' }, second] }));
    expect(screen.getByText('Filed under the finding')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Not this one' })).toBeNull();
  });

  // The office (2026-10-06): the AI files its best frame itself; a reviewer
  // can still say it is the wrong one.
  it('says the AI filed it, and lets the reviewer set it aside', () => {
    const [second, first] = finding().frameSuggestions!;
    show(
      finding({
        frameSuggestions: [{ ...first, status: 'ACCEPTED', photoId: 'ai-photo', filedByAi: true }, second],
      }),
    );

    expect(screen.getByText(/Added by the AI as this finding/)).toBeTruthy();
    expect(screen.getByText('Filed under the finding')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use this photo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not this one' }));
    expect(state.mutate).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      decision: 'dismiss',
      inspectionId: 'inspection-1',
      areaId: 'area-1',
    });
  });

  it('does not offer to set aside the AI’s frame to someone who may not file evidence', () => {
    const [second, first] = finding().frameSuggestions!;
    show(
      finding({
        frameSuggestions: [{ ...first, status: 'ACCEPTED', photoId: 'ai-photo', filedByAi: true }, second],
      }),
      false,
    );
    expect(screen.queryByRole('button', { name: 'Not this one' })).toBeNull();
  });

  it('is only looked at by someone who may not file evidence', () => {
    show(finding(), false);
    expect(screen.queryByRole('button', { name: 'Use this photo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play here' }));
    expect(state.seek).toHaveBeenCalledWith('media-1', 21);
  });
});

describe('what the move-in showed', () => {
  it('says the move-in photo shows it too, and shows that photo', () => {
    show(
      finding({
        baselineVisual: {
          status: 'PRESENT_AT_MOVE_IN',
          note: 'The same two holes show at move-in.',
          photos: [{ id: 'move-in-1', contentPath: '/api/v1/admin/photos/move-in-1/content' }],
        },
      }),
    );
    expect(screen.getByText('The move-in photo shows it too')).toBeTruthy();
    expect(screen.getByText(/The same two holes show at move-in/)).toBeTruthy();
    expect(screen.getByTestId('move-in-move-in-1')).toBeTruthy();
  });

  it('shows nothing when the AI neither suggested a frame nor compared the move-in', () => {
    const { container } = render(
      <AiFrameSuggestion
        areaId="area-1"
        areaName="Entrance"
        canDecide
        finding={finding({ frameSuggestions: [] })}
        inspectionId="inspection-1"
        onSeek={state.seek}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
