/**
 * The permission catalog is the fixed menu of capabilities the application can
 * enforce. It is intentionally code-defined: each key maps to a concrete action
 * a route can require. What is *fully customizable* is how an organization's
 * admin groups these keys into roles and assigns them — there are no
 * preconfigured roles. New users start with zero permissions until an admin
 * assigns a role that grants them.
 */
export const PERMISSION_KEYS = [
  'dashboard:read',
  'users:read',
  'users:manage',
  'roles:read',
  'roles:manage',
  'properties:read',
  'properties:manage',
  'inspections:read',
  'inspections:manage',
  'inspections:assign',
  'inspections:finalize',
  'inspections:delete',
  'technicians:read',
  'technicians:manage',
  'technicians:provision',
  'findings:read',
  'findings:review',
  'comparisons:review',
  'charges:configure',
  'charges:review',
  'reports:share',
  'integrations:read',
  'integrations:manage',
  'ai:configure',
  'system:manage',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
  description: string;
}

export interface PermissionGroup {
  group: string;
  description: string;
  permissions: PermissionDefinition[];
}

/**
 * Grouped catalog used to render the role editor. The grouping is presentation
 * only; enforcement always uses the flat {@link PermissionKey}.
 */
export const PERMISSION_CATALOG: PermissionGroup[] = [
  {
    group: 'Workspace',
    description: 'General administrator workspace access.',
    permissions: [
      {
        key: 'dashboard:read',
        label: 'View dashboard',
        description: 'See organization metrics, readiness, synchronization status, and warnings.',
      },
    ],
  },
  {
    group: 'User & access management',
    description: 'Create users and compose the roles that grant every other permission.',
    permissions: [
      {
        key: 'users:read',
        label: 'View users',
        description: 'See the user directory and each user’s assigned roles.',
      },
      {
        key: 'users:manage',
        label: 'Manage users',
        description: 'Invite users, activate/deactivate them, and change their role assignments.',
      },
      {
        key: 'roles:read',
        label: 'View roles',
        description: 'See custom roles and the permissions they grant.',
      },
      {
        key: 'roles:manage',
        label: 'Manage roles',
        description: 'Create, edit, and delete custom roles.',
      },
    ],
  },
  {
    group: 'Properties',
    description: 'Property and unit records.',
    permissions: [
      {
        key: 'properties:read',
        label: 'View properties',
        description: 'Browse properties, units, and floor plans.',
      },
      {
        key: 'properties:manage',
        label: 'Manage properties',
        description: 'Create and edit properties, units, and floor plans.',
      },
    ],
  },
  {
    group: 'Inspections',
    description: 'Inspection scheduling and field operations.',
    permissions: [
      {
        key: 'inspections:read',
        label: 'View inspections',
        description: 'Open inspections, rooms, media, and reports.',
      },
      {
        key: 'inspections:manage',
        label: 'Manage inspections',
        description:
          'Edit and cancel inspections; mark TBD, request follow-ups, and merge duplicate areas.',
      },
      {
        key: 'inspections:assign',
        label: 'Assign technicians',
        description: 'Assign or reassign technicians to inspections.',
      },
      {
        key: 'inspections:finalize',
        label: 'Finalize inspections',
        description:
          'Complete (finalize) an inspection, and reopen a submitted or finalized one to send it back to the technician. Human-only decision that closes the review workflow.',
      },
      {
        key: 'inspections:delete',
        label: 'Delete inspections',
        description:
          'Permanently erase an inspection and every recording, photo, finding and charge attached to it, including the video files themselves. Irreversible, and works even on finalized inspections — grant it only to accounts that are meant to clear test data.',
      },
    ],
  },
  {
    group: 'Technicians',
    description: 'Field technician accounts and workloads.',
    permissions: [
      {
        key: 'technicians:read',
        label: 'View technicians',
        description: 'See technician accounts, availability, and assigned workloads.',
      },
      {
        key: 'technicians:manage',
        label: 'Manage technicians',
        description: 'Activate or deactivate technician accounts.',
      },
      {
        key: 'technicians:provision',
        label: 'Create technicians',
        description: 'Provision a new mobile technician account and temporary password.',
      },
    ],
  },
  {
    group: 'Findings & charges',
    description: 'AI-suggested findings and the human decisions that may lead to tenant charges.',
    permissions: [
      {
        key: 'findings:read',
        label: 'View findings',
        description: 'Read AI findings and room summaries.',
      },
      {
        key: 'findings:review',
        label: 'Review findings',
        description: 'Approve or reject findings that decide tenant charges.',
      },
      {
        key: 'comparisons:review',
        label: 'Review comparisons',
        description:
          'Approve, reject, or override move-in vs move-out comparison classifications.',
      },
      {
        key: 'charges:configure',
        label: 'Configure charge rules',
        description: 'Set configurable charge rules such as the unauthorized-pet amount.',
      },
      {
        key: 'charges:review',
        label: 'Review charges',
        description:
          'Review pet candidates and approve, reject, adjust, or waive proposed tenant charges.',
      },
    ],
  },
  {
    group: 'Reports & integrations',
    description: 'Sharing and external systems.',
    permissions: [
      {
        key: 'reports:share',
        label: 'Share reports',
        description: 'Generate and revoke homeowner report share links.',
      },
      {
        key: 'integrations:read',
        label: 'View integrations',
        description: 'See Propertyware and AI provider configuration.',
      },
      {
        key: 'integrations:manage',
        label: 'Manage integrations',
        description: 'Run Propertyware syncs and edit integration settings.',
      },
      {
        key: 'ai:configure',
        label: 'Configure AI',
        description: 'Change AI provider routing and manage provider credentials.',
      },
    ],
  },
  {
    group: 'Advanced administration',
    description: 'Sensitive platform operations that should be granted sparingly.',
    permissions: [
      {
        key: 'system:manage',
        label: 'Manage system operations',
        description: 'Inspect cache health and run cache administration operations.',
      },
    ],
  },
];

