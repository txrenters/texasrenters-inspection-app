import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SEARCH_MAX_LENGTH, SEARCH_MIN_LENGTH } from '@texasrenters/shared';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { ApiAuthGuard, type AuthenticatedRequest } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { SearchService } from './search.service';

export class SearchQueryDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(SEARCH_MIN_LENGTH)
  @MaxLength(SEARCH_MAX_LENGTH)
  q!: string;
}

/**
 * The console's search for everything (2026-11-24). Open to anybody signed
 * in, with no permission of its own: the service reads each kind of record
 * only for an account holding that kind's own permission (`SEARCH_PERMISSIONS`),
 * so an account with none is answered with nothing.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard)
@Controller('admin/search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly service: SearchService) {}

  @Get()
  search(@Req() request: AuthenticatedRequest, @Query() query: SearchQueryDto) {
    // What the permission guard says on every other route: with no permission asked for here, it would not.
    if (request.user.mustChangePassword)
      throw new ApplicationError(403, 'AUTH_PASSWORD_CHANGE_REQUIRED', 'A password change is required before using the application.');
    return this.service.search(request.user, query.q);
  }
}
