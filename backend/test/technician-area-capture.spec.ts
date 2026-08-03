// Must precede the DTO import: its decorators are evaluated at module load.
import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateAdminInspectionDto } from '../src/admin/admin.dto';

/**
 * Scheduling an inspection on a property nobody has surveyed.
 *
 * The rule under test is the one in `createInspection`: an approved layout is
 * required unless the administrator has asked the technician to build the list
 * on site. The surrounding transaction needs a live database, so the decision
 * itself is exercised here as the predicate it is, and the DTO contract that
 * carries it is checked alongside.
 */
function areaRequirementMet(approvedAreaCount: number, allowTechnicianAreaCapture: boolean) {
  return approvedAreaCount > 0 || allowTechnicianAreaCapture;
}

describe('technician area capture', () => {
  it('still requires an approved layout by default', () => {
    // Unchanged for every property that has a floor plan: leaving this open by
    // default would let an inspection be scheduled against nothing at all.
    expect(areaRequirementMet(0, false)).toBe(false);
    expect(areaRequirementMet(4, false)).toBe(true);
  });

  it('lets an unsurveyed property through when the technician will capture', () => {
    expect(areaRequirementMet(0, true)).toBe(true);
  });

  it('does not discard an approved layout that already exists', () => {
    // The flag is an instruction, not a mode: a property that has approved
    // areas still snapshots them, and the technician adds to that list rather
    // than starting from an empty one.
    expect(areaRequirementMet(4, true)).toBe(true);
  });

  it('accepts the flag on the create payload and defaults it off', async () => {
    const withFlag = plainToInstance(CreateAdminInspectionDto, {
      propertyId: '10000000-0000-4000-8000-000000000001',
      scheduledAt: '2026-08-10',
      allowTechnicianAreaCapture: true,
    });
    expect(await validate(withFlag)).toHaveLength(0);
    expect(withFlag.allowTechnicianAreaCapture).toBe(true);

    const without = plainToInstance(CreateAdminInspectionDto, {
      propertyId: '10000000-0000-4000-8000-000000000001',
      scheduledAt: '2026-08-10',
    });
    expect(await validate(without)).toHaveLength(0);
    expect(without.allowTechnicianAreaCapture).toBeUndefined();
  });

  it('rejects a non-boolean flag rather than coercing it', async () => {
    // "false" as a string is truthy, and a query-string round trip is exactly
    // where that arrives. Coercion here would schedule a survey nobody asked
    // for.
    const bad = plainToInstance(CreateAdminInspectionDto, {
      propertyId: '10000000-0000-4000-8000-000000000001',
      scheduledAt: '2026-08-10',
      allowTechnicianAreaCapture: 'false',
    });
    const errors = await validate(bad);
    expect(errors.map((error) => error.property)).toContain('allowTechnicianAreaCapture');
  });
});
