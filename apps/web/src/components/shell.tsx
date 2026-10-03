'use client';

import { ChevronDown, HandCoins, LayoutDashboard, LogOut, Menu, MoreHorizontal, Search, User, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, restrictionRoute } from '@/lib/api';
import { ROLE_LABELS, useSession } from '@/lib/session';
import { GlobalSearch } from './global-search';
import { NAV, NavItem } from './nav';
import { cx, Spinner } from './ui';

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <span className="grid size-8 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">F</span>
      <span className="text-[15px] font-semibold tracking-tight text-white">Financiers</span>
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can, me } = useSession();
  return (
    <nav className="space-y-6" aria-label="Main">
      {NAV.map((group, gi) => {
        const items = group.items.filter((i) => (i.phase || !i.requires || can(...i.requires)) && (!i.requiresAny || i.requiresAny.some((p) => can(p))) && (!i.collectorOnly || !!me?.employee?.isCollector));
        if (!items.length) return null;
        return (
          <div key={gi}>
            {group.label && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-white/40">{group.label}</p>}
            <ul className="space-y-0.5">
              {items.map((item) => (
                <NavLinkItem key={item.href} item={item} active={isActive(pathname, item.href)} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NavLinkItem({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  if (item.phase) {
    return (
      <li>
        <span
          className="flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-[13px] text-white/35"
          title={`Arrives in Phase ${item.phase}`}
        >
          <Icon className="size-4" />
          <span className="flex-1">{item.label}</span>
          <span className="rounded bg-white/5 px-1.5 text-[10px] font-medium text-white/40">P{item.phase}</span>
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors',
          active ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
        )}
      >
        <Icon className={cx('size-4', active ? 'text-teal-300' : '')} />
        {item.label}
      </Link>
    </li>
  );
}

function UserMenu() {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!me) return null;
  const initials = me.fullName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  async function signOut() {
    await api('POST', '/auth/logout').catch(() => undefined);
    location.href = '/login';
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-canvas" aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-full bg-ink-900 text-[12px] font-semibold text-white">{initials}</span>
        <span className="hidden text-left lg:block">
          <span className="block text-[13px] font-medium leading-tight text-ink-950">{me.fullName}</span>
          <span className="block text-[11px] leading-tight text-muted">{me.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</span>
        </span>
        <ChevronDown className="hidden size-4 text-subtle lg:block" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl">
          <div className="border-b border-line px-4 py-2.5">
            <p className="text-[13px] font-medium text-ink-950">{me.fullName}</p>
            <p className="text-[12px] text-muted">@{me.username}</p>
            <p className="mt-1 text-[11px] text-subtle">{me.scope === 'ALL' ? 'All branches' : me.branches.map((b) => b.code).join(', ') || 'No branch'}</p>
          </div>
          <Link href="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-canvas">
            <User className="size-4 text-muted" /> Profile & security
          </Link>
          <button onClick={signOut} className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-bad hover:bg-canvas">
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else {
      const r = restrictionRoute(me.restriction);
      if (r) router.replace(r);
    }
  }, [me, loading, router, pathname]);

  if (loading || !me || me.restriction) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="min-h-screen md:pl-60">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-ink-950 md:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-3">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <NavLinks />
        </div>
        <div className="border-t border-white/10 px-5 py-3 text-[11px] text-white/35">Phase 6 · Reconciliation</div>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-ink-950/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-ink-950">
            <div className="flex h-14 items-center justify-between border-b border-white/10 px-3">
              <Brand />
              <button onClick={() => setDrawer(false)} className="rounded p-2 text-white/70" aria-label="Close menu">
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-5">
              <NavLinks onNavigate={() => setDrawer(false)} />
            </div>
          </aside>
        </div>
      )}

      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4 md:h-16 md:px-8">
          <button onClick={() => setDrawer(true)} className="-ml-1 rounded p-2 text-ink-800 md:hidden" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="text-[15px] font-semibold md:hidden">Financiers</span>
          <div className="hidden max-w-xl flex-1 md:block">
            <GlobalSearch />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setMobileSearch((s) => !s)} className="rounded p-2 text-ink-800 md:hidden" aria-label="Search">
              <Search className="size-5" />
            </button>
            <UserMenu />
          </div>
        </div>
        {mobileSearch && (
          <div className="border-t border-line px-4 py-2 md:hidden">
            <GlobalSearch autoFocus onNavigate={() => setMobileSearch(false)} />
          </div>
        )}
      </header>

      <main className="mx-auto min-w-0 max-w-[1400px] px-4 pb-24 pt-6 md:px-8 md:pb-10">{children}</main>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Quick">
        {[
          { href: '/', label: 'Home', icon: LayoutDashboard },
          me.employee?.isCollector && me.permissions.includes('payment.collect')
            ? { href: '/collect', label: 'Collect', icon: HandCoins }
            : { href: '/customers', label: 'Customers', icon: Users },
          { href: '#search', label: 'Search', icon: Search },
          { href: '#more', label: 'More', icon: MoreHorizontal },
        ].map((i) => {
          const Icon = i.icon;
          const active = i.href.startsWith('/') && isActive(pathname, i.href);
          const onClick = i.href === '#search' ? () => setMobileSearch(true) : i.href === '#more' ? () => setDrawer(true) : undefined;
          const cls = cx('flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium', active ? 'text-accent' : 'text-muted');
          return onClick ? (
            <button key={i.href} onClick={onClick} className={cls}>
              <Icon className="size-5" />
              {i.label}
            </button>
          ) : (
            <Link key={i.href} href={i.href} className={cls} aria-current={active ? 'page' : undefined}>
              <Icon className="size-5" />
              {i.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
