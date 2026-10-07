import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InspectionTabs } from './inspection-tabs';

const ID = 'insp-1';

describe('inspection tabs', () => {
  it('links a move-out’s overview and comparison to their own routes', () => {
    render(<InspectionTabs active="overview" inspectionId={ID} inspectionType="MOVE_OUT" />);

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/inspections/${ID}`,
    );
    expect(screen.getByRole('link', { name: 'Move-in comparison' })).toHaveAttribute(
      'href',
      `/inspections/${ID}/comparison`,
    );
  });

  // Hidden for now (the office, 2026-10-05): not one charge had been recorded.
  it('does not offer Charges', () => {
    render(<InspectionTabs active="overview" inspectionId={ID} inspectionType="MOVE_OUT" />);
    expect(screen.queryByRole('link', { name: 'Charges' })).toBeNull();
  });

  /**
   * With Charges hidden, an inspection that records no rooms on video has only
   * its overview, which a bar of one tab does not need to say.
   */
  it('shows no bar at all where the overview is the only section', () => {
    for (const type of [
      'OCCUPIED',
      'BACK_TO_MARKET',
      'HVAC',
      'ROOF',
      'SUPRA_LOCKBOX_PLACEMENT',
      'SUPRA_LOCKBOX_REMOVAL',
      'AC_FILTER_DELIVERY',
    ]) {
      const { unmount } = render(
        <InspectionTabs active="overview" inspectionId={ID} inspectionType={type} />,
      );
      expect(screen.queryByRole('navigation', { name: 'Inspection sections' })).toBeNull();
      unmount();
    }
  });

  // Every area's summary on one page (the maintenance team, 2026-10-07).
  it('offers the summaries of all areas on a move-in and a move-out', () => {
    for (const type of ['MOVE_IN', 'MOVE_OUT']) {
      const { unmount } = render(
        <InspectionTabs active="overview" inspectionId={ID} inspectionType={type} />,
      );
      expect(screen.getByRole('link', { name: 'Summaries of all areas' })).toHaveAttribute(
        'href',
        `/inspections/${ID}/summaries`,
      );
      unmount();
    }
    // A move-in is the baseline: summaries, but no comparison.
    render(<InspectionTabs active="summaries" inspectionId={ID} inspectionType="MOVE_IN" />);
    expect(screen.queryByRole('link', { name: 'Move-in comparison' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Summaries of all areas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks the open section for assistive tech, not colour alone', () => {
    render(<InspectionTabs active="comparison" inspectionId={ID} inspectionType="MOVE_OUT" />);

    expect(screen.getByRole('link', { name: 'Move-in comparison' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });

  it('still names the charge report as its own tab while it is open, with the way back', () => {
    // The overview lives at the base route, so a naive prefix match would light
    // it up on every sub-page at once.
    render(<InspectionTabs active="charges" inspectionId={ID} inspectionType="MOVE_IN" />);

    expect(screen.getByRole('link', { name: 'Charges' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});
