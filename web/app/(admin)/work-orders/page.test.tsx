import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import WorkOrdersPage from './page';

describe('the work orders page', () => {
  it('is headed as the sidebar names it, and says where the visits already show', () => {
    render(<WorkOrdersPage />);

    expect(screen.getByRole('heading', { name: 'Work orders' })).toBeVisible();
    expect(screen.getByText(/filed as Maintenance and Pest control visits/)).toBeVisible();
  });
});
