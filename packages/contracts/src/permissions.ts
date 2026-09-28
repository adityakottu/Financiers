/**
 * Permission catalogue (doc 05). Code checks permissions, never role names.
 * Later phases add their permissions here; seeding syncs this list into the DB.
 */
export const PERMISSIONS = {
  // Platform & admin
  'user.manage': 'Create, edit, disable users',
  'role.manage': 'Manage roles',
  'permission.assign': 'Assign roles and permission overrides to users',
  'branch.manage': 'Create and edit branches',
  'employee.view': 'View employees',
  'employee.manage': 'Create and edit employees',
  'settings.company': 'Edit company settings',
  'settings.numbering': 'Edit numbering formats',
  'audit.view': 'View audit logs',
  'session.manage_others': 'Force logout other users',

  // Customers
  'customer.view': 'View customers',
  'customer.create': 'Create customers',
  'customer.edit': 'Edit customers',
  'customer.view_contact': 'See unmasked mobile numbers',
  'kyc.view_masked': 'See masked KYC identifiers',
  'kyc.reveal': 'Reveal full KYC identifiers (audited)',
  'document.upload': 'Upload documents',
  'document.view_kyc': 'View KYC documents',
  'search.global': 'Use global search',

  // Dashboards
  'dashboard.company': 'Company dashboard',
  'dashboard.branch': 'Branch dashboard',
  'dashboard.collector': 'Collector dashboard',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * Row scope a role gets.
 * ALL = every branch, BRANCH = branches in user_branches, ASSIGNED = assigned loans/customers only.
 */
export type Scope = 'ALL' | 'BRANCH' | 'ASSIGNED';

export const ROLE_CODES = [
  'SUPER_ADMIN',
  'MANAGEMENT',
  'BRANCH_MANAGER',
  'ACCOUNTANT',
  'COLLECTION_EMPLOYEE',
] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  scope: Scope;
  mfaRequired: boolean;
  permissions: Permission[];
}

export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    scope: 'ALL',
    mfaRequired: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    code: 'MANAGEMENT',
    name: 'Main Head / Management',
    scope: 'ALL',
    mfaRequired: true,
    permissions: [
      'employee.view',
      'audit.view',
      'customer.view',
      'customer.view_contact',
      'kyc.view_masked',
      'document.view_kyc',
      'search.global',
      'dashboard.company',
      'dashboard.branch',
      'dashboard.collector',
    ],
  },
  {
    code: 'BRANCH_MANAGER',
    name: 'Branch Manager',
    scope: 'BRANCH',
    mfaRequired: false,
    permissions: [
      'employee.view',
      'employee.manage',
      'audit.view',
      'customer.view',
      'customer.create',
      'customer.edit',
      'customer.view_contact',
      'kyc.view_masked',
      'kyc.reveal',
      'document.upload',
      'document.view_kyc',
      'search.global',
      'dashboard.branch',
      'dashboard.collector',
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    scope: 'BRANCH',
    mfaRequired: true,
    permissions: [
      'employee.view',
      'audit.view',
      'customer.view',
      'customer.view_contact',
      'kyc.view_masked',
      'document.upload',
      'search.global',
      'dashboard.branch',
    ],
  },
  {
    code: 'COLLECTION_EMPLOYEE',
    name: 'Collection Employee',
    scope: 'ASSIGNED',
    mfaRequired: false,
    permissions: ['customer.view', 'customer.view_contact', 'search.global', 'dashboard.collector'],
  },
];

const SCOPE_RANK: Record<Scope, number> = { ASSIGNED: 0, BRANCH: 1, ALL: 2 };

/** The widest scope among a user's roles. */
export function widestScope(scopes: Scope[]): Scope {
  return scopes.reduce<Scope>((a, b) => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a), 'ASSIGNED');
}
