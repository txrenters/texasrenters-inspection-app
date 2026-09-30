import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TbpGroupFileController, readTbpGroupFile } from '../src/planning/tbp-group-file.controller';

/**
 * The office's groups file, served to the Groups map.
 *
 * It names tenants and their homes, and a file on disk belongs to no
 * organization -- so what is pinned here is who it is handed to. The rows are
 * invented.
 */

const PLANNING_ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';
const CSV = 'group,address,latitude,longitude\r\n1,"1 Main St, Unit A",29.7,-95.4\r\n';

describe('the groups file', () => {
  let folder: string;
  let file: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'group-file-'));
    file = join(folder, 'groups.csv');
    await writeFile(file, CSV, 'utf8');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    TBP_PLANNING_ORGANIZATION_ID: PLANNING_ORGANIZATION,
    TBP_GROUP_FILE: file,
    ...overrides,
  });

  it('hands the planning organization the file exactly as it is, by name and not by path', async () => {
    const served = await readTbpGroupFile(PLANNING_ORGANIZATION, environment());
    expect(served.csv).toBe(CSV);
    expect(served.fileName).toBe('groups.csv');
    expect(served.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses every other organization with the same 404 as no file at all', async () => {
    await expect(readTbpGroupFile(OTHER_ORGANIZATION, environment())).rejects.toMatchObject({
      code: 'GROUP_FILE_NOT_FOUND',
      status: 404,
    });
  });

  /** Fail closed: with no planning organization named, nobody is it. */
  it('serves nobody when no organization plans', async () => {
    await expect(
      readTbpGroupFile(PLANNING_ORGANIZATION, environment({ TBP_PLANNING_ORGANIZATION_ID: '' })),
    ).rejects.toMatchObject({ code: 'GROUP_FILE_NOT_FOUND' });
  });

  it('says there is no file when there is none, without naming where it looked', async () => {
    const missing = readTbpGroupFile(
      PLANNING_ORGANIZATION,
      environment({ TBP_GROUP_FILE: join(folder, 'gone.csv') }),
    );
    await expect(missing).rejects.toMatchObject({ code: 'GROUP_FILE_NOT_FOUND' });
    await expect(missing).rejects.not.toThrow(folder);
  });

  it('is not a folder', async () => {
    await expect(
      readTbpGroupFile(PLANNING_ORGANIZATION, environment({ TBP_GROUP_FILE: folder })),
    ).rejects.toMatchObject({ code: 'GROUP_FILE_NOT_FOUND' });
  });

  it('sits behind the same permission as the plan it is compared with', () => {
    const handler = (TbpGroupFileController.prototype as unknown as Record<string, object>).groupFile!;
    expect(Reflect.getMetadata('permissions', handler)).toEqual(['planning:read']);
  });
});
