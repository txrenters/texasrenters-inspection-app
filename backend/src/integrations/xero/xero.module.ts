import { Module } from '@nestjs/common';

import { XeroAuthService } from './xero-auth.service';
import { XeroClient } from './xero.client';
import { XeroController, XeroOAuthCallbackController } from './xero.controller';
import { XeroService } from './xero.service';

/** The office's Xero organisation (2026-11-10, phase 1 of the Xero plan): connected and read, never written. */
@Module({
  controllers: [XeroController, XeroOAuthCallbackController],
  providers: [XeroAuthService, XeroClient, XeroService],
  exports: [XeroService, XeroClient],
})
export class XeroModule {}
