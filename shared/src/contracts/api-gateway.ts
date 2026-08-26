/**
 * Contracts for third-party API access: the client registry the console
 * administers, and the shape of the OpenAPI document it reads.
 */

export type ApiClientEnvironment = 'LIVE' | 'TEST';

export interface ApiClientKeySummary {
  id: string;
  /**
   * The non-secret half of the credential. Safe to display and to log — that is
   * what it is for. The secret half appears exactly once, in
   * {@link IssuedApiKey}, and is never retrievable afterwards.
   */
  prefix: string;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}

export interface ApiClientSummary {
  id: string;
  name: string;
  description: string | null;
  environment: ApiClientEnvironment;
  permissions: string[];
  rateLimitPerMinute: number;
  requireSignature: boolean;
  allowedIps: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  keys: ApiClientKeySummary[];
}

/**
 * A newly minted key.
 *
 * `key` is present on this response and on no other. The server stores only a
 * keyed hash of it, so a console that fails to show it here has destroyed it.
 */
export interface IssuedApiKey extends ApiClientKeySummary {
  key: string;
}

export interface ApiClientRevocation {
  id: string;
  revoked: true;
  revokedAt: string;
}

/** Credentials a route will accept. */
export type ApiRouteCredential = 'BEARER' | 'API_KEY';

/**
 * One operation from the OpenAPI document, narrowed to what the reference page
 * reads.
 *
 * The `x-` members are this API's own annotations rather than anything OpenAPI
 * defines. They are generated from the same guard metadata the guards
 * themselves read, so the documentation cannot drift from enforcement.
 */
export interface ApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: ApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: ApiSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: ApiSchema }> }>;
  'x-required-permissions'?: string[];
  'x-authentication'?: ApiRouteCredential[];
  /**
   * Whether an API key may reach this route at all. Distinct from
   * `x-authentication`: a route can accept a key as a credential and still be
   * closed to one, which is the default for every route in the system.
   */
  'x-machine-accessible'?: boolean;
}

export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: ApiSchema;
}

/** A JSON Schema fragment, as much of it as the reference renders. */
export interface ApiSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  nullable?: boolean;
  items?: ApiSchema;
  properties?: Record<string, ApiSchema>;
  required?: string[];
  $ref?: string;
  allOf?: ApiSchema[];
  oneOf?: ApiSchema[];
  anyOf?: ApiSchema[];
}

export interface ApiDocument {
  openapi: string;
  info: { title: string; description?: string; version: string };
  paths: Record<string, Record<string, ApiOperation>>;
  components?: {
    schemas?: Record<string, ApiSchema>;
    securitySchemes?: Record<string, { type: string; name?: string; in?: string; scheme?: string }>;
  };
}

/** HTTP methods a path item can carry, in the order the reference lists them. */
export const API_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

export type ApiMethod = (typeof API_METHODS)[number];
