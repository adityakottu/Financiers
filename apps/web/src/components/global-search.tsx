'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { get, qs } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { cx } from './ui';
import { date, inr } from '@/lib/format';

interface CustomerResult {
  type: 'customer';
  id: string;
  customerNo: string;
  fullName: string;
  mobile: string;
  villageTown: string | null;
  branchCode: string;
  kycStatus: string;
  status: string;
  activeLoan: { id: string; loanNo: string; status: string; outstanding: string; nextDueDate: string | null; nextDueAmount: string | null; dpd: number } | null;
}
interface LoanResult {
  type: 'loan';
  id: string;
  loanNo: string;
  status: string;
  customerId: string;
  fullName: string;
  customerNo: string;
  branchCode: string;
  assetLabel: string | null;
  outstanding: string;
  nextDueDate: string | null;
  nextDueAmount: string | null;
  dpd: number;
}
type Result = CustomerResult | LoanResult;
const href = (r: Result) => (r.type === 'loan' ? `/loans/${r.id}` : `/customers/${r.id}`);

const MATCH_LABEL: Record<string, string> = {
  NAME: 'name',
  MOBILE: 'mobile number',
  PAN: 'PAN',
  CUSTOMER_NO: 'customer ID',
  ID_DOCUMENT: 'licence / voter ID',
  AADHAAR_LAST4_OR_MOBILE: 'Aadhaar last 4 / mobile',
  LOAN_NO: 'loan number',
  REGISTRATION: 'vehicle registration',
  VEHICLE_OR_SERIAL: 'chassis / engine / serial number',
};

/**
 * One box for everything: name, mobile, customer ID, PAN, Aadhaar last 4, DL, loan number,
 * vehicle registration, chassis, engine or serial number.
 */
export function GlobalSearch({ autoFocus, onNavigate }: { autoFocus?: boolean; onNavigate?: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [matchedBy, setMatchedBy] = useState('');
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const term = useDebounced(q.trim(), 200);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    get<{ data: Result[]; matchedBy: string }>(`/search${qs({ q: term, limit: 8 })}`, ctrl.signal)
      .then((r) => {
        setResults(r.data);
        setMatchedBy(r.matchedBy);
        setActive(0);
      })
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [term]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).matches('input, textarea, select')) {
        e.preventDefault();
        box.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  function go(r: Result) {
    setOpen(false);
    setQ('');
    onNavigate?.();
    router.push(href(r));
  }

  return (
    <div ref={box} className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
      <input
        type="search"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && results[active]) go(results[active]);
          else if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search name, mobile, ID, PAN, loan no., vehicle…"
        aria-label="Search"
        className="h-10 w-full rounded-md border border-line bg-canvas pl-9 pr-12 text-sm placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-surface px-1.5 text-[11px] text-subtle md:block">/</kbd>

      {open && term.length >= 2 && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
          {loading && results.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">No customers match “{term}”.</p>
          ) : (
            <>
              <p className="border-b border-line px-4 py-1.5 text-[11px] uppercase tracking-wide text-subtle">
                Matched by {MATCH_LABEL[matchedBy] ?? 'search'}
              </p>
              <ul role="listbox">
                {results.map((r, i) => (
                  <li key={r.id} role="option" aria-selected={i === active}>
                    <Link
                      href={href(r)}
                      onClick={(e) => {
                        e.preventDefault();
                        go(r);
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={cx('flex items-center justify-between gap-3 px-4 py-2.5', i === active && 'bg-canvas')}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink-950">
                          {r.type === 'loan' ? <span className="num font-mono">{r.loanNo}</span> : r.fullName}
                        </span>
                        <span className="num block truncate text-[12px] text-muted">
                          {r.type === 'loan'
                            ? `${r.fullName} · ${r.assetLabel ?? r.customerNo} · ${r.branchCode}`
                            : `${r.customerNo} · ${r.mobile} · ${r.villageTown ?? r.branchCode}`}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5">
                        {(() => {
                          const l = r.type === 'loan' ? r : r.activeLoan;
                          if (!l) return <span className="text-[11px] text-subtle">No loan</span>;
                          if (l.status !== 'ACTIVE') return <span className="text-[11px] text-subtle">{r.type === 'customer' ? `${r.activeLoan!.loanNo} · ` : ''}{l.status.replace(/_/g, ' ').toLowerCase()}</span>;
                          return (
                            <>
                              <span className="num text-[12px] font-medium text-ink-950">{inr(l.outstanding, { decimals: false })} due</span>
                              <span className="num text-[11px] text-subtle">
                                {l.dpd > 0 ? <span className="text-bad">{l.dpd} DPD</span> : l.nextDueDate ? `next ${date(l.nextDueDate)}` : ''}
                              </span>
                            </>
                          );
                        })()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
