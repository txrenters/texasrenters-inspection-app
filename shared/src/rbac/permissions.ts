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
  'properties:delete-areas',
  'inspections:read',
  'inspections:manage',
  'inspections:assign',
  'inspections:finalize',
  'inspections:delete',
  'work-orders:manage',
  'technicians:read',
  'technicians:locate',
  'technicians:manage',
  'technicians:provision',
  'technicians:skills',
  'planning:read',
  'planning:publish',
  'findings:read',
  'findings:review',
  'comparisons:review',
  'charges:configure',
  'charges:review',
  'invoices:read',
  'invoices:manage',
  'payments:record',
  'inventory:read',
  'inventory:manage',
  'inventory:withdraw',
  'inventory:count',
  'inventory:count-approve',
  'purchasing:request',
  'purchasing:approve',
  'purchasing:approve-any',
  'purchasing:approve-orders',
  'purchasing:order',
  'purchasing:receive',
  'purchasing:bills',
  'purchasing:codes',
  'purchasing:setup',
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
      {
        key: 'properties:delete-areas',
        label: 'Delete property areas',
        description:
          'Permanently erase an approved area from a property layout, singly or in bulk. Separate from managing properties because it is irreversible and it is layout, not a record: an area an inspection has already used is refused outright, so what this reaches is the plan future inspections are copied from. Grant it to accounts that are meant to clear test or mock layouts.',
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
      {
        key: 'work-orders:manage',
        label: 'Receive work orders',
        description:
          'Hand repair work orders for the in-house crews to this app as maintenance visits, and update or cancel them as the work order changes. Meant for the maintenance app’s API client; it reaches nothing else.',
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
        description: 'See technician accounts, their skills, and assigned workloads.',
      },
      {
        key: 'technicians:locate',
        label: 'View technician locations',
        description:
          'See where technicians are now and the route history their handsets have reported. Separate from viewing the directory: this is live tracking of a named person, and granting it should be a decision of its own.',
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
      {
        key: 'technicians:skills',
        label: 'Manage technician skills',
        description:
          'Edit the skill catalog, grant and revoke skills on a technician, and set which skills each kind of inspection requires. Scheduling reads these to decide who is eligible for a visit.',
      },
    ],
  },
  {
    group: 'Scheduling',
    description: 'Quarterly inspection plans, from draft to published work.',
    permissions: [
      {
        key: 'planning:read',
        label: 'View quarterly plans',
        description:
          'Open a quarter plan and see the tenant order, the technician on each stop, and the routes.',
      },
      {
        key: 'planning:publish',
        label: 'Publish quarterly plans',
        description:
          'Edit a draft plan and publish it. Publishing creates every inspection in the quarter and books each visit in Jobber, and there is no bulk undo — this is the moment a plan becomes several hundred real appointments.',
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
    group: 'Invoices & payments',
    description: 'The visits billed in Jobber, and the payments recorded against them.',
    permissions: [
      {
        key: 'invoices:read',
        label: 'View invoices and payments',
        description: 'Open the Invoices and Payments lists, each invoice, and the invoices on a property or a visit.',
      },
      {
        key: 'invoices:manage',
        label: 'Create invoices',
        description:
          'Make the invoice for a finished visit and send it to Jobber. A person decides every line and price; nothing is invoiced on its own.',
      },
      {
        key: 'payments:record',
        label: 'Record payments',
        description:
          'Record a payment against an invoice -- after the charge has posted in Propertyware -- which marks it paid in Jobber. No card is charged.',
      },
    ],
  },
  {
    group: 'Inventory',
    description: 'What the office stocks, where it is kept, and every movement of it.',
    permissions: [
      {
        key: 'inventory:read',
        label: 'View inventory',
        description: 'Open the Inventory page: the items, what is on hand in each place, their cost, and every movement.',
      },
      {
        key: 'inventory:manage',
        label: 'Manage inventory',
        description:
          'Add and change items, places and vendors, enter an opening balance, and reverse a movement. Stock is never typed over: every change is a movement, kept with who made it.',
      },
      {
        key: 'inventory:withdraw',
        label: 'Record withdrawals',
        description: 'Record what a technician took for a visit or a truck, what came back, and stock moved between places; and reverse one that was wrong. With "View inventory".',
      },
      {
        key: 'inventory:count',
        label: 'Count stock',
        description: 'Start a monthly, quarterly or yearly count and enter what is on the shelf. The expected numbers are not shown to whoever counts. With "View inventory".',
      },
      {
        key: 'inventory:count-approve',
        label: 'Approve counts',
        description: 'Review what a count found different, ask for a second count, and approve and post it, which changes what is on hand. Never for a count this person counted. With "View inventory".',
      },
    ],
  },
  {
    group: 'Purchasing',
    description: 'Asking for stock to be bought, and deciding what is.',
    permissions: [
      {
        key: 'purchasing:request',
        label: 'Make purchase requisitions',
        description: 'Open Purchasing, ask for stock to be bought and say why, and see your own requisitions. Needed for the two below.',
      },
      {
        key: 'purchasing:approve',
        label: 'Approve requisitions',
        description:
          "See everyone's requisitions and approve, send back or reject those of your departments and companies, up to your approval limit -- your own too, never sending back your own.",
      },
      {
        key: 'purchasing:approve-orders',
        label: 'Approve purchase orders',
        description:
          "The purchasing manager's: see every purchase order and approve it or send it back before the purchaser sends it to the vendor, up to your approval limit, and approve a bill that does not match.",
      },
      {
        key: 'purchasing:approve-any',
        label: 'Approve any amount',
        description: 'Approve a requisition or purchase order in an approval step that needs somebody who may approve any amount: the overall manager. With one of the two above.',
      },
      {
        key: 'purchasing:order',
        label: 'Make purchase orders',
        description:
          "See everyone's submitted requisitions, turn an approved one into a purchase order, send it to the vendor and cancel it. An order is approved by the purchasing manager first.",
      },
      {
        key: 'purchasing:receive',
        label: 'Receive goods',
        description: 'Post what arrived against a purchase order, which puts it into stock, and reverse a receipt that was wrong.',
      },
      {
        key: 'purchasing:bills',
        label: 'Enter and pay vendor bills',
        description:
          "Enter the vendor's bill for an order, approve one that matches the order and what was received, and record its payment. No money moves in the console. A bill that does not match needs \"Approve any amount\".",
      },
      {
        key: 'purchasing:codes',
        label: 'Manage purchasing codes',
        description:
          "Make and change the codes a requisition picks from: line types, request codes, department and cost center codes and their Xero tracking, and each company's purchaser code.",
      },
      {
        key: 'purchasing:setup',
        label: 'Purchasing admin',
        description:
          'Open Purchasing Setup and change it: the approval steps by amount, the approver emails and reminders, document numbers and the rules for files on a requisition. Every change is audited.',
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
 * freezes evidence permanently, and charge review is money. `planning:publish`
 * turns a draft into several hundred inspections and several hundred Jobber
 * visits in one call, with no bulk undo behind it. A person, holding the
 * permission and looking at the screen, may do these things; a credential left
 * in a third party's configuration file may not.
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
  'properties:delete-areas',
  'inspections:finalize',
  'planning:publish',
  'charges:review',
  // Money, sent to Jobber: a person at the screen, never a stored credential.
  'invoices:manage',
  'payments:record',
  // Stock is money on a shelf: its movements are made by a person at the screen.
  'inventory:manage',
  'inventory:withdraw',
  'inventory:count',
  'inventory:count-approve',
  // Asking for money to be spent, and agreeing to it: people, never a stored credential.
  'purchasing:request',
  'purchasing:approve',
  'purchasing:approve-any',
  'purchasing:approve-orders',
  'purchasing:order',
  'purchasing:receive',
  'purchasing:bills',
  // The lists a requisition is coded with: changed by a person at the screen.
  'purchasing:codes',
  'purchasing:setup',
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
