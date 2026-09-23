import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyGeofenceCard } from './property-geofence-card';

/**
 * Setting how close counts as being at a property.
 *
 * This is the number the Timesheet's hours are computed from, so the card has
 * to refuse a value the server would refuse — and say why while somebody is
 * typing, rather than after a round trip.
 */

const mutations = vi.hoisted(() => ({
  setPropertyGeofence: { mutate: vi.fn(), isPending: false },
  clearPropertyGeofence: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/queries', () => ({ useAdminMutations: () => mutations }));

const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => permissions.allowed }) }));

const ON_DEFAULTS = { enterRadiusMeters: 40, exitRadiusMeters: 60, centreMoved: false, set: false };

function mount(geofence = ON_DEFAULTS) {
  return render(<PropertyGeofenceCard geofence={geofence} propertyId="prop-1" />);
}

const arrival = () => screen.getByLabelText(/Arrival within/);
const departure = () => screen.getByLabelText(/Left after/);
const save = () => screen.getByRole('button', { name: /Save/ });

beforeEach(() => {
  vi.clearAllMocks();
  permissions.allowed = true;
  mutations.setPropertyGeofence.isPending = false;
  mutations.clearPropertyGeofence.isPending = false;
});

describe('setting the distances', () => {
  it('starts on whatever the property currently uses', () => {
    mount({ ...ON_DEFAULTS, enterRadiusMeters: 120, exitRadiusMeters: 160, set: true });

    expect(arrival()).toHaveValue('120');
    expect(departure()).toHaveValue('160');
  });

  it('saves a wider pair, for a property on a large lot', () => {
    mount();
    fireEvent.change(arrival(), { target: { value: '150' } });
    fireEvent.change(departure(), { target: { value: '200' } });
    fireEvent.click(save());

    expect(mutations.setPropertyGeofence.mutate).toHaveBeenCalledWith(
      { propertyId: 'prop-1', enterRadiusMeters: 150, exitRadiusMeters: 200 },
      expect.anything(),
    );
  });

  /**
   * The gap is the point of having two numbers, and the office is told so
   * before it is refused rather than by being refused.
   */
  it('refuses a departure distance that is not the larger one, and says why', () => {
    mount();
    fireEvent.change(departure(), { target: { value: '40' } });

    expect(save()).toBeDisabled();
    expect(screen.getByText(/larger than the arrival distance/)).toBeInTheDocument();
  });

  /** The office asked for 6 m; the handsets cannot measure it. */
  it('refuses a radius tighter than the handsets can measure', () => {
    mount();
    fireEvent.change(arrival(), { target: { value: '6' } });

    expect(save()).toBeDisabled();
    expect(screen.getByText(/between 10 and 500/)).toBeInTheDocument();
  });

  it('will not save what is already saved', () => {
    mount();

    expect(save()).toBeDisabled();
  });
});

describe('the standard distances', () => {
  /**
   * "Nobody decided" and "somebody chose 40" are different states, and only
   * the first should move if the default ever changes. So the card says which
   * this property is, and only offers to undo a real decision.
   */
  it('says when a property is only on the standard distances', () => {
    mount();

    expect(screen.getByText(/uses the standard ones/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /standard distances/ })).not.toBeInTheDocument();
  });

  it('offers to go back once somebody has set its own', () => {
    mount({ ...ON_DEFAULTS, set: true });
    fireEvent.click(screen.getByRole('button', { name: /Use the standard distances/ }));

    expect(mutations.clearPropertyGeofence.mutate).toHaveBeenCalledWith(
      { propertyId: 'prop-1' },
      expect.anything(),
    );
  });

  /** A circle drawn off the building is a correction, not a bug. */
  it('explains a centre that has been moved off the pin', () => {
    mount({ ...ON_DEFAULTS, set: true, centreMoved: true });

    expect(screen.getByText(/moved off the geocoded pin/)).toBeInTheDocument();
  });
});

describe('who may change it', () => {
  it('shows the distances to somebody who may only read', () => {
    permissions.allowed = false;
    mount({ ...ON_DEFAULTS, enterRadiusMeters: 90, exitRadiusMeters: 120, set: true });

    expect(arrival()).toHaveValue('90');
    expect(arrival()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });
});
