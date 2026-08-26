import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';

import { PERMISSIONS_METADATA_KEY } from '../common/auth';
import { MACHINE_ACCESSIBLE_METADATA_KEY } from '../gateway/machine-accessible.decorator';
import { buildOpenApiConfig } from './openapi.document';

/** Nest's own key for `@UseGuards`. Not exported by the framework. */
const GUARDS_METADATA = '__guards__';

/** Credentials a route accepts, as reported to the console. */
export type RouteCredential = 'BEARER' | 'API_KEY';

export interface RouteAuthorization {
  /** Permissions the route enforces, ANDed, from {@link RequirePermissions}. */
  permissions: string[];
  /** Credential types that can satisfy the route's guards. */
  credentials: RouteCredential[];
  /** Whether a third-party API key may reach this route at all. */
  machineAccessible: boolean;
  /** Guard class names, so an unrecognised guard is visible rather than silently read as public. */
  guards: string[];
}

function guardNames(target: object | undefined): string[] {
  if (!target) return [];
  const guards = (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
  return guards.map((guard) =>
    typeof guard === 'function'
      ? guard.name
      : ((guard as { constructor?: { name?: string } })?.constructor?.name ?? 'UnknownGuard'),
  );
}

function credentialsFor(guards: string[]): RouteCredential[] {
  const credentials: RouteCredential[] = [];
  // The gateway guard accepts either credential; the plain auth guard is bearer
  // only. Listed by guard name rather than by importing the classes, because the
  // gateway module imports this one and the cycle would be real.
  if (guards.includes('ApiAuthGuard') || guards.includes('GatewayAuthGuard'))
    credentials.push('BEARER');
  if (guards.includes('ApiKeyGuard') || guards.includes('GatewayAuthGuard'))
    credentials.push('API_KEY');
  return credentials;
}

/**
 * Serves the OpenAPI document that describes this API, annotated with the
 * authorization each route actually enforces.
 *
 * Two things this does that `SwaggerModule.setup` alone does not:
 *
 * - It survives Swagger UI being switched off. `/api/docs` is a development
 *   convenience that stays closed in production and during remote beta, because
 *   it is unauthenticated. The document itself is useful to an administrator who
 *   already holds `system:manage`, so it is served through the normal RBAC path
 *   instead of through a public HTML page.
 * - It attaches `x-required-permissions` and `x-authentication` per operation.
 *   OpenAPI has no vocabulary for "this route requires `inspections:finalize`",
 *   and the permission a route enforces is the single most important fact about
 *   it in a system where a custom role composes access key by key. Reading it
 *   from the guard metadata means the documentation cannot drift from
 *   enforcement — it is generated from the same decorators the guards read.
 */
@Injectable()
export class OpenApiDocumentService {
  private application?: INestApplication;
  private cached?: OpenAPIObject;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  /**
   * Hand the service the application it should describe.
   *
   * Called from `configureApplication`, so the document is available on every
   * path that boots a real application — including the e2e tests — without
   * `main.ts` being the only place that knows how to build it.
   */
  attach(application: INestApplication) {
    this.application = application;
    this.cached = undefined;
  }

  /**
   * The annotated document.
   *
   * Built once and cached. Route metadata is fixed at boot, so rebuilding per
   * request would burn a few hundred milliseconds of reflection to produce a
   * byte-identical result.
   */
  document(): OpenAPIObject {
    if (this.cached) return this.cached;
    if (!this.application)
      throw new ServiceUnavailableException('The API document is not available on this instance.');
    const document = SwaggerModule.createDocument(this.application, buildOpenApiConfig());
    this.cached = this.annotate(document);
    return this.cached;
  }

  /**
   * Guard and permission metadata for every controller route, keyed by the
   * operation id Swagger derives from the same class and method
   * (`AdminController_dashboard`).
   *
   * Keyed that way rather than by reconstructing `/api/v1/...` from the path,
   * version and global-prefix metadata: that reconstruction has to re-implement
   * Nest's own path composition, and it fails silently — a route whose path is
   * rebuilt slightly wrong is reported as having no permissions at all, which
   * reads exactly like a route that is genuinely unguarded.
   */
  routeAuthorization(): Map<string, RouteAuthorization> {
    const routes = new Map<string, RouteAuthorization>();
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      const classGuards = guardNames(metatype);
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        const permissions =
          this.reflector.getAllAndOverride<string[]>(PERMISSIONS_METADATA_KEY, [
            handler as never,
            metatype as never,
          ]) ?? [];
        const guards = [...new Set([...classGuards, ...guardNames(handler as object)])];
        const machineAccessible =
          this.reflector.getAllAndOverride<boolean>(MACHINE_ACCESSIBLE_METADATA_KEY, [
            handler as never,
            metatype as never,
          ]) ?? false;
        routes.set(`${metatype.name}_${methodName}`, {
          permissions,
          credentials: credentialsFor(guards),
          machineAccessible,
          guards,
        });
      }
    }
    return routes;
  }

  /**
   * The map key for an operation id.
   *
   * With URI versioning enabled — which production does — Swagger emits
   * `AdminController_dashboard_v1`, not `AdminController_dashboard`. Keying only
   * on the unsuffixed form matched nothing at all, and the failure was silent in
   * the worst possible way: the document still served, still listed every route,
   * and simply reported no permissions and no authentication anywhere. A reader
   * would have concluded the entire API was unguarded.
   *
   * Three suffixes have to come off, and each one was found the hard way by
   * asking the running application which operations it could not match:
   *
   * - `_v1` — the URI version, on every operation.
   * - `[0]`, `[1]` — one entry per path when a controller declares several, as
   *   PropertywareIntegrationController does with `['integrations/propertyware',
   *   'admin/integrations/propertyware']`. Both entries are the same handler and
   *   share its authorization.
   * - `_<n>` — Swagger's disambiguator for a duplicated operation id.
   *
   * `[^_]*` rather than `[\w.]*` in the version pattern, and that is not
   * cosmetic. A greedy class matches the `_v` inside the *method name*, so
   * `AdminController_validateAiProvider_v1` collapsed to `AdminController` and
   * matched nothing — every handler whose name begins with `v` was silently
   * unannotated. A version cannot contain an underscore; a method name reached
   * this way always does.
   */
  private static annotationKey(operationId: string) {
    return operationId
      .replace(/_v[^_]*$/, '')
      .replace(/\[\d+\]$/, '')
      .replace(/_\d+$/, '');
  }

  private annotate(document: OpenAPIObject): OpenAPIObject {
    const routes = this.routeAuthorization();
    const unmatched: string[] = [];
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        // A PathItem also carries `parameters`, `$ref` and `servers`, none of
        // which are operations and none of which have an operationId.
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
        const candidate = operation as { operationId?: string } & Record<string, unknown>;
        if (!candidate.operationId) continue;
        const route =
          routes.get(candidate.operationId) ??
          routes.get(OpenApiDocumentService.annotationKey(candidate.operationId));
        if (!route) {
          unmatched.push(candidate.operationId);
          continue;
        }
        candidate['x-required-permissions'] = route.permissions;
        candidate['x-authentication'] = route.credentials;
        // Reported separately from `x-authentication` because they answer
        // different questions. A route can accept an API key as a credential and
        // still be closed to one: `MachineAccessible` is the opt-in, and without
        // it a correctly-signed key holding the right permission gets 403.
        candidate['x-machine-accessible'] = route.machineAccessible;
      }
    }
    // Said out loud rather than left to be noticed. An operation the walk could
    // not match carries no annotations, which reads exactly like a route that
    // enforces nothing — so the console is told which ones, and shows them as
    // unknown instead of as unguarded.
    if (unmatched.length > 0)
      (document as unknown as Record<string, unknown>)['x-unannotated-operations'] = unmatched;
    return document;
  }
}
