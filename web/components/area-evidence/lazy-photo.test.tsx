import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LazyPhoto } from './LazyPhoto';

/**
 * A frame the AI filed itself (the office, 2026-10-06) is marked as the AI's,
 * so nobody takes it for a photograph a person took or chose.
 */

vi.mock('@/lib/api', () => ({
  // The picture itself is not the point here.
  apiBlob: () => new Promise(() => undefined),
}));

const photo = {
  contentPath: '/api/v1/admin/photos/ai-frame/content',
  captureType: 'VIDEO_FRAME_SNAPSHOT',
  label: null,
};

describe('a photograph the AI filed', () => {
  it('says so on the thumbnail and to a screen reader', () => {
    render(<LazyPhoto areaName="Kitchen" photo={{ ...photo, filedByAi: true }} />);

    expect(screen.getByTestId('added-by-ai').textContent).toBe('Added by AI');
    expect(screen.getByRole('button', { name: 'Open Video snapshot of Kitchen, added by AI' })).toBeTruthy();
  });

  it('says it in a word on a small tile', () => {
    render(<LazyPhoto areaName="Kitchen" compact photo={{ ...photo, filedByAi: true }} />);

    expect(screen.getByTestId('added-by-ai').textContent).toBe('AI');
  });

  it('says nothing on a photograph a person took or chose', () => {
    render(<LazyPhoto areaName="Kitchen" photo={photo} />);

    expect(screen.queryByTestId('added-by-ai')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Video snapshot of Kitchen' })).toBeTruthy();
  });
});
