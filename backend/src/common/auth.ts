import { createHmac, timingSafeEqual } from 'node:crypto';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { type PermissionKey, resolveEffectivePermissions, UserRole } from '@texasrenters/shared';

import { PrismaService } from './prisma.service';
import { withSystemTenant } from '../database/tenant-context';

export interface AuthenticatedUser {
  id: string;
  authUserId: string;
  organizationId: string;
  displayName: string;
  roles: UserRole[];
  // Effective permissions for the resolved org. SYSTEM_ADMIN is the protected
  // bootstrap principal; every other web user receives permissions only from
  // administrator-created custom roles.
  permissions: PermissionKey[];
  mustChangePassword: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface RequiredPasswordRequest extends Request {
  auth: {
    authUserId: string;
    mustChangePassword: true;
  };
}

export async function authenticateApplicationUser(
  prisma: PrismaService,
  token: string,
  requestedOrganization?: string,
): Promise<AuthenticatedUser> {
  const claims = await verifySupabaseAccessToken(token);
  // The one query that cannot be tenant-scoped, because it is what *produces*
  // the tenant. `UserProfile` is unpoliced, but the nested `memberships` and
  // `roleAssignments` are not — and with policies that fail closed, reading
  // them without a tenant returns nothing, so every request 401s with "No
  // active organization membership". That is exactly what happened the first
  // time the policies were tightened.
  const profile = await withSystemTenant(() =>
    prisma.userProfile.findUnique({
      where: { authUserId: claims.sub },
      select: {
        id: true,
        displayName: true,
        isActive: true,
        memberships: { select: { organizationId: true, role: true } },
        roleAssignments: {
          select: { organizationId: true, role: { select: { permissions: true } } },
        },
      },
    }),
  );
  if (!profile?.isActive) throw new UnauthorizedException('No active application profile.');
  const memberships = profile.memberships.filter(
    (membership) => !requestedOrganization || membership.organizationId === requestedOrganization,
  );
  if (memberships.length === 0)
    throw new UnauthorizedException('No active organization membership.');
  const organizationId = requestedOrganization ?? memberships[0]!.organizationId;
  const roles = memberships
    .filter((membership) => membership.organizationId === organizationId)
    .map((membership) => membership.role as UserRole);
  const customRolePermissions = (profile.roleAssignments ?? [])
    .filter((assignment) => assignment.organizationId === organizationId)
    .flatMap((assignment) => assignment.role.permissions);
  return {
    id: profile.id,
    authUserId: claims.sub,
    organizationId,
    displayName: profile.displayName,
    roles,
    permissions: resolveEffectivePermissions(roles, customRolePermissions),
    mustChangePassword: claims.app_metadata?.must_change_password === true,
  };
}

function mockUser(user: Omit<AuthenticatedUser, 'permissions'>): AuthenticatedUser {
  return { ...user, permissions: resolveEffectivePermissions(user.roles, []) };
}

export const MOCK_USERS: Record<string, AuthenticatedUser> = {
  '10000000-0000-4000-8000-000000000002': mockUser({
    id: '10000000-0000-4000-8000-000000000002',
    authUserId: '10000000-0000-4000-8000-000000000002',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'System Admin',
    roles: [UserRole.SYSTEM_ADMIN],
    mustChangePassword: false,
  }),
  '10000000-0000-4000-8000-000000000003': mockUser({
    id: '10000000-0000-4000-8000-000000000003',
    authUserId: '10000000-0000-4000-8000-000000000003',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'Property Admin',
    roles: [UserRole.PROPERTY_ADMIN],
    mustChangePassword: false,
  }),
  '10000000-0000-4000-8000-000000000004': mockUser({
    id: '10000000-0000-4000-8000-000000000004',
    authUserId: '10000000-0000-4000-8000-000000000004',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'Taylor Technician',
    roles: [UserRole.INSPECTION_TECHNICIAN],
    mustChangePassword: false,
  }),
  '10000000-0000-4000-8000-000000000005': mockUser({
    id: '10000000-0000-4000-8000-000000000005',
    authUserId: '10000000-0000-4000-8000-000000000005',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'Riley Reviewer',
    roles: [UserRole.CONDITION_REVIEWER],
    mustChangePassword: false,
  }),
  '10000000-0000-4000-8000-000000000006': mockUser({
    id: '10000000-0000-4000-8000-000000000006',
    authUserId: '10000000-0000-4000-8000-000000000006',
    organizationId: '10000000-0000-4000-8000-000000000001',
    displayName: 'Casey Approver',
    roles: [UserRole.CHARGE_APPROVER],
    mustChangePassword: false,
  }),
};

export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);

export const PERMISSIONS_METADATA_KEY = 'permissions';
/**
 * Requires the authenticated user to hold ALL listed permissions. Enforced by
 * {@link PermissionsGuard}. Permissions are computed per organization from the
 * user's assigned custom roles, with the protected SYSTEM_ADMIN bootstrap
 * override.
 */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);

