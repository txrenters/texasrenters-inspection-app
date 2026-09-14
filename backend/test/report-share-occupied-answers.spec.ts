import { ReportShareService } from '../src/admin/report-share.service';

/**
 * An occupied room's answers reach the shared report.
 *
 * An occupied inspection asks each room two questions and stores the chosen
 * option in `textValue`, with the clean / undamaged / working axes all null.
 * The report selected only the axes and the comment, so both rows printed
 * empty -- on the page and in the PDF -- while the console showed "Clean" and
 * "Good" for the same room.
 */

function build(
  checklistResponses: Array<{
    textValue: string | null;
    checklistItem: { id: string; label: string; keywords: string[]; kind: string; responseType: string };
  }>,
) {
  const prisma = {
    inspectionReportShare: {
      findUnique: jest.fn().mockResolvedValue({
        inspectionId: 'inspection-1',
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        createdBy: { displayName: 'Operations Team' },
      }),
    },
    inspection: {
      findUnique: jest.fn().mockResolvedValue({
        inspectionType: 'OCCUPIED',
        assignments: [],
        status: 'COMPLETED',
        scheduledAt: new Date('2026-09-14T00:00:00Z'),
        completedAt: new Date('2026-09-14T18:00:00Z'),
        propertywareBuilding: {
          name: '12414 Montebello Manor Lane',
          addressLine1: '12414 Montebello Manor Lane',
          city: 'Houston',
          state: 'TX',
          postalCode: '77000',
        },
        areas: [
          {
            id: 'area-1',
            propertyAreaId: 'property-area-1',
            completionStatus: 'COMPLETED',
            skipReason: null,
            completedAt: new Date('2026-09-14T17:00:00Z'),
            propertyArea: { name: 'Entrance', floor: null },
            checklistResponses: checklistResponses.map((response) => ({
              isClean: null,
              isUndamaged: null,
              isWorking: null,
              comment: null,
              ...response,
            })),
            photos: [],
          },
        ],
        findings: [],
      }),
    },
  };
  return { service: new ReportShareService(prisma as never), prisma };
}

describe('the shared report of an occupied inspection', () => {
  it('carries each question’s answer', async () => {
    const { service } = build([
      {
        textValue: 'Clean',
        checklistItem: { id: 'occ-1', label: 'Room condition', keywords: [], kind: 'OCCUPIED', responseType: 'CHOICE' },
      },
      {
        textValue: 'Good',
        checklistItem: { id: 'occ-2', label: 'Overall condition', keywords: [], kind: 'OCCUPIED', responseType: 'CHOICE' },
      },
    ]);

    const report = await service.publicReport('valid-token');

    expect(report.rooms[0].checklist).toEqual([
      expect.objectContaining({ id: 'occ-1', responseType: 'CHOICE', textValue: 'Clean', isUndamaged: null }),
      expect.objectContaining({ id: 'occ-2', responseType: 'CHOICE', textValue: 'Good' }),
    ]);
  });

  it('asks the database for the answer and what kind of item it answers', async () => {
    const { service, prisma } = build([]);

    await service.publicReport('valid-token');

    const select = prisma.inspection.findUnique.mock.calls[0][0].select.areas.select.checklistResponses.select;
    expect(select.textValue).toBe(true);
    expect(select.checklistItem.select).toMatchObject({ kind: true, responseType: true });
  });

  it('publishes no HVAC answer, which has never appeared on a report', async () => {
    // Readings and free text: scoped out so every other report stays exactly
    // what it was.
    const { service } = build([
      {
        textValue: 'Filter replaced, coil dirty',
        checklistItem: { id: 'ac-1', label: 'Notes', keywords: [], kind: 'AIR_CONDITIONING', responseType: 'TEXT' },
      },
    ]);

    const report = await service.publicReport('valid-token');

    expect(report.rooms[0].checklist[0]).not.toHaveProperty('textValue');
    expect(report.rooms[0].checklist[0]).not.toHaveProperty('responseType');
  });
});
