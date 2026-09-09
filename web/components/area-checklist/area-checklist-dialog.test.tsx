import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaChecklistDialog } from './AreaChecklistDialog';
import type { AreaChecklistItem } from '@/lib/area-checklist';

const calls: Array<{ path: string; method?: string; body?: string }> = [];
let listResponse: AreaChecklistItem[] = [];
let createFails = false;
/**
 * The occupied list is a second GET from the same dialog, and it is not the
 * area's list. Routing the mock by path rather than by method matters: a mock
 * that answered every GET with `listResponse` handed area items to the occupied
 * panel, which then read `choices` off rows that have none.
 */
let occupiedResponse: { id: string; label: string; responseType: string; choices: string[]; sortOrder: number }[] = [];

vi.mock('@/lib/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method, body: init?.body as string | undefined });
    if (init?.method === 'POST') {
      if (createFails) throw new Error('An item with that label already exists.');
      const input = JSON.parse(init.body as string) as { label: string; keywords: string[] };
      return { id: `item-${listResponse.length + 1}`, sortOrder: 0, ...input };
    }
    if (init?.method === 'DELETE') return { id: 'item-1', archived: true };
    if (path.includes('/checklists/occupied')) return occupiedResponse;
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
  occupiedResponse = [];
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

/**
 * The dialog answers "what does the technician see?", and it used to answer
 * with half of it.
 *
 * A reviewer opened this on Bathroom 2, read nine items under "What the
 * technician is asked to cover while recording this area", and reasonably
 * concluded an occupied inspection still asked nine questions about a bathroom.
 * It does not — that list is the move-out one. The copy claimed otherwise and
 * the occupied list was not shown at all.
 */
describe('AreaChecklistDialog occupied panel', () => {
  it('says which visits the area list belongs to', async () => {
    listResponse = [{ id: 'item-1', label: 'Bath, shower and taps', keywords: [], sortOrder: 0 }];
    open();

    expect(
      await screen.findByText(/move-in, move-out or back-to-market/i),
    ).toBeInTheDocument();
  });

  it('shows the two occupied questions and their options', async () => {
    occupiedResponse = [
      {
        id: 'occ-1',
        label: 'Room condition',
        responseType: 'CHOICE',
        choices: ['Clean', 'Acceptable', 'Damaged', 'Needs attention'],
        sortOrder: 0,
      },
      {
        id: 'occ-2',
        label: 'Overall condition',
        responseType: 'CHOICE',
        choices: ['Good', 'Fair', 'Poor'],
        sortOrder: 1,
      },
    ];
    open();

    const panel = await screen.findByRole('list', { name: /occupied inspection questions/i });
    expect(within(panel).getByText('Room condition')).toBeInTheDocument();
    expect(within(panel).getByText('Overall condition')).toBeInTheDocument();
    // The options matter as much as the labels: they are what tells a reader
    // this is a two-tap assessment rather than another nine-item list.
    expect(within(panel).getByText(/Clean · Acceptable · Damaged · Needs attention/)).toBeInTheDocument();
  });

  it('calls the organization-wide route, not one scoped to this area', async () => {
    open();
    await waitFor(() =>
      expect(calls.some((call) => call.path.includes('/checklists/occupied'))).toBe(true),
    );
    // The rows have a null area, so an area-scoped request could never find
    // them — which is why the existing route cannot answer this.
    expect(
      calls.find((call) => call.path.includes('/checklists/occupied'))?.path,
    ).not.toContain('area-1');
  });

  it('calls an organization that has never scheduled one "not created yet"', async () => {
    // Empty is a real, temporary state rather than a fault: the rows are
    // written when an occupied inspection is created.
    occupiedResponse = [];
    open();
    expect(await screen.findByText(/not created yet/i)).toBeInTheDocument();
  });
});
