import { DocumentBuilder } from '@nestjs/swagger';

/**
 * The API key header third-party integrations authenticate with.
 *
 * Named here rather than in the gateway module because both the security scheme
 * advertised in the OpenAPI document and the guard that reads the header have to
 * agree, and a documented header the guard does not read is worse than no
 * documentation at all.
 */
export const API_KEY_HEADER = 'x-api-key';
export const API_KEY_SECURITY_SCHEME = 'apiKey';
export const BEARER_SECURITY_SCHEME = 'bearer';

/**
 * The single definition of what this API calls itself.
 *
 * Shared by the Swagger UI mounted at `/api/docs` and by the guarded document
 * endpoint the console reads, so the two cannot describe the same API
 * differently.
 */
export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle('TexasRenters Inspection API')
    .setDescription(
      [
        'REST API for the inspection platform.',
        '',
        'Two credential types reach this API. Administrators and technicians send a',
        'bearer access token issued by this backend. Registered third-party',
        `integrations send an \`${API_KEY_HEADER}\` header instead, and reach only the`,
        'subset of routes explicitly opened to machine callers.',
        '',
        'Every route reports the permissions it enforces as `x-required-permissions`',
        'and the credentials it accepts as `x-authentication`. AI findings always',
        'require human review; no credential of any kind can approve a financial charge.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      BEARER_SECURITY_SCHEME,
    )
    .addApiKey(
      {
        type: 'apiKey',
        name: API_KEY_HEADER,
        in: 'header',
        description:
          'Third-party integration key, in the form `trk_<environment>_<prefix>.<secret>`. ' +
          'Server-to-server only — a key placed in browser JavaScript is a published key.',
      },
      API_KEY_SECURITY_SCHEME,
    )
    .build();
}
