import { AreaChecklistItemKind, InspectionType } from '@prisma/client';

import {
  type InspectionCreationClient,
  type InspectionPlan,
  insertInspection,
} from '../src/admin/inspection-creation';
import { checklistItemsAreOrganizationWide } from '../src/common/checklist-kind';

/**
 * An occupied inspection asks two questions per room, not eighty.
 *
 * Reported from the field 2026-09-09 by a technician who walked one: the
 * occupied visit was serving the byte-identical per-room list as a move-out,
 * because `checklistTemplateFor` took an area and nothing else. For a three-bed
 * house that is roughly eighty-three items, each a tri-state on three axes,
 * against a visit the office allows fifteen minutes.
 *
 * The rows are organization-wide, exactly as the HVAC list is. That is the part
 * worth testing on the backend rather than in `shared`: the wording is a
 * contract, but *where the rows live* is what decides whether the technician
 * sees them at all.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';

/** Records what was written without needing a database behind it. */
function client() {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const create = jest.fn().mockResolvedValue({ id: 'inspection-1' });
  return {
    tx: {
      areaChecklistItem: { createMany },
      inspection: { create },
    } as unknown as InspectionCreationClient,
    createMany,
    create,
  };
}

function plan(inspectionType: InspectionType): InspectionPlan {
  return {
    organizationId: ORGANIZATION,
    inspectionType,
    property: { id: 'building-1' },
    unit: null,
    lease: null,
    baselineInspectionId: null,
    scheduledAt: new Date('2026-09-09'),
    scheduledStartAt: null,
    scheduledEndAt: null,
    technicianWillCapture: false,
    scopedAreas: [{ id: 'area-kitchen' }, { id: 'area-bed-2' }],
  } as unknown as InspectionPlan;
}

const details = { createdById: 'user-1' } as Parameters<typeof insertInspection>[2];

describe('the occupied checklist is written where the technician will look for it', () => {
  it('writes the two questions once for the organization, not once per area', async () => {
    const { tx, createMany } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);

    expect(createMany).toHaveBeenCalledTimes(1);
    const rows = createMany.mock.calls[0][0].data as {
      kind: AreaChecklistItemKind;
      propertyAreaId: string | null;
      label: string;
      responseType: string;
      choices: string[];
      keywords: string[];
    }[];

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.label)).toEqual(['Room condition', 'Overall condition']);
    // The whole point of the shape. Two rows for the organization, not two rows
    // multiplied across every area of every property in the portfolio.
    expect(rows.every((row) => row.propertyAreaId === null)).toBe(true);
    expect(rows.every((row) => row.kind === AreaChecklistItemKind.OCCUPIED)).toBe(true);
    expect(rows.every((row) => row.responseType === 'CHOICE')).toBe(true);
    expect(rows[0].choices).toEqual(['Clean', 'Acceptable', 'Damaged', 'Needs attention']);
  });

  it('carries no keywords, so narration cannot answer it for the technician', () => {
    // A transcript never says "the overall condition of this room is Fair", and
    // matching the bare word "condition" would tick a judgement nobody made.
    const { tx, createMany } = client();
    return insertInspection(tx, plan(InspectionType.OCCUPIED), details).then(() => {
      const rows = createMany.mock.calls[0][0].data as { keywords: string[] }[];
      expect(rows.every((row) => row.keywords.length === 0)).toBe(true);
    });
  });

  it('leaves the area snapshot alone — only the questions changed', async () => {
    const { tx, create } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);

    // An occupied visit still walks the rooms the office scoped. Had this been
    // built like HVAC — one synthetic area standing for the whole property —
    // the technician would have lost the room-by-room walk entirely.
    expect(create.mock.calls[0][0].data.areas.create).toEqual([
      { propertyAreaId: 'area-kitchen' },
      { propertyAreaId: 'area-bed-2' },
    ]);
  });

  it.each([[InspectionType.MOVE_OUT], [InspectionType.MOVE_IN], [InspectionType.BACK_TO_MARKET]])(
    'writes nothing extra for %s, which keeps the full room list',
    async (inspectionType) => {
      const { tx, createMany } = client();
      await insertInspection(tx, plan(inspectionType), details);
      expect(createMany).not.toHaveBeenCalled();
    },
  );
});

describe('which checklists are looked up by organization rather than by area', () => {
  /**
   * The read paths branch on this. Getting it wrong returns an empty checklist,
   * which on a handset is indistinguishable from an area nobody configured —
   * and that is precisely how an HVAC technician once saw sixty items and could
   * record none of them.
   */
  it.each([
    ['AIR_CONDITIONING' as const, true],
    ['OCCUPIED' as const, true],
    ['ROOM' as const, false],
    ['NONE' as const, false],
  ])('%s', (kind, expected) => {
    expect(checklistItemsAreOrganizationWide(kind)).toBe(expected);
  });
});
