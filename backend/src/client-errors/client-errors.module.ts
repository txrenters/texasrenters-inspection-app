import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ClientErrorsController } from './client-errors.controller';
import { ClientErrorsService } from './client-errors.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ClientErrorsController],
  providers: [ClientErrorsService],
})
export class ClientErrorsModule {}
