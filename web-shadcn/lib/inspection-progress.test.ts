import { describe, expect, it } from 'vitest';

import { attentionBanner, inspectionProgress, primaryAction } from './inspection-progress';

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
  it('does not point at finalization before it is reachable', () => {
    // It used to be the most prominent thing on the page from load, usually for
    // a step nobody could take yet.
    for (const status of ['SCHEDULED', 'IN_PROGRESS'] as const)
      expect(primaryAction(status)?.label).not.toMatch(/finali/i);
  });

  it('sends the administrator to the evidence while capture is under way', () => {
    expect(primaryAction('IN_PROGRESS')).toEqual({
      label: 'Review evidence',
      target: 'area-evidence-heading',
    });
  });

  it('points at finalization once review is under way', () => {
    expect(primaryAction('UNDER_REVIEW')?.target).toBe('inspection-workflow-title');
  });

  it('offers nothing once the inspection is closed', () => {
    expect(primaryAction('COMPLETED')).toBeNull();
    expect(primaryAction('CANCELLED')).toBeNull();
  });

  it('only ever navigates, never triggers a decision', () => {
    // Finalization is gated inside the workflow panel — pending findings,
    // permissions, inspection state. A header button that performed it would be
    // an ungated copy of a gated decision.
    const statuses = ['SCHEDULED', 'IN_PROGRESS', 'TECHNICIAN_SUBMITTED', 'UNDER_REVIEW'] as const;
    for (const status of statuses) expect(primaryAction(status)?.target).toBeTruthy();
  });
});

describe('the attention banner', () => {
  it('stays silent when nothing needs saying', () => {
    // A banner that is always there is one people learn to stop reading.
    expect(attentionBanner('UNDER_REVIEW', 0)).toBeNull();
    expect(attentionBanner('TECHNICIAN_SUBMITTED', 0)).toBeNull();
  });

  it('says nothing once the inspection is closed', () => {
    // The status badge already carries this.
    expect(attentionBanner('COMPLETED', 0)).toBeNull();
    expect(attentionBanner('CANCELLED', 3)).toBeNull();
  });

  it('explains why finalization is unavailable while capture runs', () => {
    // The finalization card used to occupy a whole section saying this, whether
    // or not it applied.
    const banner = attentionBanner('IN_PROGRESS', 0);
    expect(banner?.tone).toBe('info');
    expect(banner?.body).toMatch(/unlocks once the technician submits/i);
  });

  it('puts a decision the reviewer can make now above one they are waiting on', () => {
    // Findings can be reviewed while the technician is still in the property.
    const banner = attentionBanner('IN_PROGRESS', 2);
    expect(banner?.tone).toBe('warning');
    expect(banner?.title).toMatch(/review required/i);
  });

  it('counts findings in words a person reads', () => {
    expect(attentionBanner('REVIEW_REQUIRED', 1)?.body).toMatch(/1 AI finding must/);
    expect(attentionBanner('REVIEW_REQUIRED', 4)?.body).toMatch(/4 AI findings must/);
  });
});
