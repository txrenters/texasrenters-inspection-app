import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SearchableSelect } from './searchable-select';

const options = [
  { value: 'one', label: '1150 LLC' },
  { value: 'two', label: 'Austin Residential' },
  { value: 'three', label: 'Westlake Portfolio' },
];

describe('SearchableSelect', () => {
  it('filters options and selects a portfolio', () => {
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

    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'west' } });

    expect(screen.queryByRole('option', { name: '1150 LLC' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Westlake Portfolio' }));
    expect(onChange).toHaveBeenCalledWith('three');
  });

  it('shows the selected label and supports keyboard selection', () => {
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

    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('1150 LLC');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'austin' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('Austin Residential');
  });

  it('requests the next page only when the menu is scrolled near the bottom', () => {
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

    fireEvent.focus(screen.getByRole('combobox'));
    const menu = screen.getByRole('listbox').parentElement!;
    Object.defineProperties(menu, {
      scrollHeight: { value: 400 },
      clientHeight: { value: 100 },
      scrollTop: { value: 260, writable: true },
    });
    fireEvent.scroll(menu);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
