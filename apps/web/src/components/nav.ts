import type { Permission } from '@fin/contracts';
import {
  BarChart3,
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
      { label: 'Loans', href: '/loans', icon: Landmark, phase: 3 },
      { label: 'Collections', href: '/collections', icon: HandCoins, phase: 4 },
      { label: 'Installments', href: '/installments', icon: CalendarClock, phase: 3 },
      { label: 'Assets', href: '/assets', icon: Boxes, phase: 3 },
    ],
  },
  {
    label: 'Money',
    items: [
      { label: 'Reconciliation', href: '/reconciliation', icon: Scale, phase: 6 },
      { label: 'Accounts', href: '/accounts', icon: Wallet, phase: 5 },
      { label: 'Transactions', href: '/transactions', icon: Receipt, phase: 5 },
      { label: 'Expenses', href: '/expenses', icon: FileText, phase: 5 },
      { label: 'Reports', href: '/reports', icon: BarChart3, phase: 7 },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { label: 'Employees', href: '/admin/employees', icon: UserCog, requires: ['employee.view'] },
      { label: 'Branches', href: '/admin/branches', icon: Building2, requires: ['branch.manage'] },
      { label: 'Users & access', href: '/admin/users', icon: ShieldCheck, requires: ['user.manage'] },
      { label: 'Communications', href: '/communications', icon: MessageSquare, phase: 4 },
      { label: 'Notifications', href: '/notifications', icon: Bell, phase: 4 },
      { label: 'Audit log', href: '/audit', icon: ScrollText, requires: ['audit.view'] },
      { label: 'Settings', href: '/admin/settings', icon: Settings, requires: ['settings.company'] },
    ],
  },
];
