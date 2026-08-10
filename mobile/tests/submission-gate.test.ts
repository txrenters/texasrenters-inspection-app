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

  it('blocks on an unconfirmed AI summary and names the area', () => {
    const gate = evaluateSubmissionGate(
      [room({ summary: 'Water staining below the window.' })],
      'IN_PROGRESS',
    );

    expect(gate.canSubmit).toBe(false);
    expect(gate.blockedReason).toBe('Confirm AI summaries first');
    expect(gate.unconfirmedSummaryRooms.map((item) => item.name)).toEqual(['Library']);
  });

  it('clears once the technician confirms', () => {
    const gate = evaluateSubmissionGate(
      [room({ summary: 'Water staining.', summaryConfirmedAt: '2026-08-11T09:00:00.000Z' })],
      'IN_PROGRESS',
    );

    expect(gate.canSubmit).toBe(true);
    expect(gate.unconfirmedSummaryRooms).toHaveLength(0);
  });

  /**
   * The property that matters most, and the one the previous gate violated.
   *
   * Analysis is not guaranteed — the provider can be down, out of credits, or
   * the audio unusable. If a summary-less area could block submission, a
   * technician would be stranded behind a condition no amount of field work
   * clears, which is exactly the failure this gate was rewritten to end.
   */
  it('never blocks on an area that has no summary, however analysis ended', () => {
    for (const summary of [null, undefined, '']) {
      const gate = evaluateSubmissionGate([room({ summary })], 'IN_PROGRESS');
      expect(gate.canSubmit).toBe(true);
      expect(gate.unconfirmedSummaryRooms).toHaveLength(0);
    }
  });

  it('every blocking reason is clearable by the technician', () => {
    // Stronger than the case above: whatever blocks, acting on the areas the
    // gate itself names has to unblock it. A reason that survives its own
    // remedy is an unsatisfiable gate.
    const rooms = [
      room({ id: 'a', completionStatus: 'NOT_STARTED' }),
      room({ id: 'b', summary: 'Cracked tile.' }),
    ];
    const blocked = evaluateSubmissionGate(rooms, 'IN_PROGRESS');
    expect(blocked.canSubmit).toBe(false);

    const remedied = rooms.map((item) => ({
      ...item,
      completionStatus: blocked.incompleteRequiredRooms.some((r) => r.id === item.id)
        ? 'COMPLETED'
        : item.completionStatus,
      summaryConfirmedAt: blocked.unconfirmedSummaryRooms.some((r) => r.id === item.id)
        ? '2026-08-11T09:00:00.000Z'
        : item.summaryConfirmedAt,
    }));

    expect(evaluateSubmissionGate(remedied, 'IN_PROGRESS').canSubmit).toBe(true);
  });

  describe('the analysis race', () => {
    /**
     * The defect this closes: a summary arrives roughly twenty seconds after an
     * upload lands, and a technician who submits inside that window has nothing
     * to confirm. Every room-level check passes honestly, they submit, and the
     * summary shows up afterwards with nobody having read it.
     */
    it('blocks while a summary is still being written', () => {
      const gate = evaluateSubmissionGate(
        [room({ analysisPending: true })],
        'IN_PROGRESS',
      );

      expect(gate.canSubmit).toBe(false);
      expect(gate.blockedReason).toBe('Waiting for AI analysis');
      expect(gate.analysisPendingRooms).toHaveLength(1);
      // Nothing to confirm *yet* — the area must not also be reported as
      // awaiting the technician, or the screen shows two tasks for one wait.
      expect(gate.unconfirmedSummaryRooms).toHaveLength(0);
    });

    it('hands over to the confirm step once the summary lands', () => {
      const analyzing = room({ analysisPending: true });
      expect(evaluateSubmissionGate([analyzing], 'IN_PROGRESS').blockedReason).toBe(
        'Waiting for AI analysis',
      );

      const landed = { ...analyzing, analysisPending: false, summary: 'Lights not working.' };
      expect(evaluateSubmissionGate([landed], 'IN_PROGRESS').blockedReason).toBe(
        'Confirm AI summaries first',
      );

      const confirmed = { ...landed, summaryConfirmedAt: '2026-08-11T09:00:00.000Z' };
      expect(evaluateSubmissionGate([confirmed], 'IN_PROGRESS').canSubmit).toBe(true);
    });

    it('does not block when analysis produced nothing and stopped', () => {
      // The pipeline can finish with no summary — unusable audio, a provider
      // outage. `analysisPending` false is the server saying "not coming".
      const gate = evaluateSubmissionGate(
        [room({ analysisPending: false, summary: null })],
        'IN_PROGRESS',
      );

      expect(gate.canSubmit).toBe(true);
    });

    it('treats an absent flag as nothing pending', () => {
      // An older backend cannot report this. Absent must mean "not waiting" —
      // defaulting the other way would block every submission against it.
      expect(evaluateSubmissionGate([room()], 'IN_PROGRESS').canSubmit).toBe(true);
    });

    it('still resolves when waiting and confirming are both outstanding', () => {
      // Two areas at different stages. Whatever the gate names has to be
      // clearable, including when the remedies differ per area.
      const rooms = [
        room({ id: 'a', analysisPending: true }),
        room({ id: 'b', summary: 'Cracked tile.' }),
      ];
      expect(evaluateSubmissionGate(rooms, 'IN_PROGRESS').blockedReason).toBe(
        'Waiting for AI analysis',
      );

      const settled = rooms.map((item) => ({
        ...item,
        analysisPending: false,
        summary: item.summary ?? 'Lights out.',
        summaryConfirmedAt: '2026-08-11T09:00:00.000Z',
      }));
      expect(evaluateSubmissionGate(settled, 'IN_PROGRESS').canSubmit).toBe(true);
    });
  });

  it('reports incomplete rooms before unconfirmed summaries', () => {
    // An area with no evidence has no summary to read yet, so sending the
    // technician to confirm first would be advice they cannot act on.
    const gate = evaluateSubmissionGate(
      [room({ id: 'a', completionStatus: 'NOT_STARTED' }), room({ id: 'b', summary: 'Tile.' })],
      'IN_PROGRESS',
    );

    expect(gate.blockedReason).toBe('Complete required rooms first');
  });

  it('refuses when the inspection is not in progress', () => {
    // Already submitted, or never started. Neither is a state the review screen
    // can submit from, and both would otherwise pass every room-level check.
    for (const status of ['SCHEDULED', 'TECHNICIAN_SUBMITTED', 'COMPLETED', 'CANCELLED']) {
      const gate = evaluateSubmissionGate([room()], status);
      expect(gate.canSubmit).toBe(false);
      expect(gate.blockedReason).toBe('Submission unavailable');
    }
  });
});
