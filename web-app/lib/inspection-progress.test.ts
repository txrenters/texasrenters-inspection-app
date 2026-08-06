import { describe, expect, it } from 'vitest';

import { inspectionProgress, primaryActionLabel } from './inspection-progress';

describe('workflow steps', () => {
  it('marks capture active while the technician is still recording', () => {
    const steps = inspectionProgress('IN_PROGRESS');
    expect(steps.map((step) => step.state)).toEqual(['active', 'pending', 'pending', 'pending']);
    // The detail is what "In progress" never said: which of the four stages is
    // actually running.
    expect(steps[0]!.detail).toMatch(/capturing/i);
  });

  it('completes every step before the current one', () => {
    // Derived from position rather than tracked per step, so the four states
    // cannot drift into disagreeing with each other.
    const steps = inspectionProgress('UNDER_REVIEW');
    expect(steps.map((step) => step.state)).toEqual(['complete', 'complete', 'active', 'pending']);
  });

  it('completes the whole path once finalized', () => {
    const steps = inspectionProgress('COMPLETED');
    expect(steps.map((step) => step.state)).toEqual([
      'complete',
      'complete',
      'complete',
      'active',
    ]);
  });

  it('does not show a cancelled inspection as merely pending', () => {
    // Three "pending" steps would imply the rest is still coming.
    const steps = inspectionProgress('CANCELLED');
    expect(steps[0]!.state).toBe('blocked');
    expect(steps[0]!.detail).toMatch(/cancelled/i);
    expect(steps.slice(1).every((step) => step.state === 'pending')).toBe(true);
  });

  it('gives every status a defined position', () => {
    // A status falling through to a default nobody chose is how a real state
    // ends up rendering as "not started".
    const statuses = [
      'SCHEDULED',
      'IN_PROGRESS',
      'TECHNICIAN_SUBMITTED',
      'PROCESSING',
      'REVIEW_REQUIRED',
      'UNDER_REVIEW',
      'TBD',
      'FOLLOW_UP_REQUIRED',
      'COMPLETED',
      'CANCELLED',
    ] as const;
    for (const status of statuses) {
      const steps = inspectionProgress(status);
      expect(steps).toHaveLength(4);
      expect(steps.some((step) => step.state === 'active' || step.state === 'blocked')).toBe(true);
    }
  });

  it('never labels two steps the same generic thing', () => {
    // The complaint this replaces: "In progress" beside "In progress" beside
    // "In progress", each meaning something different.
    const labels = inspectionProgress('IN_PROGRESS').map((step) => step.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('the one action worth emphasising', () => {
  it('does not offer finalization before it is possible', () => {
    // It used to be the most prominent control from page load, usually for an
    // action nobody could take.
    expect(primaryActionLabel('IN_PROGRESS')).not.toMatch(/finali/i);
    expect(primaryActionLabel('SCHEDULED')).not.toMatch(/finali/i);
  });

  it('offers review once the technician has submitted', () => {
    expect(primaryActionLabel('TECHNICIAN_SUBMITTED')).toMatch(/review/i);
  });

  it('offers finalization once review is under way', () => {
    expect(primaryActionLabel('UNDER_REVIEW')).toMatch(/finali/i);
  });

  it('offers nothing once the inspection is closed', () => {
    expect(primaryActionLabel('COMPLETED')).toBeNull();
    expect(primaryActionLabel('CANCELLED')).toBeNull();
  });
});
