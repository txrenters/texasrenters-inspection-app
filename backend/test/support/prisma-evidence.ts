/**
 * The evidence counters every inspection read runs, as a mock that returns none.
 *
 * `AdminService.inspection` asks three tables how much has actually been
 * recorded against an inspection — photographs, recordings and checklist
 * answers — because an area count cannot answer that: areas are snapshotted
 * onto an inspection at creation, so a record is born with rooms and nothing in
 * them.
 *
 * Seven mutation endpoints re-read through that method, so a spec that only
 * meant to create an inspection reaches all three delegates. When they were
 * added, thirty-three tests across four suites failed at once with
 * "Cannot read properties of undefined (reading 'count')" — not one of them
 * about evidence. Spread this into a prisma mock so the mock models the client
 * rather than the single call the test happens to make.
 */
export const ZERO_EVIDENCE = {
  inspectionArea: { count: jest.fn().mockResolvedValue(0) },
  inspectionFinding: { count: jest.fn().mockResolvedValue(0) },
  inspectionPhoto: { count: jest.fn().mockResolvedValue(0) },
  inspectionMedia: { count: jest.fn().mockResolvedValue(0) },
  inspectionAreaChecklistResponse: { count: jest.fn().mockResolvedValue(0) },
};
