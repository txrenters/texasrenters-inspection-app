import { fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SearchableSelect } from './searchable-select';

const options = [
  { value: 'one', label: '1150 LLC' },
  { value: 'two', label: 'Austin Residential' },
  { value: 'three', label: 'Westlake Portfolio' },
];

// Radix Popover measures its trigger through ResizeObserver, and Command scrolls
// the active item into view — jsdom provides neither.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as never;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

function openMenu() {
  const trigger = screen.getByRole('combobox');
  fireEvent.click(trigger);
  return trigger;
}

describe('SearchableSelect', () => {
  it('filters options and selects a portfolio', async () => {
    const onChange = vi.fn();
    render(
      createElement(SearchableSelect, {
        id: 'portfolio',
        value: '',
        options,
        placeholder: 'Select portfolio',
        onChange,
      }),
    );

    openMenu();
    const search = await screen.findByPlaceholderText('Search…');
    fireEvent.change(search, { target: { value: 'west' } });

    // Command filters client-side when no `onSearch` is supplied.
    expect(screen.queryByRole('option', { name: /1150 LLC/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Westlake Portfolio/ }));
    expect(onChange).toHaveBeenCalledWith('three');
  });

  it('shows the selected label on the trigger and updates it after selection', async () => {
    function Harness() {
      const [value, setValue] = useState('one');
      return createElement(SearchableSelect, {
        id: 'portfolio',
        value,
        options,
        placeholder: 'Select portfolio',
        onChange: setValue,
      });
    }
    render(createElement(Harness));

    // The trigger is a button now, so the label is its text — not an input value.
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('1150 LLC');

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /Austin Residential/ }));
    expect(screen.getByRole('combobox')).toHaveTextContent('Austin Residential');
  });

  it('falls back to the placeholder when nothing is selected', () => {
    render(
      createElement(SearchableSelect, {
        id: 'portfolio',
        value: '',
        options,
        placeholder: 'Select portfolio',
        onChange: vi.fn(),
      }),
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Select portfolio');
    // Regression guard: the old single-input trigger painted the placeholder and
    // the selected label on top of each other.
    expect(within(trigger).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('leaves filtering to the server when onSearch is supplied', async () => {
    const onSearch = vi.fn();
    render(
      createElement(SearchableSelect, {
        id: 'portfolio',
        value: '',
        options,
        placeholder: 'Select portfolio',
        onChange: vi.fn(),
        onSearch,
      }),
    );

    openMenu();
    fireEvent.change(await screen.findByPlaceholderText('Search…'), {
      target: { value: 'zzz' },
    });

    // No client-side matcher may run, or it would hide rows the server returned.
    expect(screen.getByRole('option', { name: /1150 LLC/ })).toBeInTheDocument();
  });

  it('requests the next page only when the list is scrolled near the bottom', async () => {
    const onLoadMore = vi.fn();
    render(
      createElement(SearchableSelect, {
        id: 'portfolio',
        value: '',
        options,
        placeholder: 'Select portfolio',
        hasMore: true,
        onChange: vi.fn(),
        onLoadMore,
      }),
    );

    openMenu();
    // Target the node that actually carries onScroll. cmdk puts role="listbox" on
    // an inner sizer, and `scroll` does not bubble, so firing on the wrong node
    // never reaches the handler.
    await screen.findByPlaceholderText('Search…');
    const list = document.querySelector('[data-slot="command-list"]') as HTMLElement;
    Object.defineProperties(list, {
      scrollHeight: { value: 400, configurable: true },
      clientHeight: { value: 100, configurable: true },
      scrollTop: { value: 10, writable: true, configurable: true },
    });
    fireEvent.scroll(list);
    expect(onLoadMore).not.toHaveBeenCalled();

    Object.defineProperty(list, 'scrollTop', { value: 290, configurable: true });
    fireEvent.scroll(list);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('SearchableSelect selected-option visibility', () => {
  /** The auto-filled case: the value is real, but not in the loaded page. */
  const offPageSelection = {
    value: 'martin',
    label: 'Martin, Anthony',
  };

  it('shows the chosen option in the list even when the loaded page omits it', () => {
    // Portfolios are paginated, so an auto-filled value is usually absent from
    // page 1. Without pinning, the menu opened with no checkmark anywhere and
    // contradicted the trigger directly above it.
    render(
      createElement(SearchableSelect, {
        id: 'portfolioId',
        value: 'martin',
        options,
        selectedOption: offPageSelection,
        placeholder: 'All portfolios',
        onChange: vi.fn(),
      }),
    );
    openMenu();
    const menu = screen.getByRole('listbox');
    expect(within(menu).getByText('Martin, Anthony')).toBeInTheDocument();
  });

  it('marks the chosen option as selected', () => {
    render(
      createElement(SearchableSelect, {
        id: 'portfolioId',
        value: 'martin',
        options,
        selectedOption: offPageSelection,
        placeholder: 'All portfolios',
        onChange: vi.fn(),
      }),
    );
    openMenu();
    const row = screen.getByRole('option', { name: /Martin, Anthony/ });
    expect(row).toHaveAttribute('data-selected', 'true');
  });

  it('does not duplicate the chosen option when the page already contains it', () => {
    render(
      createElement(SearchableSelect, {
        id: 'portfolioId',
        value: 'two',
        options,
        selectedOption: { value: 'two', label: 'Austin Residential' },
        placeholder: 'All portfolios',
        onChange: vi.fn(),
      }),
    );
    openMenu();
    // Scoped to the menu: the trigger legitimately shows the same label.
    const menu = screen.getByRole('listbox');
    expect(within(menu).getAllByText('Austin Residential')).toHaveLength(1);
  });

  it('drops the pinned option once a search is typed', () => {
    // A row that does not match what was typed is noise; the trigger still
    // carries the current value.
    render(
      createElement(SearchableSelect, {
        id: 'portfolioId',
        value: 'martin',
        options,
        selectedOption: offPageSelection,
        placeholder: 'All portfolios',
        onChange: vi.fn(),
        onSearch: vi.fn(),
      }),
    );
    // openMenu returns the trigger: once open, CommandInput is also a combobox.
    const trigger = openMenu();
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'Westlake' } });
    // Gone from the menu, but still on the trigger — the value is unchanged.
    expect(within(screen.getByRole('listbox')).queryByText('Martin, Anthony')).toBeNull();
    expect(trigger).toHaveTextContent('Martin, Anthony');
  });

  it('still renders the full list when nothing is selected', () => {
    render(
      createElement(SearchableSelect, {
        id: 'portfolioId',
        value: '',
        options,
        placeholder: 'All portfolios',
        onChange: vi.fn(),
      }),
    );
    openMenu();
    expect(screen.getAllByRole('option')).toHaveLength(options.length);
  });
});
