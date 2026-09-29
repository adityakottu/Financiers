'use client';

import { Landmark, Plus, Scale } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { todayIST } from '@/components/lending';
import { useToast } from '@/components/toast';
import { Alert, Badge, Button, Card, cx, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th } from '@/components/ui';
import { api, ApiError, qs } from '@/lib/api';
import { date, inr } from '@/lib/format';
import { useApi, useSubmit } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isPostable: boolean;
  parentId: string | null;
  debit: string;
  credit: string;
  balance: string;
}
interface Ledger {
  account: { code: string; name: string; normalBalance: string };
  openingBalance: string;
  closingBalance: string;
  lines: { entry_no: string; value_date: string; entry_type: string; narration: string; debit: string; credit: string; memo: string | null; loan_id: string | null; loan_no: string | null; balance: string }[];
}

const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

export default function AccountsPage() {
  const { can } = useSession();
  const [asOf, setAsOf] = useState(todayIST());
  const [hideZero, setHideZero] = useState(true);
  const { data, loading, reload } = useApi<{ asOf: string; data: Account[]; totals: { debit: string; credit: string; balanced: boolean } }>(`/accounts${qs({ asOf })}`);
  const [ledgerFor, setLedgerFor] = useState<Account | null>(null);
  const [addBank, setAddBank] = useState(false);

  // Depth-first order so children sit under their parents.
  const rows = useMemo(() => {
    if (!data) return [];
    const kids = new Map<string | null, Account[]>();
    for (const a of data.data) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    const out: (Account & { depth: number })[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const a of (kids.get(parent) ?? []).sort((x, y) => (depth === 0 ? TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) : x.code.localeCompare(y.code)))) {
        out.push({ ...a, depth });
        walk(a.id, depth + 1);
      }
    };
    walk(null, 0);
    return out.filter((a) => !hideZero || !a.isPostable || Number(a.debit) || Number(a.credit));
  }, [data, hideZero]);

  if (!can('ledger.view')) return <EmptyState title="You don’t have access to the accounts" />;

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Chart of accounts with balances from the ledger. Every figure is the sum of posted journal lines."
        actions={
          <>
            <Input type="date" value={asOf} max={todayIST()} onChange={(e) => setAsOf(e.target.value)} className="w-40" aria-label="Balances as of" />
            {can('coa.manage') && (
              <Button onClick={() => setAddBank(true)}>
                <Plus className="size-4" /> Bank account
              </Button>
            )}
          </>
        }
      />
      {data && (
        <div className="mb-4">
          {data.totals.balanced ? (
            <Alert tone="ok">
              <span className="inline-flex items-center gap-1.5">
                <Scale className="size-4" /> Trial balance agrees as of {date(data.asOf)}: total debits {inr(data.totals.debit)} = total credits {inr(data.totals.credit)}.
              </span>
            </Alert>
          ) : (
            <Alert>Trial balance does not agree (debits {inr(data.totals.debit)}, credits {inr(data.totals.credit)}). Report this immediately.</Alert>
          )}
        </div>
      )}
      <Card>
        <div className="flex items-center justify-end border-b border-line px-4 py-2">
          <label className="inline-flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} className="accent-accent" /> Hide accounts with no postings
          </label>
        </div>
        {loading || !data ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th className="text-right">Debits</Th>
                <Th className="text-right">Credits</Th>
                <Th className="text-right">Balance</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={cx(a.isPostable ? 'cursor-pointer hover:bg-canvas/60' : 'bg-canvas/50')} onClick={() => a.isPostable && setLedgerFor(a)}>
                  <Td>
                    <span style={{ paddingLeft: a.depth * 18 }} className={cx('inline-flex items-center gap-2', !a.isPostable && 'font-semibold text-ink-950')}>
                      <span className="num font-mono text-[12px] text-subtle">{a.code}</span>
                      {a.name}
                    </span>
                  </Td>
                  <Td className="num text-right text-muted">{a.isPostable && Number(a.debit) ? inr(a.debit) : ''}</Td>
                  <Td className="num text-right text-muted">{a.isPostable && Number(a.credit) ? inr(a.credit) : ''}</Td>
                  <Td className={cx('num text-right', !a.isPostable ? 'font-semibold' : 'text-ink-950', Number(a.balance) < 0 && 'text-bad')}>{inr(a.balance)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-subtle">Expenses, cash book, bank book, P&amp;L and balance sheet views arrive in Phase 5; statement import and reconciliation in Phase 6.</p>
      {ledgerFor && <LedgerDialog account={ledgerFor} onClose={() => setLedgerFor(null)} />}
      {addBank && <BankDialog onClose={() => setAddBank(false)} onSaved={reload} />}
    </>
  );
}

function LedgerDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const today = todayIST();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const { data, loading } = useApi<Ledger>(`/accounts/${account.id}/ledger${qs({ from, to })}`);
  return (
    <Dialog open wide onClose={onClose} title={`${account.code} ${account.name}`} description="General ledger with running balance">
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {loading || !data ? (
        <Spinner />
      ) : (
        <div className="-mx-5">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Entry</Th>
                <Th>Description</Th>
                <Th className="text-right">Debit</Th>
                <Th className="text-right">Credit</Th>
                <Th className="text-right">Balance</Th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-canvas/50">
                <Td colSpan={5} className="text-[12px] font-medium text-muted">
                  Opening balance
                </Td>
                <Td className="num text-right font-medium">{inr(data.openingBalance)}</Td>
              </tr>
              {data.lines.map((l, i) => (
                <tr key={i}>
                  <Td className="num whitespace-nowrap">{date(l.value_date)}</Td>
                  <Td className="num font-mono text-[11px] text-muted">{l.entry_no}</Td>
                  <Td>
                    {l.memo ?? l.narration}
                    {l.loan_no && (
                      <Link href={`/loans/${l.loan_id}`} className="ml-2 font-mono text-[11px] text-ink-700 hover:underline">
                        {l.loan_no}
                      </Link>
                    )}
                  </Td>
                  <Td className="num text-right">{Number(l.debit) ? inr(l.debit) : ''}</Td>
                  <Td className="num text-right">{Number(l.credit) ? inr(l.credit) : ''}</Td>
                  <Td className="num text-right">{inr(l.balance)}</Td>
                </tr>
              ))}
              <tr className="bg-canvas/50">
                <Td colSpan={5} className="text-[12px] font-medium text-muted">
                  Closing balance
                </Td>
                <Td className="num text-right font-semibold">{inr(data.closingBalance)}</Td>
              </tr>
            </tbody>
          </Table>
          {data.lines.length === 0 && <p className="px-5 py-4 text-[13px] text-muted">No postings in this period.</p>}
        </div>
      )}
    </Dialog>
  );
}

function BankDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ name: '', bankName: '', branchName: '', accountNumber: '', ifsc: '', upiVpa: '', kind: 'CURRENT' });
  const [error, setError] = useState<ApiError | null>(null);
  const fe = error?.fieldErrors() ?? {};
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const [save, saving] = useSubmit(async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
      const r = await api<{ code: string }>('POST', '/accounts/bank', { body });
      toast('ok', `Account ${r.code} added`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e as ApiError);
    }
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add bank account"
      description="Used for disbursements now, and for collections and reconciliation later. The account number is stored encrypted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save()} loading={saving}>
            <Landmark className="size-4" /> Add account
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error && !error.details && <Alert>{error.message}</Alert>}
        <Field label="Display name" required error={fe.name} hint="e.g. SBI Current A/c — Kakinada">
          <Input value={v.name} onChange={set('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank" required error={fe.bankName}>
            <Input value={v.bankName} onChange={set('bankName')} />
          </Field>
          <Field label="Type">
            <Select value={v.kind} onChange={set('kind')}>
              <option value="CURRENT">Current</option>
              <option value="SAVINGS">Savings</option>
              <option value="UPI_SETTLEMENT">UPI settlement</option>
              <option value="WALLET">Wallet</option>
            </Select>
          </Field>
          <Field label="Account number" error={fe.accountNumber}>
            <Input value={v.accountNumber} onChange={set('accountNumber')} inputMode="numeric" className="num" />
          </Field>
          <Field label="IFSC" error={fe.ifsc}>
            <Input value={v.ifsc} onChange={(e) => setV({ ...v, ifsc: e.target.value.toUpperCase() })} className="uppercase" />
          </Field>
          <Field label="Bank branch" error={fe.branchName}>
            <Input value={v.branchName} onChange={set('branchName')} />
          </Field>
          <Field label="UPI ID" error={fe.upiVpa}>
            <Input value={v.upiVpa} onChange={set('upiVpa')} />
          </Field>
        </div>
        <Badge>Posts to 1210-xx under Bank</Badge>
      </div>
    </Dialog>
  );
}
