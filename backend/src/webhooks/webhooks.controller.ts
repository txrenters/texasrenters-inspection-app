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
  @Post('cloudflare-stream') cloudflare(@Body() body: WebhookDto) {
    return this.service.processWebhook('cloudflare-stream', body.providerEventId);
  }
  @Post('transcription') transcription(@Body() body: WebhookDto) {
    return this.service.processWebhook('transcription', body.providerEventId);
  }
}
