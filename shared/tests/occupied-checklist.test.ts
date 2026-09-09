import { describe, expect, it } from 'vitest';

import {
  OCCUPIED_CHECKLIST,
  occupiedChecklistTemplate,
} from '../src/contracts/occupied-checklist.js';
import { checklistTemplateForKind } from '../src/contracts/area-checklist-template.js';
import { checklistKindFor } from '../src/contracts/inspection-scope.js';
import { InspectionType } from '../src/enums/index.js';

/**
 * Reported from the field 2026-09-09: an occupied inspection was being served
 * the byte-identical per-room list as a move-out, because `checklistTemplateFor`
 * took an area and nothing else and no caller had ever passed it a visit type.
 *
 * These assertions are that rule. The counts matter as much as the routing —
 * "occupied asks its own list" is satisfied by a list of eighty-three items too.
 */
describe('an occupied inspection asks its own short list', () => {
  it('routes only OCCUPIED to the short list', () => {
    expect(checklistKindFor(InspectionType.OCCUPIED)).toBe('OCCUPIED');
  });

  it.each([
    // Back-to-market is the visit that decides what must be made good before the
    // next tenancy, so its detail is the point of it. It stays on the room list
    // deliberately, and this is the assertion that says so.
    [InspectionType.BACK_TO_MARKET],
    [InspectionType.MOVE_IN],
    [InspectionType.MOVE_OUT],
  ])('leaves %s on the full room list', (type) => {
    expect(checklistKindFor(type)).toBe('ROOM');
  });

  it('asks two questions, not eighty', () => {
    // The number is the fix. A bedroom on the room list is nine items, each a
    // tri-state on three axes; a three-bed two-bath house is about eighty-three.
    // Against the fifteen minutes the office allows for an occupied visit.
    expect(OCCUPIED_CHECKLIST).toHaveLength(2);
    expect(occupiedChecklistTemplate()).toEqual(['Room condition', 'Overall condition']);
  });

  it('asks the same two questions whatever the room is', () => {
    // The whole reason the rows are organization-wide rather than per area. If
    // this ever stops being true they have to move back onto the property area,
    // and `ensureOccupiedChecklist` has to move with them.
    const kitchen = checklistTemplateForKind(
      { name: 'Kitchen', category: 'KITCHEN', environment: 'INDOOR' },
      'OCCUPIED',
    );
    const hallway = checklistTemplateForKind(
      { name: 'Upstairs hallway', category: 'HALLWAY', environment: 'INDOOR' },
      'OCCUPIED',
    );
    const backYard = checklistTemplateForKind(
      { name: 'Back yard', environment: 'OUTDOOR' },
      'OCCUPIED',
    );
    expect(kitchen).toEqual(hallway);
    expect(hallway).toEqual(backYard);
  });

  it('is answered with one choice per question rather than three flags', () => {
    // Clean / undamaged / working is three decisions per item and admits
    // combinations nobody means. The office asked for one answer per room.
    expect(OCCUPIED_CHECKLIST.map((item) => item.responseType)).toEqual(['CHOICE', 'CHOICE']);
    expect(OCCUPIED_CHECKLIST[0]?.choices).toEqual([
      'Clean',
      'Acceptable',
      'Damaged',
      'Needs attention',
    ]);
    expect(OCCUPIED_CHECKLIST[1]?.choices).toEqual(['Good', 'Fair', 'Poor']);
  });

  it('does not collide with the room list it replaces', () => {
    // Both sets are persisted against the same area and told apart by `kind`.
    // A shared label would still be two rows, but a reviewer reading a report
    // could not tell which visit had asked it.
    const room = checklistTemplateForKind(
      { name: 'Second bedroom', category: 'BEDROOM', environment: 'INDOOR' },
      'ROOM',
    );
    expect(room).not.toContain('Room condition');
    expect(room).not.toContain('Overall condition');
  });
});
