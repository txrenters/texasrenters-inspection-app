import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AdminController } from '../src/admin/admin.controller';
import { AddInspectionAreasDto } from '../src/admin/admin.dto';
import { PERMISSIONS_METADATA_KEY } from '../src/common/auth';

/**
 * The service spec next door calls the method directly, which proves the rules
 * and nothing about how a request reaches them. These are the three pieces
 * between an HTTP call and that method — the path, the guard, and the body
 * validation — and each fails in a way the service can never catch: a route
 * mounted at the wrong path 404s, a missing permission decorator lets anyone who
 * can read the queue add work to someone's day, and an unvalidated body reaches
 * Prisma as whatever was sent.
 */
const handler = AdminController.prototype.addInspectionAreas;

describe('POST admin/inspections/:inspectionId/areas is wired correctly', () => {
  it('is mounted as a POST on the inspection, not on the property', () => {
    // Adding under the property is exactly the route that produced the original
    // report: it changes the permanent layout and reaches no inspection.
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('inspections/:inspectionId/areas');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('requires inspections:manage, the permission that moves work', () => {
    const required = Reflect.getMetadata(PERMISSIONS_METADATA_KEY, handler);
    expect(required).toEqual(['inspections:manage']);
    // Stated as its own assertion because this is the mistake worth catching:
    // read is what the whole console has, and this decides a technician's day.
    expect(required).not.toContain('inspections:read');
  });
});

describe('AddInspectionAreasDto', () => {
  async function errorsFor(payload: unknown) {
    return validate(plainToInstance(AddInspectionAreasDto, payload));
  }

  it('accepts a list of area ids', async () => {
    expect(
      await errorsFor({ propertyAreaIds: ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'] }),
    ).toHaveLength(0);
  });

  it('rejects an empty list, which would notify a technician about nothing', async () => {
    expect(await errorsFor({ propertyAreaIds: [] })).not.toHaveLength(0);
  });

  it('rejects anything that is not a uuid', async () => {
    expect(await errorsFor({ propertyAreaIds: ['not-a-uuid'] })).not.toHaveLength(0);
  });

  it('rejects a missing list rather than treating it as empty', async () => {
    expect(await errorsFor({})).not.toHaveLength(0);
  });

  it('caps the request well below anything that could be a runaway payload', async () => {
    const tooMany = Array.from({ length: 51 }, () => '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(await errorsFor({ propertyAreaIds: tooMany })).not.toHaveLength(0);
  });
});
