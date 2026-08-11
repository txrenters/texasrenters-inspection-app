import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaChecklistDialog } from './AreaChecklistDialog';
import type { AreaChecklistItem } from '@/lib/area-checklist';

const calls: Array<{ path: string; method?: string; body?: string }> = [];
let listResponse: AreaChecklistItem[] = [];
let createFails = false;

vi.mock('@/lib/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method, body: init?.body as string | undefined });
    if (init?.method === 'POST') {
      if (createFails) throw new Error('An item with that label already exists.');
      const input = JSON.parse(init.body as string) as { label: string; keywords: string[] };
      return { id: `item-${listResponse.length + 1}`, sortOrder: 0, ...input };
    }
    if (init?.method === 'DELETE') return { id: 'item-1', archived: true };
    return listResponse;
  }),
}));

// Radix portals the dialog outside the render container, so the form is
// reached through the document rather than the returned container.
function form() {
  return document.querySelector('form')!;
}

function open() {
  return render(
    <AreaChecklistDialog areaId="area-1" areaName="Patio (right)" onOpenChange={() => {}} open />,
  );
}

beforeEach(() => {
  calls.length = 0;
  listResponse = [];
  createFails = false;
});
afterEach(() => vi.clearAllMocks());

describe('AreaChecklistDialog', () => {
  it('keeps the empty state out of the item list', async () => {
    open();
    const empty = await screen.findByText(/No items yet/);
    // A non-item inside the <ul> rendered a stray bullet, because nothing in
    // this project resets the user-agent list style.
    expect(empty.closest('li')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('hides the archive caveat until there is something to remove', async () => {
    open();
    await screen.findByText(/No items yet/);
    expect(screen.queryByText(/Removing an item archives it/)).toBeNull();

    listResponse = [{ id: 'item-1', label: 'Sink', keywords: ['sink'], sortOrder: 0 }];
    open();
    await screen.findAllByText('Sink');
    expect(screen.getAllByText(/Removing an item archives it/).length).toBeGreaterThan(0);
  });

  it('labels the item field visibly rather than by placeholder alone', async () => {
    open();
    await screen.findByText(/No items yet/);
    // getByLabelText resolves the visible <label for>, so this fails if the
    // field regresses to a placeholder or a bare aria-label.
    expect(screen.getByLabelText('Add an item')).toHaveAttribute('id', 'checklist-label');
  });

  it('asks for the item alone, leaving the server to derive what to listen for', async () => {
    open();
    await screen.findByText(/No items yet/);
    expect(screen.queryByLabelText(/Keywords/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Add an item'), { target: { value: 'Sink, taps' } });
    fireEvent.submit(form());

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(JSON.parse(post.body!)).toEqual({ label: 'Sink, taps' });
  });

  it('returns focus to the item field so several can be added in a row', async () => {
    open();
    await screen.findByText(/No items yet/);

    const item = screen.getByLabelText('Add an item');
    fireEvent.change(item, { target: { value: 'Sink' } });
    fireEvent.submit(form());

    await waitFor(() => expect(item).toHaveValue(''));
    expect(document.activeElement).toBe(item);
  });

  it('shows an add failure beside the form, not at the top of the dialog', async () => {
    createFails = true;
    open();
    await screen.findByText(/No items yet/);

    fireEvent.change(screen.getByLabelText('Add an item'), { target: { value: 'Sink' } });
    fireEvent.submit(form());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An item with that label already exists.');
    expect(within(form()).getByRole('alert')).toBe(alert);
  });
});
