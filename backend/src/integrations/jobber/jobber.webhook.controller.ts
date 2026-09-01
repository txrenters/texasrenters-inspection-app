/* Guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { createHash } from 'node:crypto';

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import { JobberWebhookGuard } from './jobber-webhook.guard';
import { jobberWebhookSchema } from './jobber.schemas';
import { JobberWebhookService } from './jobber.webhook.service';

/**
 * Receives Jobber's real-time notifications.
 *
 * Unauthenticated by design: the caller is Jobber, carrying no session and no
 * API key. What authorizes it is the HMAC over the raw body, checked by
 * JobberWebhookGuard using the app's OAuth client secret.
 *
 * The handler does as little as it possibly can. Jobber requires a reply within
 * **one second** and may disable an app's webhooks if responses are
 * consistently slow or error, so this verifies, records, acknowledges — and
 * only then does the real work, off the response path.
 */
@ApiTags('Jobber integration')
@UseGuards(JobberWebhookGuard)
@Controller('integrations/jobber/webhooks')
export class JobberWebhookController {
  constructor(private readonly webhooks: JobberWebhookService) {}

  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async receive(@Body() body: unknown) {
    const parsed = jobberWebhookSchema.safeParse(body);
    /**
     * A shape we do not recognise is still acknowledged.
     *
     * Returning an error would make Jobber retry a payload that will never
     * parse, and repeated errors are grounds for disabling the app's webhooks
     * entirely — losing the deliveries that *are* valid.
     */
    if (!parsed.success) return { received: true, processed: false };

    const event = parsed.data.data.webHookEvent;
    const payloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const { providerEventId, isNew } = await this.webhooks.record(event, payloadHash);
    if (!isNew) return { received: true, processed: false, duplicate: true };

    /**
     * Deliberately not awaited.
     *
     * Fetching the visit, matching its property and creating an inspection is
     * far more than a second's work. The promise is detached and catches its
     * own failures; the periodic sync is what reconciles anything lost here,
     * which is the reason it stays switched on alongside this.
     */
    void this.webhooks.process(event, providerEventId);
    return { received: true, processed: true };
  }
}
