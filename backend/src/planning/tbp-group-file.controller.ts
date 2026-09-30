import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PLANNING_TAG } from './planning.controller';

/**
 * The office's groups file, for the console's Groups map to open by default.
 *
 * A spreadsheet of active properties already split into groups -- visiting
 * order, drive minutes, route miles -- that the office works out outside the
 * planner. It names every tenant and their home address, and the repository is
 * public, so it is never committed, bundled or put where the web app serves
 * static files: it sits in the server's `data/` folder and is handed out here,
 * behind the same sign-in and `planning:read` as the plan it is compared with.
 *
 * **Only to the organization that plans.** A file on disk belongs to no
 * organization, so it is served to `TBP_PLANNING_ORGANIZATION_ID` and nobody
 * else, and to nobody at all when that is not set. The answer to everyone else
 * is the same 404 as a missing file, so the file's existence is not disclosed
 * either.
 *
 * Read on every request rather than cached: a new file dropped into `data/` is
 * what the next page load shows, without restarting anything.
 */

/**
 * Where the file is when `TBP_GROUP_FILE` does not say, relative to the
 * backend's working directory: the repository's own `data/` folder in
 * development. The office's current grouping (2026-09-30).
 */
export const DEFAULT_GROUP_FILE = join('..', 'data', 'tbp-active-groups-outside-in.csv');

/** Far beyond any grouping of a few hundred properties, and well short of a problem to hold in memory. */
const MAX_GROUP_FILE_BYTES = 5 * 1024 * 1024;

export interface TbpGroupFile {
  /** The file's name, without the server's path to it. */
  fileName: string;
  /** The file exactly as it is on disk; the console reads it. */
  csv: string;
  modifiedAt: string;
}

const notFound = () =>
  new ApplicationError(404, 'GROUP_FILE_NOT_FOUND', 'There is no groups file on the server.');

export async function readTbpGroupFile(
  organizationId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TbpGroupFile> {
  const planning = environment.TBP_PLANNING_ORGANIZATION_ID?.trim();
  if (!planning || organizationId !== planning) throw notFound();

  const file = resolve(environment.TBP_GROUP_FILE?.trim() || DEFAULT_GROUP_FILE);
  const found = await stat(file).catch(() => null);
  if (!found?.isFile()) throw notFound();
  if (found.size > MAX_GROUP_FILE_BYTES)
    throw new ApplicationError(422, 'GROUP_FILE_TOO_LARGE', 'The groups file on the server is too large to open.');

  return {
    fileName: basename(file),
    csv: await readFile(file, 'utf8'),
    modifiedAt: found.mtime.toISOString(),
  };
}

@ApiTags(PLANNING_TAG)
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/planning')
export class TbpGroupFileController {
  @Get('group-file')
  @RequirePermissions('planning:read')
  groupFile(@Req() request: AuthenticatedRequest) {
    return readTbpGroupFile(request.user.organizationId);
  }
}
