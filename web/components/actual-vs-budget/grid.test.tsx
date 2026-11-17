import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';

import { Sheet, SheetHead } from './grid';

/**
 * A sheet fits the screen from where it starts, so its headings stick to its
 * top and its sideways scrollbar stays at the bottom of the screen (2026-11-17,
 * the office: "the horizontal scrollbar make it fixed and the header part too
 * make it sticky").
 */

afterEach(() => vi.restoreAllMocks());

const sheet = () =>
  render(
    <Sheet>
      <TableHeader>
        <TableRow>
          <SheetHead>Date</SheetHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>11/11/2026</TableCell>
        </TableRow>
      </TableBody>
    </Sheet>,
  );

describe('a sheet', () => {
  it('is as tall as the screen allows below it, and grows to fit again when the window does', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 280 } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    const { container } = sheet();
    const box = container.querySelector<HTMLElement>('[data-slot=sheet]')!;
    expect(box.style.maxHeight).toBe('600px');
    expect(box.className).toContain('overflow-auto');
    expect(box.className).toContain('[&_thead]:sticky');
    expect(box.className).toContain('[&_thead]:top-0');

    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1200 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(box.style.maxHeight).toBe('900px');
  });

  it('is never squeezed below a usable height on a short screen', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const { container } = sheet();
    expect(container.querySelector<HTMLElement>('[data-slot=sheet]')!.style.maxHeight).toBe('320px');
  });
});
