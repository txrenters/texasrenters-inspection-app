import { SetMetadata } from '@nestjs/common';

export const MACHINE_ACCESSIBLE_METADATA_KEY = 'machine-accessible';

/**
 * Opens one route to third-party API keys.
 *
 * **Default closed, and that is the whole point.** Holding a matching permission
 * is not sufficient: a key that has `inspections:read` still gets 403 on an
 * inspection route that is not annotated. Without this, shipping the gateway
 * would have made all 179 routes third-party reachable on the same day —
 * including ones that hard-delete evidence — because the permission catalog was
 * designed for people looking at a screen, not for a credential sitting in
 * someone else's configuration file.
 *
 * Adding this to a route is a deliberate act with a blast radius. Before you do:
 * the route must be safe to call repeatedly, must not return more of a tenant's
 * data than the integration needs, and — if it writes — must be idempotent or
 * signature-protected, because a machine that retries is the normal case rather
 * than the exception.
 */
export const MachineAccessible = () => SetMetadata(MACHINE_ACCESSIBLE_METADATA_KEY, true);
