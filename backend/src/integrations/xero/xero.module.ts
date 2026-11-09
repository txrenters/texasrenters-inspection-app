import { Module } from '@nestjs/common';

import { XeroAuthService } from './xero-auth.service';
import { XeroSettingsService } from './xero-settings.service';
import { XeroClient } from './xero.client';
import { XeroController, XeroOAuthCallbackController } from './xero.controller';
import { XeroService } from './xero.service';

/** The office's Xero organisation (2026-11-10, phases 1-2 of the Xero plan): connected, read, and its accounts chosen; never written. */
@Module({
  controllers: [XeroController, XeroOAuthCallbackController],
  providers: [XeroAuthService, XeroClient, XeroService, XeroSettingsService],
  exports: [XeroService, XeroClient, XeroSettingsService],
})
export class XeroModule {}
