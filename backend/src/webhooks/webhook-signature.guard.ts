import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApplicationError } from '../common/errors';

/**
 * Verifies provider webhooks with an HMAC-SHA256 signature over the raw body.
 * Without a configured secret, unsigned webhooks are accepted only outside
 * production so the local mock pipeline keeps working.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.WEBHOOK_SIGNING_SECRET?.trim();
    if (!secret) {
      if (process.env.NODE_ENV === 'production')
        throw new ApplicationError(
          503,
          'WEBHOOK_VERIFICATION_NOT_CONFIGURED',
          'Webhook signature verification is not configured.',
        );
      return true;
    }
    const signature = request.header('x-webhook-signature')?.trim().toLowerCase();
    if (!signature)
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Webhook signature is missing.');
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted))
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
    return true;
  }
}
