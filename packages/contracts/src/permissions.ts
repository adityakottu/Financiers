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

  // Lending
  'product.manage': 'Create and change loan products',
  'loan.view': 'View loans, schedules and assets',
  'loan.create': 'Create loan applications',
  'loan.approve': 'Approve or reject loans up to the product approval limit',
  'loan.approve_high': 'Approve or reject loans above the product approval limit',
  'loan.disburse': 'Disburse approved loans',
  'loan.cancel': 'Cancel loans that have not been disbursed',
  'asset.edit': 'Edit financed asset details and documents',
  'statement.generate': 'Download loan statements',

  // Collections & payments
  'payment.collect': 'Record payments and issue receipts',
  'payment.view': 'View payments and receipts',
  'payment.reverse_request': 'Ask for a payment to be reversed',
  'payment.reverse_approve': 'Approve or reject payment reversals (not your own requests)',
  'collection.assign': 'Assign loans to collectors',
  'collection.view_team': 'See collections of all collectors in scope',
  'message.send': 'Send SMS / WhatsApp messages to customers',
  'message.view': 'View message logs',
  'message.configure': 'Edit message templates and reminder rules',

  // Accounting
  'ledger.view': 'View chart of accounts, journals and ledgers',
  'coa.manage': 'Add bank and cash accounts',
  'expense.submit': 'Submit expenses (own or for the branch)',
  'expense.view': 'View branch expenses',
  'expense.approve': 'Approve expenses at branch level (not your own)',
  'expense.post': 'Post approved expenses to the books (not your own)',
  'deposit.record': 'Record cash deposits and transfers between cash and bank',
  'cheque.manage': 'Deposit, clear and bounce cheques',
  'journal.create': 'Prepare manual journal entries',
  'journal.approve': 'Approve manual journal entries (not your own)',
  'period.soft_lock': 'Soft-lock an accounting month',
  'period.lock': 'Lock an accounting month',
  'period.unlock': 'Unlock an accounting month (audited, with reason)',

  // Reconciliation
  'recon.view': 'See reconciliation: settlements, statements, day status',
  'settlement.submit': 'Declare own cash in hand at end of day',
  'settlement.verify': 'Count and verify an employee’s cash (not your own)',
  'difference.approve': 'Approve settlement differences up to the threshold (not your own)',
  'difference.approve_high': 'Approve settlement differences above the threshold',
  'statement.import': 'Import bank / UPI statements',
  'recon.match': 'Confirm, reject or undo statement matches',
  'day.close': 'Close a branch business day; ask for a reopen',
  'day.reopen': 'Approve reopening a closed business day (not your own request)',

  // Recovery
  'recovery.view': 'See recovery cases, stages and actions',
  'recovery.note': 'Add notes, calls and visits to recovery cases',
  'recovery.manage': 'Open and close recovery cases, move stages, request repossession and sale',
  'recovery.approve': 'Approve stage moves that need approval, repossession and asset sale (not your own requests)',
  'recovery.configure': 'Edit recovery stage definitions',
  'loan.write_off_request': 'Ask for a loan to be written off',
  'loan.write_off': 'Approve a loan write-off (not your own request)',

  // Reports & exports
  'report.loan': 'Loan reports',
  'report.collection': 'Collection reports (collectors: their own)',
  'report.accounting': 'Accounting reports and the CA pack',
  'report.reconciliation': 'Reconciliation reports',
  'export.data': 'Download reports as Excel / PDF (audited)',

  // Migration & pilot
  'import.run': 'Upload and validate data-migration files (customers, running loans)',
  'import.confirm': 'Confirm a validated migration import (not your own upload)',
  'pilot.compare': 'Upload the old process’s day sheet and see the parallel-run comparison',
  'pilot.sign_off': 'Sign off a parallel-run day',

  // System
  'jobs.run': 'Run end-of-day jobs manually',

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
      'import.confirm',
      'pilot.compare',
      'pilot.sign_off',
      'recovery.view',
      'recovery.note',
      'recovery.manage',
      'recovery.approve',
      'loan.write_off',
      'report.loan',
      'report.collection',
      'report.accounting',
      'report.reconciliation',
      'export.data',
      'recon.view',
      'difference.approve',
      'difference.approve_high',
      'day.reopen',
      'expense.view',
      'expense.approve',
      'journal.approve',
      'period.lock',
      'period.unlock',
      'payment.view',
      'payment.reverse_approve',
      'collection.view_team',
      'message.view',
      'loan.view',
      'loan.approve',
      'loan.approve_high',
      'statement.generate',
      'ledger.view',
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
      'import.run',
      'pilot.compare',
      'pilot.sign_off',
      'recovery.view',
      'recovery.note',
      'recovery.manage',
      'loan.write_off_request',
      'report.loan',
      'report.collection',
      'report.accounting',
      'report.reconciliation',
      'export.data',
      'recon.view',
      'settlement.submit',
      'settlement.verify',
      'difference.approve',
      'day.close',
      'expense.submit',
      'expense.view',
      'expense.approve',
      'deposit.record',
      'cheque.manage',
      'payment.collect',
      'payment.view',
      'payment.reverse_request',
      'payment.reverse_approve',
      'collection.assign',
      'collection.view_team',
      'message.send',
      'message.view',
      'loan.view',
      'loan.create',
      'loan.approve',
      'loan.disburse',
      'loan.cancel',
      'asset.edit',
      'statement.generate',
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
      'import.run',
      'pilot.compare',
      'recovery.view',
      'report.loan',
      'report.collection',
      'report.accounting',
      'report.reconciliation',
      'export.data',
      'recon.view',
      'settlement.verify',
      'statement.import',
      'recon.match',
      'day.close',
      'expense.submit',
      'expense.view',
      'expense.post',
      'deposit.record',
      'cheque.manage',
      'journal.create',
      'journal.approve',
      'period.soft_lock',
      'payment.collect',
      'payment.view',
      'payment.reverse_request',
      'payment.reverse_approve',
      'collection.view_team',
      'message.view',
      'loan.view',
      'loan.disburse',
      'statement.generate',
      'ledger.view',
      'coa.manage',
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
    permissions: [
      'recovery.view',
      'recovery.note',
      'report.collection',
      'settlement.submit',
      'expense.submit',
      'payment.collect',
      'payment.view',
      'payment.reverse_request',
      'message.send',
      'loan.view',
      'customer.view',
      'customer.view_contact',
      'search.global',
      'dashboard.collector',
    ],
  },
];

const SCOPE_RANK: Record<Scope, number> = { ASSIGNED: 0, BRANCH: 1, ALL: 2 };

/** The widest scope among a user's roles. */
export function widestScope(scopes: Scope[]): Scope {
  return scopes.reduce<Scope>((a, b) => (SCOPE_RANK[b] > SCOPE_RANK[a] ? b : a), 'ASSIGNED');
}
