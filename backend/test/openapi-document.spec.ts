import { Controller, Get, Injectable, Module, Post, UseGuards, VersioningType } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';

import { PermissionsGuard, RequirePermissions } from '../src/common/auth';
import { PrismaService } from '../src/common/prisma.service';
import { OpenApiController } from '../src/openapi/openapi.controller';
import { API_KEY_HEADER } from '../src/openapi/openapi.document';
import { OpenApiDocumentService } from '../src/openapi/openapi.service';

/**
 * Stands in for the real guards, which need a database. The service reads guard
 * *names* off the metadata rather than resolving the classes, so a same-named
 * stand-in exercises exactly the code path production takes.
 */
@Injectable()
class ApiAuthGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

@Injectable()
class GatewayAuthGuard implements CanActivate {
  canActivate() {
    return true;
  }
}

@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/things')
class GuardedController {
  @Get()
  @RequirePermissions('properties:read')
  list() {
    return [];
  }

  @Post('dangerous')
  @RequirePermissions('properties:manage', 'system:manage')
  dangerous() {
    return { ok: true };
  }
}

@UseGuards(GatewayAuthGuard, PermissionsGuard)
@Controller('gateway/things')
class GatewayController {
  @Get()
  @RequirePermissions('inspections:read')
  list() {
    return [];
  }
}

@Controller('public/things')
class PublicController {
  @Get()
  list() {
    return [];
  }
}

/**
 * Two shapes that the first version of the matcher got wrong, both found by
 * asking the running application which operations it failed to annotate.
 *
 * A controller with several paths — Propertyware really does this, serving the
 * same handlers under `integrations/propertyware` and
 * `admin/integrations/propertyware` — makes Swagger emit one operation per path,
 * suffixed `[0]` and `[1]`.
 *
 * And `validateThing` is here for its name, not its behaviour: the version
 * suffix was stripped with a pattern greedy enough to match the `_v` inside the
 * method name, so every handler beginning with `v` lost its annotations.
 */
@ApiTags('Multi path')
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller(['integrations/thing', 'admin/integrations/thing'])
class MultiPathController {
  @Get('status')
  @RequirePermissions('integrations:read')
  status() {
    return {};
  }

  @Post('validate')
  @ApiTags('Specifically tagged')
  @RequirePermissions('integrations:manage')
  validateThing() {
    return {};
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [
    GuardedController,
    GatewayController,
    PublicController,
    MultiPathController,
    OpenApiController,
  ],
  providers: [
    OpenApiDocumentService,
    PermissionsGuard,
    // The real controller's guard wants a database. Nothing here calls it — the
    // document is built from route metadata, not by dispatching requests.
    { provide: PrismaService, useValue: {} },
  ],
})
class DocumentTestModule {}

