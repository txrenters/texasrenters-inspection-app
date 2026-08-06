/* DTO classes and injection tokens are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { WebhookDto } from '../vertical-slice/dto';
import { VerticalSliceService } from '../vertical-slice/vertical-slice.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';

@ApiTags('webhooks')
@UseGuards(WebhookSignatureGuard)
@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(VerticalSliceService) private readonly service: VerticalSliceService) {}
  // `cloudflare-stream` used to be handled here as a vertical-slice stub that
  // recorded a providerEventId and nothing else. It now lives on
  // CloudflareStreamWebhookController, which verifies Cloudflare's own
  // signature scheme and actually updates the video. Both were mapping the same
  // path, and Nest resolves such a collision to whichever registered first —
  // meaning the stub could silently swallow every real notification.
  @Post('transcription') transcription(@Body() body: WebhookDto) {
    return this.service.processWebhook('transcription', body.providerEventId);
  }
}
