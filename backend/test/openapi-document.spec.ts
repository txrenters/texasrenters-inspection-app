import { Controller, Get, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { PermissionsGuard, RequirePermissions } from '../src/common/auth';
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

@Module({
  imports: [DiscoveryModule],
  controllers: [GuardedController, GatewayController, PublicController],
  providers: [OpenApiDocumentService, PermissionsGuard],
})
class DocumentTestModule {}

async function buildDocument() {
  const moduleRef = await Test.createTestingModule({ imports: [DocumentTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
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
    expect(document.paths['/api/admin/things']?.get).toMatchObject({
      'x-required-permissions': ['properties:read'],
    });
    // ANDed, and reported in full — a route that needs two keys must not read
    // as though holding either one is enough.
    expect(document.paths['/api/admin/things/dangerous']?.post).toMatchObject({
      'x-required-permissions': ['properties:manage', 'system:manage'],
    });

    await app.close();
  });

  it('distinguishes bearer-only routes from ones a machine key can also reach', async () => {
    const { app, document } = await buildDocument();

    expect(document.paths['/api/admin/things']?.get).toMatchObject({
      'x-authentication': ['BEARER'],
    });
    expect(document.paths['/api/gateway/things']?.get).toMatchObject({
      'x-authentication': ['BEARER', 'API_KEY'],
    });

    await app.close();
  });

  it('reports an unguarded route as accepting no credential, rather than omitting it', async () => {
    const { app, document } = await buildDocument();

    // An absent annotation and an empty one read the same way to a consumer,
    // and they mean opposite things. The public report routes are deliberately
    // unauthenticated, so "no credential" has to be a statement, not a silence.
    const operation = document.paths['/api/public/things']?.get;
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

  it('refuses to describe an application it was never given', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DocumentTestModule] }).compile();

    // A 503 rather than an empty document. Serving `{paths:{}}` would read as
    // "this API has no routes", which is a far worse answer than "unavailable".
    expect(() => moduleRef.get(OpenApiDocumentService).document()).toThrow(
      /not available on this instance/i,
    );
  });
});