@Injectable()
export class ApiAuthGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (process.env.USE_MOCK_AUTH === 'true') return this.authenticateMock(request);
    const token = bearerToken(request.header('authorization'));
    const requestedOrganization = request.header('x-organization-id');
    request.user = await authenticateApplicationUser(this.prisma, token, requestedOrganization);
    return true;
  }

  private authenticateMock(request: AuthenticatedRequest) {
    if (process.env.NODE_ENV === 'production')
      throw new UnauthorizedException('Mock authentication is disabled in production.');
    const header = request.header('x-mock-user-id');
    const id =
      header ?? process.env.MOCK_AUTH_DEFAULT_USER_ID ?? '10000000-0000-4000-8000-000000000004';
    const user = MOCK_USERS[id];
    if (!user) throw new UnauthorizedException('Unknown mock user.');
    request.user = user;
    return true;
  }
}

interface SupabaseClaims {
  sub: string;
  aud?: string | string[];
  iss?: string;
  exp: number;
  nbf?: number;
  app_metadata?: Record<string, unknown>;
}

function bearerToken(header?: string) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new UnauthorizedException('A bearer access token is required.');
  return match[1];
}

/**
 * The issuer and audience an access token must carry.
 *
 * Both were hardcoded to Supabase's shapes — `${SUPABASE_URL}/auth/v1` and the
 * literal `authenticated`. They are configuration now, defaulting to exactly
 * those values, so tokens minted today keep verifying unchanged and the
 * self-hosted issuer becomes an env change rather than a code change.
 *
 * Derived per call rather than cached: the tests set these in `beforeEach`, and
 * a module-level constant would freeze whichever value happened to be present
 * when the module was first imported.
 */
export function expectedTokenIssuer() {
  const configured = process.env.AUTH_JWT_ISSUER?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  return supabaseUrl ? `${supabaseUrl}/auth/v1` : '';
}

export function expectedTokenAudience() {
  return process.env.AUTH_JWT_AUDIENCE?.trim() || 'authenticated';
}

export function verifySupabaseJwt(token: string): SupabaseClaims {
  const secret = process.env.AUTH_JWT_SECRET?.trim() || process.env.SUPABASE_JWT_SECRET;
  const issuer = expectedTokenIssuer();
  if (!secret || !issuer)
    throw new UnauthorizedException('Supabase authentication is not configured.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Invalid access token.');
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string };
    if (header.alg !== 'HS256') throw new Error('Unsupported signing algorithm.');
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2]!, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('Invalid signature.');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as SupabaseClaims;
    const now = Math.floor(Date.now() / 1000);
    if (!claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now)
      throw new Error('Expired.');
    if (claims.nbf && claims.nbf > now) throw new Error('Not active.');
    if (claims.iss !== issuer) throw new Error('Invalid issuer.');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedTokenAudience())) throw new Error('Invalid audience.');
    return claims;
  } catch {
    throw new UnauthorizedException('Invalid or expired access token.');
  }
}

/**
 * Verify an access token.
 *
 * HS256 only. This used to branch: HS256 verified locally, while ES256/RS256
 * were handed to a Supabase client that fetched the project's JWKS — a
 * migration shim from when Supabase moved to per-project asymmetric signing
 * keys. Nothing issues those tokens any more, so the branch verified nothing
 * and only kept the Supabase SDK on the authentication path.
 *
 * An asymmetric token now fails here rather than being sent anywhere, which is
 * the correct answer for a token this deployment cannot have issued.
 */
export async function verifySupabaseAccessToken(token: string): Promise<SupabaseClaims> {
  if (tokenAlgorithm(token) !== 'HS256')
    throw new UnauthorizedException('Invalid or expired access token.');
  return verifySupabaseJwt(token);
}

function tokenAlgorithm(token: string) {
  try {
    const [encodedHeader] = token.split('.');
    if (!encodedHeader) throw new Error('Missing header.');
    return (
      (JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()) as { alg?: string }).alg ?? ''
    );
  } catch {
    throw new UnauthorizedException('Invalid or expired access token.');
  }
}


@Injectable()
export class RequiredPasswordAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequiredPasswordRequest>();
    const claims = await verifySupabaseAccessToken(bearerToken(request.header('authorization')));
    if (claims.app_metadata?.must_change_password !== true)
      throw new ForbiddenException('This account does not require a password replacement.');
    request.auth = { authUserId: claims.sub, mustChangePassword: true };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user.mustChangePassword)
      throw new ForbiddenException('A password change is required before using the application.');
    return required.some((role) => request.user.roles.includes(role));
  }
}

/**
 * Authorizes routes annotated with {@link RequirePermissions}. The user must
 * hold every listed permission (AND semantics). Runs after {@link ApiAuthGuard}
 * so `request.user` is populated.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user.mustChangePassword)
      throw new ForbiddenException('A password change is required before using the application.');
    const held = new Set(request.user.permissions);
    if (required.every((permission) => held.has(permission))) return true;
    throw new ForbiddenException('You do not have permission to perform this action.');
  }
}