async function buildDocument() {
  const moduleRef = await Test.createTestingModule({ imports: [DocumentTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  // Exactly what `configureApplication` does, because the paths in the document
  // are the URLs the console fetches — a test that skipped versioning would
  // happily assert `/api/admin/...` while production served `/api/v1/admin/...`.
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  const service = app.get(OpenApiDocumentService);
  service.attach(app);
  return { app, document: service.document(), service };
}

describe('OpenAPI document', () => {
  it('reports the permissions each route enforces', async () => {
    const { app, document } = await buildDocument();

    // The whole point of the annotation: OpenAPI has no vocabulary for "this
    // route requires properties:read", and in a system where a custom role is
    // composed key by key that is the single most important fact about a route.
    expect(document.paths['/api/v1/admin/things']?.get).toMatchObject({
      'x-required-permissions': ['properties:read'],
    });
    // ANDed, and reported in full — a route that needs two keys must not read
    // as though holding either one is enough.
    expect(document.paths['/api/v1/admin/things/dangerous']?.post).toMatchObject({
      'x-required-permissions': ['properties:manage', 'system:manage'],
    });

    await app.close();
  });

  it('distinguishes bearer-only routes from ones a machine key can also reach', async () => {
    const { app, document } = await buildDocument();

    expect(document.paths['/api/v1/admin/things']?.get).toMatchObject({
      'x-authentication': ['BEARER'],
    });
    expect(document.paths['/api/v1/gateway/things']?.get).toMatchObject({
      'x-authentication': ['BEARER', 'API_KEY'],
    });

    await app.close();
  });

  it('reports an unguarded route as accepting no credential, rather than omitting it', async () => {
    const { app, document } = await buildDocument();

    // An absent annotation and an empty one read the same way to a consumer,
    // and they mean opposite things. The public report routes are deliberately
    // unauthenticated, so "no credential" has to be a statement, not a silence.
    const operation = document.paths['/api/v1/public/things']?.get;
    expect(operation).toHaveProperty('x-authentication', []);
    expect(operation).toHaveProperty('x-required-permissions', []);

    await app.close();
  });

  it('advertises both credential types as security schemes', async () => {
    const { app, document } = await buildDocument();

    const schemes = document.components?.securitySchemes ?? {};
    expect(schemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(schemes.apiKey).toMatchObject({ type: 'apiKey', in: 'header', name: API_KEY_HEADER });

    await app.close();
  });

  it('serves the document at the exact path the console fetches', async () => {
    const { app, document } = await buildDocument();

    // Pinned as a string rather than derived, because this is a contract between
    // two deployables: the console asks for this URL by name, and a change to the
    // controller path, the global prefix or the default version would break it
    // with a 404 that looks like a missing deployment rather than a rename.
    const operation = document.paths['/api/v1/admin/system/openapi']?.get;
    expect(operation).toBeDefined();
    expect(operation).toMatchObject({
      'x-required-permissions': ['system:manage'],
      'x-authentication': ['BEARER'],
      'x-machine-accessible': false,
    });

    await app.close();
  });

  it('annotates every operation, with none silently left out', async () => {
    const { app, document } = await buildDocument();

    // The invariant that matters most here, and the one that was broken: an
    // unmatched operation carries no annotations, and a reader cannot tell that
    // apart from a route that genuinely enforces nothing. Swagger appends `_v1`
    // to every operation id once URI versioning is on — which production has and
    // the first version of this test did not — so the lookup matched nothing and
    // the whole API documented itself as unguarded.
    expect(document).not.toHaveProperty('x-unannotated-operations');

    const operations = Object.values(document.paths).flatMap((item) =>
      Object.values(item).filter(
        (operation): operation is Record<string, unknown> =>
          Boolean(operation) && typeof operation === 'object' && !Array.isArray(operation),
      ),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation).toHaveProperty('x-authentication');

    await app.close();
  });

  it('annotates a handler served under several controller paths, under each of them', async () => {
    const { app, document } = await buildDocument();

    // Swagger emits `status[0]_v1` and `status[1]_v1` for one handler. They are
    // the same method behind the same guards, so both must report the same
    // authorization — annotating neither, which is what happened, hid nine
    // Propertyware routes at once.
    for (const path of ['/api/v1/integrations/thing/status', '/api/v1/admin/integrations/thing/status'])
      expect(document.paths[path]?.get).toMatchObject({
        'x-required-permissions': ['integrations:read'],
        'x-authentication': ['BEARER'],
      });

    await app.close();
  });

  it('does not mistake a method name beginning with v for the version suffix', async () => {
    const { app, document } = await buildDocument();

    // `AdminController_validateAiProvider_v1` collapsed to `AdminController`
    // under a greedy pattern, because `_validate` starts with `_v` too.
    expect(document.paths['/api/v1/integrations/thing/validate']?.post).toMatchObject({
      'x-required-permissions': ['integrations:manage'],
    });

    await app.close();
  });

  it('puts a method-level tag after the controller tag, which is what the console groups on', async () => {
    const { app, document } = await buildDocument();

    // The console groups by the LAST tag, so that a handler can be filed under
    // its own heading without moving it to a new controller — the map's two
    // feeds live on AdminController and still want their own section.
    //
    // Pinned because it is an ordering guarantee of @nestjs/swagger rather than
    // of this code: if it ever reversed, every method-tagged route would silently
    // regroup under its controller and simply look missing.
    expect(document.paths['/api/v1/integrations/thing/status']?.get?.tags).toEqual([
      'Multi path',
    ]);
    expect(document.paths['/api/v1/integrations/thing/validate']?.post?.tags).toEqual([
      'Multi path',
      'Specifically tagged',
    ]);

    await app.close();
  });

  it('refuses to describe an application it was never given', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DocumentTestModule] }).compile();

    // A 503 rather than an empty document. Serving `{paths:{}}` would read as
    // "this API has no routes", which is a far worse answer than "unavailable".
    expect(() => moduleRef.get(OpenApiDocumentService).document()).toThrow(
      /not available on this instance/i,
    );
  });
});
