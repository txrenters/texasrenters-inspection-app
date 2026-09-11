import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TechnicianDaySummary } from './technician-day-summary';

/**
 * The figures a dispatcher acts on, and the two ways they could mislead.
 *
 * A projection that hides whether it measured anything invites a decision the
 * evidence does not support; a total that always reconciles hides time the
 * trail could not explain.
 */

const timeline = (over: Record<string, unknown> = {}) =>
  ({
    technicianId: 'tech-a',
    segments: [],
    totals: {
      onSiteSeconds: 3 * 3600,
      travellingSeconds: 3600,
      shiftSeconds: 4 * 3600,
      visits: 3,
    },
    projection: {
      projectedFinishAt: '2026-09-12T22:40:00.000Z',
      remainingSeconds: 2 * 3600,
      stopsRemaining: 2,
      perVisitSeconds: 3600,
      basis: 'MEASURED',
    },
    stops: [],
    untimedInspectionIds: [],
    ...over,
  }) as never;

describe('a technician day summary', () => {
  it('says nothing happened rather than showing zeroes', () => {
    // A card of zeroes reads as "they did nothing today". The truth is that
    // nobody has heard from them, which is a different thing to act on.
    render(
      <TechnicianDaySummary
        timeline={timeline({
          totals: { onSiteSeconds: 0, travellingSeconds: 0, shiftSeconds: 0, visits: 0 },
        })}
      />,
    );

    expect(screen.getByText(/no position reported today/i)).toBeInTheDocument();
  });

  it('says when the projection measured this technician', () => {
    render(<TechnicianDaySummary timeline={timeline()} />);
    expect(screen.getByText(/measured today/i)).toBeInTheDocument();
  });

  it('says when it is only assuming', () => {
    /**
     * A day with nothing finished has nothing to measure. Presenting the
     * placeholder as derived is the problem this whole feature exists to
     * remove, so the wording changes rather than only the number.
     */
    render(
      <TechnicianDaySummary
        timeline={timeline({
          projection: {
            projectedFinishAt: '2026-09-12T22:40:00.000Z',
            remainingSeconds: 2 * 3600,
            stopsRemaining: 2,
            perVisitSeconds: 2400,
            basis: 'ESTIMATED',
          },
        })}
      />,
    );

    expect(screen.getByText(/assuming/i)).toBeInTheDocument();
    expect(screen.queryByText(/measured today/i)).not.toBeInTheDocument();
  });

  it('surfaces time the trail could not account for', () => {
    // On-site plus driving need not equal the shift. Folding the difference
    // into either bucket would make every figure here quietly untrue.
    render(
      <TechnicianDaySummary
        timeline={timeline({
          totals: {
            onSiteSeconds: 3600,
            travellingSeconds: 1800,
            shiftSeconds: 4 * 3600,
            visits: 1,
          },
        })}
      />,
    );

    expect(screen.getByText(/unaccounted/i)).toBeInTheDocument();
  });

  it('does not nag about a rounding-sized gap', () => {
    render(<TechnicianDaySummary timeline={timeline()} />);
    expect(screen.queryByText(/unaccounted/i)).not.toBeInTheDocument();
  });

  it('says which stops could not be timed at all', () => {
    render(<TechnicianDaySummary timeline={timeline({ untimedInspectionIds: ['a', 'b'] })} />);
    expect(screen.getByText(/could not be timed/i)).toBeInTheDocument();
  });
});
