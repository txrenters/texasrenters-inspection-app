import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { photoCaptureClaim } from '@texasrenters/shared';

import { TechnicianPhotoUploadDto } from '../src/technician/technician.dto';

/**
 * The phone builds its capture time with `photoCaptureClaim`; the server checks
 * it with `TechnicianPhotoUploadDto`. If the two ever disagree, the photograph
 * is refused with a 400 -- and a refusal is never retried, so the evidence would
 * sit on the handset for good. This pins them together.
 */
function multipart(claim: ReturnType<typeof photoCaptureClaim>) {
  // A multipart upload delivers every value as a string.
  return {
    idempotencyKey: 'snapshot-1757944800000-abcde',
    captureType: 'AREA_OVERVIEW',
    captureSource: 'SEPARATE_PHOTO_CAPTURE',
    capturedAt: claim.capturedAt,
    captureUtcOffsetMinutes: String(claim.captureUtcOffsetMinutes),
    ...(claim.captureTimeZone ? { captureTimeZone: claim.captureTimeZone } : {}),
  };
}

describe('a capture time the phone sends', () => {
  it.each(['America/Chicago', 'Asia/Manila', 'Etc/GMT+5', 'UTC', undefined])(
    'passes the photo endpoint validation with zone %s',
    async (zone) => {
      const dto = plainToInstance(
        TechnicianPhotoUploadDto,
        multipart(photoCaptureClaim(Date.parse('2026-09-15T14:03:27.412Z'), zone)),
      );

      expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
      expect(dto.captureUtcOffsetMinutes).toEqual(expect.any(Number));
    },
  );
});
