/**
 * A `rescheduleRequest` delegate for a Prisma double: no request open, every
 * write accepted.
 *
 * Ending a visit, moving one, cancelling one, and the Jobber sync's moves and
 * imports all open, answer or settle a reschedule request in the same
 * transaction (2026-10-21), so a double standing in for any of those paths
 * needs one. A spec about the requests themselves overrides what it reads.
 */
export function rescheduleRequestDelegate() {
  return {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'reschedule-request-1' }),
    update: jest.fn().mockResolvedValue({ id: 'reschedule-request-1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
}
