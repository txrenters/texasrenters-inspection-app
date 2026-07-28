import { Module } from '@nestjs/common';

import { getMailConfig, MAIL_CONFIG, type MailConfig } from './mail.config';
import { MailService, MAIL_TRANSPORT } from './mail.service';
import { MicrosoftGraphMailClient } from './microsoft-graph-mail.client';

@Module({
  providers: [
    { provide: MAIL_CONFIG, useFactory: getMailConfig },
    {
      provide: MAIL_TRANSPORT,
      inject: [MAIL_CONFIG],
      useFactory: (config: MailConfig) =>
        config.configured ? new MicrosoftGraphMailClient(config) : null,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
