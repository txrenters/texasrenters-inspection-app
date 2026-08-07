/**
 * The account-identity operations the application needs from whatever is
 * storing credentials.
 *
 * A seam for the move off Supabase Auth (see
 * docs/migration/SUPABASE_TO_SELF_HOSTED.md). `SupabaseAdminGateway` is the only
 * implementation today and its behaviour is unchanged; a self-hosted provider
 * satisfies this same contract later, and the call sites do not move.
 *
 * The four method names are deliberately preserved from the gateway. Every
 * existing test stubs it **structurally** — a plain object with these keys,
 * never `jest.mock` of the Supabase module — so keeping the shape keeps
 * admin-operations, profile-deletion and access specs passing untouched.
 *
 * Deliberately narrow. It carries only what provisioning and deletion need:
 * sign-in, refresh and password change are separate concerns and do not belong
 * behind an administrative gateway.
 */
/**
 * The provider's own id for a credential record.
 *
 * Wrapped rather than returned bare so the field name travels with it — this
 * value lands in `UserProfile.authUserId`, which is a plain unique TEXT column
 * and not a foreign key, so nothing downstream constrains its format. A new
 * provider may use any subject format without a schema change.
 */
export interface CreatedIdentity {
  authUserId: string;
}

export interface IdentityProvider {
  /** Create the credential record for a field technician. */
  createTechnicianIdentity(
    email: string,
    password: string,
    displayName: string,
  ): Promise<CreatedIdentity>;

  /** Create the credential record for a console user. */
  createWebUserIdentity(
    email: string,
    password: string,
    displayName: string,
  ): Promise<CreatedIdentity>;

  /**
   * Remove a credential record.
   *
   * Called after the profile transaction commits, and failure is swallowed by
   * the caller on purpose: an orphaned identity is recoverable, a deleted
   * profile whose identity still signs in is not.
   */
  deleteIdentity(authUserId: string): Promise<void>;

  /**
   * Whether a credential record still exists.
   *
   * Must fail closed — a provider that cannot answer has to throw rather than
   * return false, or a lookup failure reads as "safe to recreate" and the
   * provisioning flow would clobber a live account.
   */
  identityExists(authUserId: string): Promise<boolean>;
}

/** DI token, so a provider can be swapped without importing an implementation. */
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
