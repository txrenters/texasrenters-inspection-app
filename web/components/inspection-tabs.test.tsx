import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InspectionTabs } from './inspection-tabs';

const ID = 'insp-1';

describe('inspection tabs', () => {
  it('links every section to its own route', () => {
    render(<InspectionTabs active="overview" inspectionId={ID} inspectionType="MOVE_OUT" />);

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      `/inspections/${ID}`,
    );
    expect(screen.getByRole('link', { name: 'Move-in comparison' })).toHaveAttribute(
      'href',
      `/inspections/${ID}/comparison`,
    );
    // The charge report had a route and no entry point at all — a reviewer had
    // to know the URL.
    expect(screen.getByRole('link', { name: 'Charges' })).toHaveAttribute(
      'href',
      `/inspections/${ID}/charge-report`,
    );
  });

  /**
   * A move-in *is* the baseline, so there is nothing to compare it against.
   * Offering an always-empty tab on every other inspection would teach
   * reviewers to ignore the row.
   */
  it('offers the comparison only on a move-out', () => {
    for (const type of [
      'MOVE_IN',
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
      expect(screen.queryByRole('link', { name: 'Move-in comparison' })).toBeNull();
      unmount();
    }
  });

  it('marks the open section for assistive tech, not colour alone', () => {
    render(<InspectionTabs active="comparison" inspectionId={ID} inspectionType="MOVE_OUT" />);

    expect(screen.getByRole('link', { name: 'Move-in comparison' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Charges' })).not.toHaveAttribute('aria-current');
  });

  it('does not mark overview active from a sub-page', () => {
    // The overview lives at the base route, so a naive prefix match would light
    // it up on every sub-page at once.
    render(<InspectionTabs active="charges" inspectionId={ID} inspectionType="MOVE_OUT" />);

    expect(screen.getByRole('link', { name: 'Charges' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
  });
});
