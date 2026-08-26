/* Guards are runtime imports required by Nest metadata. */
import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions } from '../common/auth';
import { OpenApiDocumentService } from './openapi.service';

/**
 * The API's own description, served to the administrator console.
 *
 * `system:manage` rather than a permission of its own. The document is a
 * complete map of the API surface — every route, every request shape, and the
 * permission each one enforces — which is operator-grade information, and
 * `system:manage` is already the key that gates the other operator tools.
 * Introducing a new key would ship a capability no existing role holds.
 *
 * Deliberately not cached by the browser: the document changes with the
 * deployment, and a stale copy would describe routes that no longer exist.
 */
@ApiTags('IT tools')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/system')
export class OpenApiController {
  constructor(@Inject(OpenApiDocumentService) private readonly documents: OpenApiDocumentService) {}

  /** The OpenAPI 3 document for this API, annotated with per-route authorization. */
  @Get('openapi')
  @RequirePermissions('system:manage')
  @Header('Cache-Control', 'private, no-store')
  openapi() {
    return this.documents.document();
  }
}
