import 'reflect-metadata';

import { describeFinalizeBlockers } from '../src/admin/admin.service';

function finding(title: string, area: string | null = 'Hall') {
  return { title, propertyArea: area ? { name: area } : null };
}
function recording(area: string | null = 'Hall') {
  return { inspectionArea: area ? { propertyArea: { name: area } } : null };
}

describe('finalize blocker message', () => {
  /**
   * The defect this replaced. An administrator saw "1 finding(s) awaiting
   * review and 0 recording(s) still processing" while the Findings tab showed
   * one finding, approved, and the area read "1 of 1 reviewed" — so the message
   * named a blocker they could not see and a zero they had to mentally discard.
   */
  it('mentions only the category that is actually blocking', () => {
    expect(describeFinalizeBlockers([finding('Cracked tile')], [])).not.toMatch(/recording/);
    expect(describeFinalizeBlockers([], [recording()])).not.toMatch(/finding/);
  });

  it('names the finding and its area, so it can be opened', () => {
    const message = describeFinalizeBlockers([finding('Cracked tile', 'Kitchen')], []);

    expect(message).toContain('Kitchen — Cracked tile');
    expect(message).toContain('1 finding still awaiting review');
    expect(message).toMatch(/Resolve it or document an override/);
  });

  it('lists both categories when both block', () => {
    const message = describeFinalizeBlockers([finding('Cracked tile')], [recording('Garage')]);

    expect(message).toContain('1 finding still awaiting review');
    expect(message).toContain('1 recording still processing');
    expect(message).toContain('Garage');
    // Plural remedy once there is more than one kind of blocker.
    expect(message).toMatch(/Resolve them/);
  });

  it('caps the named findings and says how many are left', () => {
    // A reviewer does not need twelve titles in a dialog; they need to know the
    // shape of the problem and where to start.
    const message = describeFinalizeBlockers(
      Array.from({ length: 12 }, (_, index) => finding(`Issue ${index + 1}`)),
      [],
    );

    expect(message).toContain('12 findings still awaiting review');
    expect(message).toContain('and 9 more');
  });

  it('survives a finding whose area was removed', () => {
    // propertyArea is nullable on the read; falling back to the bare title is
    // better than printing "undefined — Cracked tile" in front of a reviewer.
    const message = describeFinalizeBlockers([finding('Cracked tile', null)], []);

    expect(message).toContain('Cracked tile');
    expect(message).not.toMatch(/undefined|null/);
  });

  it('de-duplicates areas for recordings', () => {
    const message = describeFinalizeBlockers([], [recording('Hall'), recording('Hall')]);

    expect(message).toContain('2 recordings still processing');
    expect(message.match(/Hall/g)).toHaveLength(1);
  });
});
