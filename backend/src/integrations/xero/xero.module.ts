import { Module } from '@nestjs/common';

import { XeroAuthService } from './xero-auth.service';
import { XeroSenderScheduler } from './xero-sender.scheduler';
import { XeroSenderService } from './xero-sender.service';
import { XeroSettingsService } from './xero-settings.service';
import { XeroClient } from './xero.client';
import { XeroController, XeroOAuthCallbackController } from './xero.controller';
import { XeroService } from './xero.service';

/**
 * The office's Xero organisation (2026-11-10, phases 1-3 of the Xero plan):
 * connected, read, its accounts chosen, and -- only once sending is turned on
 * -- its invoices sent.
 */
@Module({
  controllers: [XeroController, XeroOAuthCallbackController],
  providers: [XeroAuthService, XeroClient, XeroService, XeroSettingsService, XeroSenderService, XeroSenderScheduler],
  exports: [XeroService, XeroClient, XeroSettingsService, XeroSenderService],
})
export class XeroModule {}