/**
 * SYSTEM_ADMIN is the sole bootstrap/break-glass principal. It receives the
 * complete catalog so an organization can create its first custom role and
 * recover from an accidental lockout. Every other web user receives permissions
 * exclusively from administrator-created roles; legacy membership labels never
 * imply operational permissions.
 */
export function resolveEffectivePermissions(
  legacyRoles: readonly string[],
  customRolePermissions: readonly string[],
): PermissionKey[] {
  if (legacyRoles.includes('SYSTEM_ADMIN')) return [...PERMISSION_KEYS];
  const effective = new Set<PermissionKey>();
  for (const permission of customRolePermissions)
    if (isPermissionKey(permission)) effective.add(permission);
  return [...effective];
}

/**
 * Permissions a third-party API key can never hold.
 *
 * Two categories, and both matter for a different reason.
 *
 * **Self-escalation.** `roles:manage` composes the very permissions this list
 * restricts, and `users:manage` can assign those roles. A key holding either
 * could grant itself everything it is denied here, which would make the rest of
 * this list decorative. `system:manage` and `ai:configure` reach operator
 * controls and provider secrets, which are not integration surface at all.
 *
 * **Irreversibility.** `inspections:delete` hard-deletes an inspection *and its
 * media* — there is no restore, and a machine caller looping over a list is
 * exactly how that becomes catastrophic rather than merely bad. Finalization
 * freezes evidence permanently, and charge review is money. A person, holding
 * the permission and looking at the screen, may do these things; a credential
 * left in a third party's configuration file may not.
 *
 * Enforced where keys are issued, not only where they are used, so a key that
 * should never have existed cannot be created in the first place.
 */
export const MACHINE_FORBIDDEN_PERMISSIONS = [
  'roles:manage',
  'users:manage',
  'system:manage',
  'ai:configure',
  'inspections:delete',
  'inspections:finalize',
  'charges:review',
] as const satisfies readonly PermissionKey[];

const MACHINE_FORBIDDEN_SET: ReadonlySet<string> = new Set(MACHINE_FORBIDDEN_PERMISSIONS);

/** Whether a permission may be granted to an API client. */
export function isMachineGrantablePermission(value: string): value is PermissionKey {
  return isPermissionKey(value) && !MACHINE_FORBIDDEN_SET.has(value);
}

/** The permissions an API client may be granted, in catalog order. */
export const MACHINE_GRANTABLE_PERMISSIONS: PermissionKey[] = PERMISSION_KEYS.filter(
  (key): key is PermissionKey => !MACHINE_FORBIDDEN_SET.has(key),
);
