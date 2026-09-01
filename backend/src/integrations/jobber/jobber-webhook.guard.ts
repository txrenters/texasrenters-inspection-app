import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApplicationError } from '../../common/errors';

/**
 * Verifies that a webhook really came from Jobber.
 *
 * Jobber signs the raw request body with the app's **OAuth client secret** —
 * the same value used to redeem tokens — and sends it base64-encoded in
 * `X-Jobber-Hmac-SHA256`. There is no timestamp in the scheme, unlike
 * Cloudflare's, so there is nothing to expire and no skew window to enforce.
 *
 * This endpoint decides that a visit changed, which turns into inspections
 * appearing, moving or being refused. Without verification anyone who learned
 * the URL could inject scheduling.
 */
@Injectable()
export class JobberWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.JOBBER_CLIENT_SECRET?.trim();
    if (!secret)
      // Never a silent pass-through. An unverified endpoint that creates
      // inspections is worse than one that is switched off.
      throw new ApplicationError(
        503,
        'JOBBER_WEBHOOK_NOT_CONFIGURED',
        'Jobber webhook verification is not configured.',
      );

    const provided = request.header('x-jobber-hmac-sha256')?.trim();
    if (!provided)
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Webhook signature is missing.');

    /**
     * The raw bytes, never a re-serialization of the parsed body.
     *
     * `JSON.stringify` does not reproduce key order or whitespace, so
     * re-encoding fails every signature for reasons that look exactly like a
     * wrong secret. `rawBody: true` is set on the Nest application for this.
     */
    const rawBody = request.rawBody;
    if (!rawBody)
      throw new ApplicationError(
        500,
        'WEBHOOK_RAW_BODY_UNAVAILABLE',
        'The webhook body could not be verified.',
      );

    const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    // Length is compared first because timingSafeEqual throws on a mismatch
    // rather than returning false, which would turn a bad signature into a 500.
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    )
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');

    return true;
  }
}
