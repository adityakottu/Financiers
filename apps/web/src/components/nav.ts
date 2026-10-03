import type { Permission } from '@fin/contracts';
import {
  BarChart3,
  BookOpen,
  Calculator,
  Package,
  Bell,
  Boxes,
  Building2,
  CalendarClock,
  FileText,
  HandCoins,
  Landmark,
  LayoutDashboard,
  MessageSquare,
  Receipt,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Visible only with all of these permissions. */
  requires?: Permission[];
  /** Planned module: shown dimmed with the phase that delivers it. */
  phase?: number;
  /** Only for users linked to a collector employee record. */
  collectorOnly?: boolean;
  /** Visible with any one of these permissions. */
  requiresAny?: Permission[];
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Navigation per doc 01 §42. Reconciliation is a first-class entry, not buried under Accounts. */
export const NAV: NavGroup[] = [
  {
    items: [
      { label: 'Dashboard', href: '/', icon: LayoutDashboard },
      { label: 'Customers', href: '/customers', icon: Users, requires: ['customer.view'] },
      { label: 'Loans', href: '/loans', icon: Landmark, requires: ['loan.view'] },
      { label: 'Calculator', href: '/calculator', icon: Calculator, requires: ['loan.view'] },
      { label: 'Assets', href: '/assets', icon: Boxes, requires: ['loan.view'] },
      { label: 'My collections', href: '/collect', icon: HandCoins, requires: ['payment.collect'], collectorOnly: true },
      { label: 'Collections', href: '/collections', icon: HandCoins, requires: ['collection.view_team'] },
      { label: 'Installments due', href: '/installments', icon: CalendarClock, requires: ['loan.view'] },
    ],
  },
  {
    label: 'Money',
    items: [
      { label: 'Reconciliation', href: '/reconciliation', icon: Scale, phase: 6 },
      { label: 'Payments & receipts', href: '/payments', icon: Receipt, requires: ['payment.view'] },
      { label: 'Accounts', href: '/accounts', icon: Wallet, requires: ['ledger.view'] },
      { label: 'Cash & bank', href: '/banking', icon: Landmark, requiresAny: ['deposit.record', 'ledger.view', 'cheque.manage'] },
      { label: 'Expenses', href: '/expenses', icon: FileText, requiresAny: ['expense.submit', 'expense.view'] },
      { label: 'Journal', href: '/journals', icon: ScrollText, requires: ['ledger.view'] },
      { label: 'Books', href: '/books', icon: BookOpen, requires: ['ledger.view'] },
      { label: 'Reports', href: '/reports', icon: BarChart3, phase: 7 },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Employees', href: '/admin/employees', icon: UserCog, requires: ['employee.view'] },
      { label: 'Branches', href: '/admin/branches', icon: Building2, requires: ['branch.manage'] },
      { label: 'Users & access', href: '/admin/users', icon: ShieldCheck, requires: ['user.manage'] },
      { label: 'Loan products', href: '/admin/products', icon: Package, requires: ['loan.view'] },
      { label: 'Communications', href: '/communications', icon: MessageSquare, requires: ['message.view'] },
      { label: 'Notifications', href: '/notifications', icon: Bell, phase: 7 },
      { label: 'Audit log', href: '/audit', icon: ScrollText, requires: ['audit.view'] },
      { label: 'Settings', href: '/admin/settings', icon: Settings, requires: ['settings.company'] },
    ],
  },
];
