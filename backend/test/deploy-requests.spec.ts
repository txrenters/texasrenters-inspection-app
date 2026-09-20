import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ApplicationError, ApplicationExceptionFilter } from '../src/common/errors';
import { DEPLOY_CALLER, DeployRequestService } from '../src/deployments/deploy-request.service';
import { DeploymentsModule } from '../src/deployments/deployments.module';
import {
  GITHUB_ACTIONS_ISSUER,
  GithubActionsKeys,
  UnverifiedCaller,
  verifyGithubActionsToken,
} from '../src/deployments/github-actions-token';

const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'github-actions-key';
const KEY_SET = { keys: [{ ...github.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

const NOW = Date.parse('2026-09-17T16:00:00Z');

/** What GitHub signs for the image workflow's deploy job on the v2.5.74 release. */
function claims(overrides: Record<string, unknown> = {}, at = NOW) {
  const seconds = Math.floor(at / 1000);
  return {
    iss: GITHUB_ACTIONS_ISSUER,
    aud: 'texasrenters-inspection-deploy',
    iat: seconds - 5,
    nbf: seconds - 5,
    exp: seconds + 300,
    repository: 'txrenters/texasrenters-inspection-app',
    workflow_ref:
      'txrenters/texasrenters-inspection-app/.github/workflows/publish-images.yml@refs/tags/v2.5.74',
    event_name: 'release',
    ref: 'refs/tags/v2.5.74',
    sha: '5b0e6c1d9f',
    run_id: '17000000001',
    run_attempt: '1',
    ...overrides,
  };
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(body: object, { key = github.privateKey, kid = KID }: { key?: KeyObject; kid?: string } = {}) {
  const unsigned = `${encode({ alg: 'RS256', kid, typ: 'JWT' })}.${encode(body)}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
}

/** Signed now, for code that reads the real clock. */
const bearer = (overrides: Record<string, unknown> = {}) => `Bearer ${token(claims(overrides, Date.now()))}`;

const keysAt = (fetchKeySet = jest.fn().mockResolvedValue(KEY_SET)) => new GithubActionsKeys(fetchKeySet, () => NOW);
const verifyNow = (value: string, keys = keysAt()) => verifyGithubActionsToken(value, keys, DEPLOY_CALLER, NOW);

describe('a GitHub Actions token asking for a deploy', () => {
  it('is accepted from the image workflow, run by a release, in this repository', async () => {
    await expect(verifyNow(token(claims()))).resolves.toMatchObject({
      ref: 'refs/tags/v2.5.74',
      sha: '5b0e6c1d9f',
      run_id: '17000000001',
    });
  });

  it.each([
    [
      'another repository',
      { repository: 'someone/else', workflow_ref: 'someone/else/.github/workflows/publish-images.yml@refs/tags/v1' },
    ],
    [
      'another workflow in this repository',
      { workflow_ref: 'txrenters/texasrenters-inspection-app/.github/workflows/ci.yml@refs/heads/main' },
    ],
    [
      'a workflow whose name only starts the same',
      { workflow_ref: 'txrenters/texasrenters-inspection-app/.github/workflows/publish-images.yml.old@refs/heads/x' },
    ],
    ['a manual run of the workflow', { event_name: 'workflow_dispatch' }],
    ['a push', { event_name: 'push' }],
    ['a token minted for another audience', { aud: 'sts.amazonaws.com' }],
    ['another issuer', { iss: 'https://token.example.com' }],
    ['an expired token', { exp: Math.floor(NOW / 1000) - 120 }],
    ['a token not valid yet', { nbf: Math.floor(NOW / 1000) + 600 }],
    ['a run that is not a run', { run_id: '../../etc/passwd' }],
  ])('is refused from %s', async (_caller, overrides) => {
    await expect(verifyNow(token(claims(overrides)))).rejects.toBeInstanceOf(UnverifiedCaller);
  });

  it('is refused when anyone but GitHub signed it, even under the id of GitHub’s key', async () => {
    await expect(verifyNow(token(claims(), { key: stranger.privateKey }))).rejects.toThrow(
      'The signature does not match.',
    );
  });

  it('is refused unsigned, or signed with the public key as an HMAC secret', async () => {
    const unsigned = `${encode({ alg: 'none', kid: KID })}.${encode(claims())}.`;
    await expect(verifyNow(unsigned)).rejects.toBeInstanceOf(UnverifiedCaller);

    const publicPem = github.publicKey.export({ format: 'pem', type: 'spki' });
    const header = `${encode({ alg: 'HS256', kid: KID })}.${encode(claims())}`;
    const hmac = createHmac('sha256', publicPem).update(header).digest('base64url');
    await expect(verifyNow(`${header}.${hmac}`)).rejects.toThrow('not RS256');
  });

  it('asks GitHub for its keys again for a key id not seen before, but at most once a minute', async () => {
    const fetchKeySet = jest.fn().mockResolvedValue(KEY_SET);
    let clock = NOW;
    const keys = new GithubActionsKeys(fetchKeySet, () => clock);

    await verifyGithubActionsToken(token(claims()), keys, DEPLOY_CALLER, clock);
    await expect(
      verifyGithubActionsToken(token(claims(), { kid: 'made-up' }), keys, DEPLOY_CALLER, clock),
    ).rejects.toThrow('does not publish');
    expect(fetchKeySet).toHaveBeenCalledTimes(1);

    clock = NOW + 61_000;
    await expect(
      verifyGithubActionsToken(token(claims({}, clock), { kid: 'made-up' }), keys, DEPLOY_CALLER, clock),
    ).rejects.toThrow('does not publish');
    expect(fetchKeySet).toHaveBeenCalledTimes(2);
  });

  it('stops trusting a key within the hour of GitHub no longer publishing it', async () => {
    const fetchKeySet = jest.fn().mockResolvedValueOnce(KEY_SET).mockResolvedValue({ keys: [] });
    let clock = NOW;
    const keys = new GithubActionsKeys(fetchKeySet, () => clock);
    await verifyGithubActionsToken(token(claims()), keys, DEPLOY_CALLER, clock);

    clock = NOW + 61 * 60_000;
    await expect(
      verifyGithubActionsToken(token(claims({}, clock)), keys, DEPLOY_CALLER, clock),
    ).rejects.toThrow('does not publish');
  });
});

describe('a deploy request from the image workflow', () => {
  let directory: string;
  const configured = process.env.DEPLOY_REQUEST_DIR;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'deploy-requests-'));
    process.env.DEPLOY_REQUEST_DIR = directory;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    if (configured === undefined) delete process.env.DEPLOY_REQUEST_DIR;
    else process.env.DEPLOY_REQUEST_DIR = configured;
  });

  const service = (fetchKeySet = jest.fn().mockResolvedValue(KEY_SET)) =>
    new DeployRequestService(new GithubActionsKeys(fetchKeySet));

  async function refusal(request: Promise<unknown>) {
    const error: unknown = await request.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApplicationError);
    return { status: (error as ApplicationError).getStatus(), code: (error as ApplicationError).code };
  }

  it('is left for the host, named by the run, saying which release', async () => {
    await expect(service().request(bearer())).resolves.toEqual({ status: 'REQUESTED', release: 'v2.5.74' });

    expect(await readdir(directory)).toEqual(['github-run-17000000001-1.json']);
    expect(JSON.parse(await readFile(join(directory, 'github-run-17000000001-1.json'), 'utf8'))).toMatchObject({
      release: 'v2.5.74',
      sha: '5b0e6c1d9f',
      runId: '17000000001',
      runAttempt: '1',
    });
  });

  it('is left once for a run however often the call is retried, and again when the run is re-run', async () => {
    const deploys = service();
    await deploys.request(bearer());
    // The host has picked it up.
    await rm(join(directory, 'github-run-17000000001-1.json'));

    await expect(deploys.request(bearer())).resolves.toEqual({ status: 'ALREADY_REQUESTED', release: 'v2.5.74' });
    expect(await readdir(directory)).toEqual([]);

    await expect(deploys.request(bearer({ run_attempt: '2' }))).resolves.toMatchObject({ status: 'REQUESTED' });
    expect(await readdir(directory)).toEqual(['github-run-17000000001-2.json']);
  });

  it('leaves nothing for a caller it cannot verify', async () => {
    expect(await refusal(service().request(bearer({ event_name: 'push' })))).toEqual({
      status: 401,
      code: 'DEPLOY_REQUEST_UNVERIFIED',
    });
    expect(await refusal(service().request(undefined))).toEqual({ status: 401, code: 'DEPLOY_REQUEST_UNVERIFIED' });
    expect(await refusal(service().request('Basic dXNlcjpwYXNz'))).toEqual({
      status: 401,
      code: 'DEPLOY_REQUEST_UNVERIFIED',
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it('is turned away where the server takes no deploy requests', async () => {
    delete process.env.DEPLOY_REQUEST_DIR;
    expect(await refusal(service().request(bearer()))).toEqual({
      status: 503,
      code: 'DEPLOY_REQUESTS_NOT_CONFIGURED',
    });
  });

  it('says it could not be passed on when the shared directory is missing', async () => {
    process.env.DEPLOY_REQUEST_DIR = join(directory, 'not-mounted');
    expect(await refusal(service().request(bearer()))).toEqual({
      status: 503,
      code: 'DEPLOY_REQUESTS_NOT_CONFIGURED',
    });
  });

  it('answers 503 rather than 401 when GitHub’s keys cannot be fetched', async () => {
    const offline = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    expect(await refusal(service(offline).request(bearer()))).toEqual({
      status: 503,
      code: 'DEPLOY_REQUEST_KEYS_UNAVAILABLE',
    });
  });
});

describe('the deploy request route', () => {
  let app: INestApplication;
  let url: string;
  let directory: string;
  const configured = process.env.DEPLOY_REQUEST_DIR;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'deploy-requests-route-'));
    process.env.DEPLOY_REQUEST_DIR = directory;
    // The module as the application registers it, with only GitHub's keys
    // replaced by this file's: a provider it cannot resolve, or a route at the
    // wrong path, fails here rather than when the first release calls.
    const moduleRef = await Test.createTestingModule({ imports: [DeploymentsModule] })
      .overrideProvider(GithubActionsKeys)
      .useValue(new GithubActionsKeys(jest.fn().mockResolvedValue(KEY_SET)))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new ApplicationExceptionFilter());
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/api/v1/deploy-requests`;
  });

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    if (configured === undefined) delete process.env.DEPLOY_REQUEST_DIR;
    else process.env.DEPLOY_REQUEST_DIR = configured;
  });

  it('takes the image workflow’s request with no session, and says it was passed on', async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: bearer() } });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'REQUESTED', release: 'v2.5.74' });
    expect(await readdir(directory)).toEqual(['github-run-17000000001-1.json']);
  });

  it('turns anyone else away with a 401 that does not say what was wrong', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: bearer({ aud: 'sts.amazonaws.com', run_id: '17000000002' }) },
    });

    expect(response.status).toBe(401);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('DEPLOY_REQUEST_UNVERIFIED');
    expect(body).not.toMatch(/audience|another/iu);
    expect(await readdir(directory)).toEqual(['github-run-17000000001-1.json']);
  });
});
