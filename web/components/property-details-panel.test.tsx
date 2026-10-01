import { fireEvent, render, screen } from '@testing-library/react';
import type { PropertyDetailsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyDetailsPanel } from './property-details-panel';

/**
 * The property page's Details tab (the office, 2026-10-01): everything
 * Propertyware holds, with the access codes behind Show. Everything invented.
 */

const queries = vi.hoisted(() => ({ usePropertyPrivateDetails: vi.fn() }));
vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...queries };
});

const details: PropertyDetailsView = {
  building: {
    yearBuilt: 2004,
    floors: 2,
    bedrooms: 3,
    bathrooms: 2,
    neighborhood: 'Example Park',
    county: 'Harris County',
    parcelNumber: null,
    amenities: [],
  },
  leasing: {
    status: 'Occupied',
    ready: null,
    rentable: true,
    availableDate: null,
    targetRent: 1850,
    targetDeposit: null,
    petsAllowed: true,
    smokingAllowed: false,
    publishedForRent: null,
    postingTitle: null,
    description: null,
    comments: null,
  },
  management: {
    contractStart: null,
    contractEnd: null,
    maintenanceLimit: 300,
    maintenanceLimitPeriod: 'Per Request',
    maintenanceNotice: null,
    managers: [],
  },
  updated: { at: '2026-09-30T21:25:43Z', by: 'Office Person' },
  customFields: [
    { name: 'Occupancy Status', value: 'In Lease' },
    { name: 'Make Ready Notes', value: 'Not Completed' },
  ],
  accessFieldsOnFile: 2,
};

const owner = { owners: 'Sam Owner', portfolioName: 'Owner, Sam', managementAgreementSignedOn: '2021-02-08', phonesOnFile: true };

beforeEach(() => {
  queries.usePropertyPrivateDetails.mockReset().mockImplementation((_id: string, enabled: boolean) => ({
    data: enabled
      ? { access: [{ name: 'Lockbox Code', label: 'Lockbox Code', value: '1234' }], ownerPhones: { mobile: '(555) 010-0000', home: null } }
      : undefined,
    isError: false,
  }));
});

describe('the Details tab', () => {
  it('shows the office’s fields, with what nobody has entered yet as empty', () => {
    render(<PropertyDetailsPanel canSeePrivate={false} property={{ id: 'p1', details, owner }} />);

    expect(screen.getByText('Status & make ready')).toBeTruthy();
    expect(screen.getByText('In Lease')).toBeTruthy();
    expect(screen.queryByText('Not Completed')).toBeNull();
    expect(screen.getByText('Sam Owner')).toBeTruthy();
    expect(screen.getByText(/Last changed in Propertyware .* by Office Person/)).toBeTruthy();
  });

  it('never asks for the codes for someone who cannot manage properties', () => {
    render(<PropertyDetailsPanel canSeePrivate={false} property={{ id: 'p1', details, owner }} />);

    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
    expect(screen.getByText(/2 access codes on file/)).toBeTruthy();
    expect(queries.usePropertyPrivateDetails).toHaveBeenCalledWith('p1', false);
    expect(screen.queryByText('1234')).toBeNull();
  });

  it('asks for them only when a manager presses Show', () => {
    render(<PropertyDetailsPanel canSeePrivate property={{ id: 'p1', details, owner }} />);
    expect(screen.queryByText('1234')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show/i }));

    expect(queries.usePropertyPrivateDetails).toHaveBeenLastCalledWith('p1', true);
    expect(screen.getByText('1234')).toBeTruthy();
    expect(screen.getByText('(555) 010-0000')).toBeTruthy();
  });

  it('says so when the sync has not described the property yet', () => {
    render(<PropertyDetailsPanel canSeePrivate property={{ id: 'p1', details: null, owner: null }} />);

    expect(screen.getByText('Details not synchronized yet')).toBeTruthy();
  });
});
