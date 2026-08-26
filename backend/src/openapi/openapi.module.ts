import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { ApiAuthGuard, PermissionsGuard } from '../common/auth';
import { OpenApiController } from './openapi.controller';
import { OpenApiDocumentService } from './openapi.service';

/**
 * Global so `configureApplication` can hand the service the application
 * instance with a plain `app.get`, from every entry point that boots one.
 *
 * DiscoveryModule supplies the controller walk that reads the guard and
 * permission metadata off every route.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [OpenApiController],
  providers: [OpenApiDocumentService, ApiAuthGuard, PermissionsGuard],
  exports: [OpenApiDocumentService],
})
export class OpenApiModule {}
