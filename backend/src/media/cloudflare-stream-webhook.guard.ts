import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { ApplicationError } from '../common/errors';

/**
 * Verifies that a Stream webhook really came from Cloudflare.
 *
 * Separate from `WebhookSignatureGuard` because Cloudflare's scheme is not the
 * one that guard implements. Cloudflare sends
 *
 *   Webhook-Signature: time=1230811200,sig1=<hex>
 *
 * and signs `"<time>.<rawBody>"` — not the body alone, and not under
 * `x-webhook-signature`. Reusing the existing guard would have rejected every
 * genuine Cloudflare call while looking like it was verifying something.
 *
 * The endpoint this protects marks inspection video ready for playback. Without
 * verification, anyone who learned a Stream uid could declare evidence ready.
 */
@Injectable()
export class CloudflareStreamWebhookGuard implements CanActivate {
  /**
   * How far out of date a notification may be.
   *
   * The timestamp is inside the signed payload, so an attacker cannot alter it
   * without invalidating the signature — but a *captured* valid request could
   * otherwise be replayed forever. Five minutes is Cloudflare's own suggested
   * tolerance and comfortably absorbs clock skew.
   */
  private static readonly MAX_SKEW_SECONDS = 300;

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET?.trim();
    if (!secret)
      // No silent pass-through, in any environment. An unverified endpoint that
      // marks evidence ready is worse than one that is switched off, and a
      // local pipeline can set any value it likes.
      throw new ApplicationError(
        503,
        'STREAM_WEBHOOK_NOT_CONFIGURED',
        'Stream webhook verification is not configured.',
      );

    const header = request.header('webhook-signature')?.trim();
    if (!header)
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_MISSING', 'Webhook signature is missing.');

    const parts = new Map(
      header.split(',').map((piece) => {
        const [key, ...rest] = piece.trim().split('=');
        return [key, rest.join('=')] as const;
      }),
    );
    const time = parts.get('time');
    const provided = parts.get('sig1');
    if (!time || !provided || !/^\d+$/.test(time))
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');

    const ageSeconds = Math.abs(Date.now() / 1000 - Number(time));
    if (ageSeconds > CloudflareStreamWebhookGuard.MAX_SKEW_SECONDS)
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_STALE', 'Webhook signature has expired.');

    // The raw bytes, never a re-serialization of the parsed body: JSON.stringify
    // does not reproduce key order or whitespace, so re-encoding would fail
    // every signature for reasons that look like a wrong secret.
    const rawBody = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const expected = createHmac('sha256', secret)
      .update(`${time}.`)
      .update(rawBody)
      .digest('hex');

    const providedBuffer = Buffer.from(provided.toLowerCase(), 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(providedBuffer, expectedBuffer)
    )
      throw new ApplicationError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
    return true;
  }
}
