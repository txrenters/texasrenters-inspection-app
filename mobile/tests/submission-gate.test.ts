import {
  evaluateSubmissionGate,
  type SubmittableRoom,
} from '../src/utils/submission-gate';

function room(overrides: Partial<SubmittableRoom> = {}): SubmittableRoom {
  return {
    id: 'room-1',
    name: 'Library',
    isRequired: true,
    completionStatus: 'COMPLETED',
    summary: null,
    ...overrides,
  };
}

describe('inspection submission gate', () => {
  it('allows submission once required areas are finished', () => {
    const gate = evaluateSubmissionGate([room(), room({ id: 'room-2', name: 'Kitchen' })], 'IN_PROGRESS');

    expect(gate.canSubmit).toBe(true);
    expect(gate.blockedReason).toBeUndefined();
  });

  it('counts an uploaded area as finished and a saved recording as not', () => {
    // The distinction the office depends on: UPLOADED means Cloudflare has the
    // bytes, RECORDING_SAVED means they are still on one phone.
    expect(
      evaluateSubmissionGate([room({ completionStatus: 'UPLOADED' })], 'IN_PROGRESS').canSubmit,
    ).toBe(true);
    expect(
      evaluateSubmissionGate([room({ completionStatus: 'RECORDING_SAVED' })], 'IN_PROGRESS')
        .canSubmit,
    ).toBe(false);
  });

  it('does not block on optional areas', () => {
    const gate = evaluateSubmissionGate(
      [room(), room({ id: 'room-2', isRequired: false, completionStatus: 'NOT_STARTED' })],
      'IN_PROGRESS',
    );

    expect(gate.canSubmit).toBe(true);
  });

  it('never blocks on a summary, whatever analysis produced', () => {
    for (const summary of [null, undefined, '', 'Scuffed wall by the door.']) {
      const gate = evaluateSubmissionGate([room({ summary })], 'IN_PROGRESS');
      expect(gate.canSubmit).toBe(true);
    }
  });

  it('every blocking reason is clearable by the technician', () => {
    // Stronger than the case above: whatever blocks, acting on the areas the
    // gate itself names has to unblock it. A reason that survives its own
    // remedy is an unsatisfiable gate.
    const rooms = [
      room({ id: 'a', completionStatus: 'NOT_STARTED' }),
      // Carries an unconfirmed summary and a running analysis: neither may
      // block, so finishing area 'a' has to be enough on its own.
      room({ id: 'b', summary: 'Cracked tile.', analysisPending: true }),
    ];
    const blocked = evaluateSubmissionGate(rooms, 'IN_PROGRESS');
    expect(blocked.canSubmit).toBe(false);

    const remedied = rooms.map((item) => ({
      ...item,
      completionStatus: blocked.incompleteRequiredRooms.some((entry) => entry.id === item.id)
        ? 'COMPLETED'
        : item.completionStatus,
    }));

    expect(evaluateSubmissionGate(remedied, 'IN_PROGRESS').canSubmit).toBe(true);
  });

  describe('analysis no longer blocks', () => {
    /**
     * Summaries are written after the handover now, and read by the office. The
     * technician used to be held in the property until analysis finished and
     * they had confirmed each one; that bought nothing a reviewer does not do
     * better with the video in front of them.
     */
    it('submits while a summary is still being written', () => {
      const gate = evaluateSubmissionGate(
        [room({ completionStatus: 'UPLOADED', analysisPending: true })],
        'IN_PROGRESS',
      );

      expect(gate.canSubmit).toBe(true);
      // Still reported, so the screen can say analysis is running.
      expect(gate.analysisPendingRooms).toHaveLength(1);
    });

    it('submits with a summary nobody confirmed', () => {
      const gate = evaluateSubmissionGate(
        [room({ completionStatus: 'UPLOADED', summary: 'Scuffed wall by the door.' })],
        'IN_PROGRESS',
      );

      expect(gate.canSubmit).toBe(true);
      expect(gate.blockedReason).toBeUndefined();
    });
  });
});
