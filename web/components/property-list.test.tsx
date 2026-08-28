import type { PropertyPosition } from '@texasrenters/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PropertyList } from './property-list';

/**
 * A list that can reach every property.
 *
 * It used to stop dead at 120 rows with a line explaining that it had — honest,
 * and useless: the remaining four hundred existed, were searchable, and could
 * not be reached by scrolling.
 */

function makeProperties(count: number): PropertyPosition[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    // Padded so string sorting matches numeric order and the assertions below
    // can talk about "the first page" meaningfully.
    name: `Property ${String(index).padStart(4, '0')}`,
    addressLine1: `${index} Test Street`,
    city: index % 2 === 0 ? 'Houston' : 'Conroe',
    state: 'TX',
    postalCode: '77000',
    latitude: 29.7 + index / 10_000,
    longitude: -95.4 - index / 10_000,
    geocodePrecision: null,
  }));
}

const ALL = makeProperties(546);

/** Captures observers so a test can drive the intersection itself. */
function stubObserver() {
  const instances: { trigger: () => void }[] = [];

  class Stub {
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      instances.push({
        trigger: () =>
          this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never),
      });
    }

    observe() {}
    disconnect() {}
    unobserve() {}
  }

  vi.stubGlobal('IntersectionObserver', Stub);
  return instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scrolling to the end', () => {
  it('starts with one page rather than everything', () => {
    stubObserver();
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);

    expect(screen.getByText('Property 0000')).toBeInTheDocument();
    // Well past the first page, so it must not be drawn yet.
    expect(screen.queryByText('Property 0300')).not.toBeInTheDocument();
  });

  it('pulls in the next page when the end comes into view', () => {
    const observers = stubObserver();
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);

    const before = screen.getAllByRole('button').length;
    // Wrapped, because the observer fires outside React's own event handling
    // and the state update would otherwise not be flushed before the assertion.
    act(() => observers.at(-1)?.trigger());
    expect(screen.getAllByRole('button').length).toBeGreaterThan(before);
  });

  it('says how far along it is while there is more', () => {
    stubObserver();
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);
    expect(screen.getByText(/of 546/)).toBeInTheDocument();
  });

  it('shows everything at once where the browser cannot observe', () => {
    // jsdom has no IntersectionObserver, and neither do some older browsers.
    // A longer list is a far smaller problem than a panel that throws.
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);

    expect(screen.getByText('Property 0545')).toBeInTheDocument();
    expect(screen.getByText(/All 546 properties/)).toBeInTheDocument();
  });
});

describe('searching', () => {
  it('narrows to matches and counts them against the whole set', () => {
    stubObserver();
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);

    fireEvent.change(screen.getByLabelText('Search properties'), {
      target: { value: 'Conroe' },
    });

    // 273 of the 546 are in Conroe. The progress line counts against the
    // matches, not the whole set, and must not claim to hold all 546.
    expect(screen.queryByText(/All 546 properties/)).not.toBeInTheDocument();
    expect(screen.getByText(/of 273/)).toBeInTheDocument();
  });

  it('says so plainly when nothing matches', () => {
    stubObserver();
    render(<PropertyList onSelect={() => {}} properties={ALL} selectedId={null} />);

    fireEvent.change(screen.getByLabelText('Search properties'), {
      target: { value: 'Reykjavik' },
    });

    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('has an empty state distinct from a search that found nothing', () => {
    stubObserver();
    render(<PropertyList onSelect={() => {}} properties={[]} selectedId={null} />);
    expect(screen.getByText(/No property has been placed on the map yet/)).toBeInTheDocument();
  });
});

describe('selecting', () => {
  it('reports the property, and clears it when chosen again', () => {
    stubObserver();
    const onSelect = vi.fn();

    const { rerender } = render(
      <PropertyList onSelect={onSelect} properties={ALL.slice(0, 3)} selectedId={null} />,
    );

    fireEvent.click(screen.getByText('Property 0000'));
    expect(onSelect).toHaveBeenCalledWith('p0');

    // Clicking the selected row is the way out, matching the roster.
    rerender(<PropertyList onSelect={onSelect} properties={ALL.slice(0, 3)} selectedId="p0" />);
    fireEvent.click(screen.getByText('Property 0000'));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
