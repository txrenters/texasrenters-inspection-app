import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ListToolbar } from './list-toolbar';

/**
 * The search box, typed into fast.
 *
 * Every list page keeps its query in the URL, so `search` arrives back from
 * `useSearchParams()` one asynchronous `router.replace` later. These tests
 * stand in for that router: `commit()` is the moment the address bar catches
 * up, and nothing else moves the prop.
 */
function Harness({ latency = 'deferred' }: { latency?: 'deferred' | 'immediate' }) {
  const [search, setSearch] = useState('');
  // Only ever written and drained — the queue is the router's, not the test's.
  const [, setInFlight] = useState<string[]>([]);

  return (
    <>
      <ListToolbar
        onSearch={(value) => {
          if (latency === 'immediate') setSearch(value);
          else setInFlight((queue) => [...queue, value]);
        }}
        resultLabel="10 technician accounts"
        search={search}
      />
      {/* Lands the oldest pending URL write, the way a slow router would. */}
      <button
        onClick={() => {
          setInFlight(([next, ...rest]) => {
            if (next !== undefined) setSearch(next);
            return rest;
          });
        }}
        type="button"
      >
        commit
      </button>
      <button onClick={() => setSearch('')} type="button">
        external clear
      </button>
    </>
  );
}

const field = () => screen.getByRole('searchbox');
const commit = () => fireEvent.click(screen.getByText('commit'));

describe('ListToolbar search', () => {
  it('keeps every character when the URL lags behind the typing', () => {
    // The reported bug. Three keystrokes land before the router commits any of
    // them; the field used to be re-rendered from the stale prop and lose them.
    render(<Harness />);

    fireEvent.change(field(), { target: { value: 's' } });
    fireEvent.change(field(), { target: { value: 'sa' } });
    fireEvent.change(field(), { target: { value: 'sam' } });

    expect(field()).toHaveValue('sam');
  });

  it('does not rewind the field when a stale URL value arrives late', () => {
    // The subtler half. "sam" is typed, then the router delivers "s" — an
    // intermediate value that is already obsolete. Adopting it would put the
    // caret back two characters mid-word.
    render(<Harness />);

    fireEvent.change(field(), { target: { value: 's' } });
    fireEvent.change(field(), { target: { value: 'sa' } });
    fireEvent.change(field(), { target: { value: 'sam' } });

    act(() => commit()); // 's' lands
    expect(field()).toHaveValue('sam');
    act(() => commit()); // 'sa' lands
    expect(field()).toHaveValue('sam');
    act(() => commit()); // 'sam' lands; the mirror has caught up
    expect(field()).toHaveValue('sam');
  });

  it('still reports every keystroke upward so the page can debounce it', () => {
    // The pages own the debounce and the request. This component must not
    // swallow or reorder what it hands them.
    const onSearch = vi.fn();
    render(<ListToolbar onSearch={onSearch} resultLabel="10 accounts" search="" />);

    fireEvent.change(field(), { target: { value: 's' } });
    fireEvent.change(field(), { target: { value: 'sa' } });

    expect(onSearch.mock.calls.map(([value]) => value)).toEqual(['s', 'sa']);
  });

  it('accepts a change that came from somewhere other than the keyboard', () => {
    // "Clear all", a filter chip's ✕ and the back button all rewrite the query
    // with nobody typing. Those must reach the field, or it shows a term that
    // is no longer filtering anything.
    render(<Harness latency="immediate" />);

    fireEvent.change(field(), { target: { value: 'sam' } });
    expect(field()).toHaveValue('sam');

    act(() => {
      fireEvent.click(screen.getByText('external clear'));
    });
    expect(field()).toHaveValue('');
  });

  it('accepts an external clear after a lagging URL has settled', () => {
    // The two cases meet here: once the mirror has caught up, the next
    // difference is somebody else's doing and must be adopted rather than
    // dismissed as our own echo.
    render(<Harness />);

    fireEvent.change(field(), { target: { value: 'sam' } });
    act(() => commit());
    expect(field()).toHaveValue('sam');

    act(() => {
      fireEvent.click(screen.getByText('external clear'));
    });
    expect(field()).toHaveValue('');
  });
});
