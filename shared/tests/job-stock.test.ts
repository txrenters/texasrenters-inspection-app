import { describe, expect, it } from 'vitest';

import { PHONE_SLIP_KINDS, jobStockProblem, jobStockTaken, type JobStockSlip } from '../src/index.js';

/** A job's materials on the phone, phase 7 (2026-11-19). Every item invented. */

const name = (itemId: string) => (itemId === 'filter' ? 'FLT-0003' : 'PRT-0001');
const line = (itemId: string, quantity: number) => ({ itemId, code: name(itemId), name: itemId, unit: 'each', quantity });
const slip = (kind: JobStockSlip['kind'], lines: ReturnType<typeof line>[], reversed = false) => ({ kind, reversed, lines });

describe('what the phone may record', () => {
  it('is taking out and bringing back, never a move between places', () => {
    expect(PHONE_SLIP_KINDS).toEqual(['WITHDRAWAL', 'RETURN']);
  });

  it('is nothing until something is chosen', () => {
    expect(jobStockProblem('WITHDRAWAL', [], new Map(), name)).toBe('Choose what you took.');
    expect(jobStockProblem('RETURN', [{ itemId: 'filter', quantity: 0 }], new Map([['filter', 2]]), name)).toBe('Choose what is going back.');
  });

  it('never takes more than is in the truck', () => {
    const truck = new Map([['filter', 10], ['battery', 1]]);
    expect(jobStockProblem('WITHDRAWAL', [{ itemId: 'filter', quantity: 10 }], truck, name)).toBeNull();
    expect(jobStockProblem('WITHDRAWAL', [{ itemId: 'filter', quantity: 11 }], truck, name)).toBe('Only 10 of FLT-0003 are in the truck.');
    expect(jobStockProblem('WITHDRAWAL', [{ itemId: 'battery', quantity: 2 }], truck, name)).toBe('Only 1 of PRT-0001 is in the truck.');
    expect(jobStockProblem('WITHDRAWAL', [{ itemId: 'battery', quantity: 1 }], new Map(), name)).toBe('None of PRT-0001 is in the truck.');
  });

  it('never puts back more than was taken for the job', () => {
    const taken = new Map([['filter', 2]]);
    expect(jobStockProblem('RETURN', [{ itemId: 'filter', quantity: 2 }], taken, name)).toBeNull();
    expect(jobStockProblem('RETURN', [{ itemId: 'filter', quantity: 3 }], taken, name)).toBe('You took 2 of FLT-0003 for this job, so 3 cannot go back.');
    expect(jobStockProblem('RETURN', [{ itemId: 'battery', quantity: 1 }], taken, name)).toBe('You took 0 of PRT-0001 for this job, so 1 cannot go back.');
  });
});

describe('what was taken for a job', () => {
  it('is what left less what came back, by item, without what the office reversed', () => {
    expect(jobStockTaken([slip('WITHDRAWAL', [line('filter', 3), line('battery', 1)]), slip('RETURN', [line('filter', 1)]), slip('WITHDRAWAL', [line('filter', 5)], true)])).toEqual([line('filter', 2), line('battery', 1)]);
  });

  it('leaves out what all went back', () => {
    expect(jobStockTaken([slip('WITHDRAWAL', [line('filter', 2)]), slip('RETURN', [line('filter', 2)])])).toEqual([]);
    expect(jobStockTaken([])).toEqual([]);
  });
});
